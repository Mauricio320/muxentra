import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentHomes } from './agentHomes';
import { attachBytes, attachLimitBytes, attachPath } from './attachedFile';
import { currentAgentHomes } from './environment';
import { ClaudeProfileSwitch } from './claudeProfileSwitch';
import { normalizeCwd, readGitInfo } from './git';
import { GitExplorer } from './gitExplorer';
import { GitController } from './gitPanel';
import { bootScreen } from './brand';
import { confirmPaste } from './pasteGuard';
import { quotePath } from './projectFiles';
import { log } from './log';
import type {
  DropItem,
  HostMessage,
  MuxentraCommand,
  PaneActivity,
  TerminalFontWeight,
  TermSettings,
  UsageItem,
  WebviewMessage,
  WorkspaceLayout,
} from './protocol';
import { PtyClient, workingDirectory } from './ptyClient';
import { fetchClaudeUsage, readUsage } from './usage';

const LAYOUT_KEY = 'muxentra.layout';
const LAST_NOTIFY_MODE_KEY = 'muxentra.lastNotifyMode';

export class MuxentraPanel {
  static readonly viewType = 'muxentra';
  static readonly legacyViewType = 'orcaTerminals';
  private static current: MuxentraPanel | undefined;

  static createOrShow(ctx: vscode.ExtensionContext, ptys: PtyClient, git: GitExplorer, openGit = false,
    showOptions: vscode.ViewColumn | { viewColumn: vscode.ViewColumn; preserveFocus: boolean } = vscode.ViewColumn.Beside): void {
    if (MuxentraPanel.current) {
      MuxentraPanel.current.panel.reveal(undefined, false);
      if (openGit) MuxentraPanel.current.openGit();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      MuxentraPanel.viewType,
      'Muxentra',
      showOptions,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist'), vscode.Uri.joinPath(ctx.extensionUri, 'assets')],
      },
    );
    MuxentraPanel.current = new MuxentraPanel(panel, ctx, ptys, git, openGit);
    // El panel acaba de tomar el foco, así que su grupo es el activo.
    if (panel.active) MuxentraPanel.current.lockGroup();
  }

  static revive(panel: vscode.WebviewPanel, ctx: vscode.ExtensionContext, ptys: PtyClient, git: GitExplorer): void {
    MuxentraPanel.current?.panel.dispose();
    MuxentraPanel.current = new MuxentraPanel(panel, ctx, ptys, git);
    // VS Code conserva el grupo al restaurar, pero no siempre su bloqueo.
    // Si todavía no está activo, onDidChangeViewState lo bloqueará al enfocarlo.
    if (panel.active) MuxentraPanel.current.lockGroup();
  }

  /** Envía un comando al webview. Devuelve false si el panel no está abierto. */
  static send(command: MuxentraCommand, arg?: string): boolean {
    if (!MuxentraPanel.current) return false;
    MuxentraPanel.current.panel.reveal(undefined, false);
    MuxentraPanel.current.post({ type: 'command', command, arg });
    return true;
  }

  static isOpen(): boolean {
    return MuxentraPanel.current !== undefined;
  }

  static suspend(): void { MuxentraPanel.current?.profileSwitch.dispose(); }

  /** Cuántas terminales están esperando al usuario ahora mismo. */
  static pendingCount(): number {
    return MuxentraPanel.current?.waiting().length ?? 0;
  }

  /** Va a la primera terminal que terminó o pide atención. False si no hay ninguna. */
  static focusAttention(): boolean {
    const panel = MuxentraPanel.current;
    if (!panel || panel.waiting().length === 0) return false;
    panel.focusTerm();
    return true;
  }

  private readonly disposables: vscode.Disposable[] = [];
  private readonly pending = new Map<string, string[]>();
  private readonly receiving = new Set<string>();
  private readonly attachDims = new Map<string, { cols: number; rows: number }>();
  private flushScheduled = false;
  private usageTimer: NodeJS.Timeout | undefined;
  private usageRefreshTimer: NodeJS.Timeout | undefined;
  private claudeLive: UsageItem | undefined;
  private claudeLivePending = false;
  private claudeLiveAttemptAt = 0;
  private usageHomes: AgentHomes | undefined;
  private branchTimer: NodeJS.Timeout | undefined;
  /** Directorio actual y última rama enviada, por terminal. */
  private readonly cwds = new Map<string, string>();
  private readonly branches = new Map<string, string>();
  /** Terminales que terminaron o piden atención, en el orden en que avisaron. */
  private readonly activity = new Map<string, { state: PaneActivity; label: string }>();
  private readonly statusItem: vscode.StatusBarItem;
  private readonly gitController: GitController;
  private readonly profileSwitch: ClaudeProfileSwitch;
  private readonly terminalSizes = new Map<string, { cols: number; rows: number }>();
  private locked = false;
  private webviewReady = false;
  private pendingOpenGit: boolean;
  private gitActive = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly ctx: vscode.ExtensionContext,
    private readonly ptys: PtyClient,
    git: GitExplorer,
    openGit = false,
  ) {
    this.pendingOpenGit = openGit;
    this.profileSwitch = new ClaudeProfileSwitch(ptys,
      id => this.terminalSizes.get(id) ?? { cols: 80, rows: 24 },
      (termId, status) => this.post({ type: 'profileSwitch', termId, status }));
    panel.title = 'Muxentra';
    panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'assets', 'muxentra-icon.png');
    this.statusItem = vscode.window.createStatusBarItem('muxentra.attention', vscode.StatusBarAlignment.Left, 90);
    this.statusItem.name = 'Muxentra';
    this.statusItem.command = 'muxentra.focusAttention';
    this.disposables.push(this.statusItem);
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist'), vscode.Uri.joinPath(ctx.extensionUri, 'assets')],
    };
    panel.webview.html = this.html();
    this.gitController = new GitController(ctx, git, message => this.post({ type: 'git', message }), () => panel.visible && this.gitActive);

    panel.webview.onDidReceiveMessage((m: WebviewMessage) => void this.onMessage(m), undefined, this.disposables);
    panel.onDidChangeViewState(
      e => {
        if (e.webviewPanel.active) this.lockGroup();
        if (!e.webviewPanel.visible) return;
        this.post({ type: 'command', command: 'refit' });
        this.sendUsage();
        this.refreshBranches(true);
        if (this.gitActive) void this.gitController.refresh();
      },
      undefined,
      this.disposables,
    );
    panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    vscode.workspace.onDidChangeConfiguration(
      e => {
        if (
          e.affectsConfiguration('muxentra') ||
          e.affectsConfiguration('terminal.integrated') ||
          e.affectsConfiguration('editor.fontFamily') ||
          e.affectsConfiguration('editor.fontSize')
        ) {
          const settings = currentSettings();
          this.post({ type: 'settings', settings });
          if (e.affectsConfiguration('muxentra.scrollback')) this.ptys.configure(settings.scrollback);
        }
        if (e.affectsConfiguration('muxentra.showUsage') || e.affectsConfiguration('muxentra.usageRefreshSeconds') ||
          e.affectsConfiguration('claudeCode.environmentVariables') || e.affectsConfiguration('terminal.integrated.env') ||
          e.affectsConfiguration('terminal.integrated.profiles') || e.affectsConfiguration('terminal.integrated.defaultProfile') ||
          e.affectsConfiguration('muxentra.shellPath')) {
          this.restartUsageTimer();
          this.profileSwitch.changed();
        }
      },
      undefined,
      this.disposables,
    );

    ptys.attach({
      onLaunch: id => this.profileSwitch.track(id),
      onData: (termId, data) => {
        if (this.receiving.has(termId)) this.enqueue(termId, data);
      },
      onGeometry: (termId, geometry) => {
        this.terminalSizes.set(termId, geometry);
        this.post({ type: 'geometry', termId, geometry });
      },
      onExit: (termId, code) => {
        this.profileSwitch.forget(termId);
        this.flush();
        this.clearActivity(termId);
        this.post({ type: 'exit', termId, code });
      },
      onRevived: (termId, snapshot, resume) => {
        // El historial del disco va delante de lo que diga el shell nuevo.
        this.pending.delete(termId);
        this.post({ type: 'restore', termId, snapshot, resume });
        this.receiving.add(termId);
      },
      onAttached: (termId, found, data, snapshot) => {
        const dims = this.attachDims.get(termId) ?? { cols: 80, rows: 24 };
        this.attachDims.delete(termId);
        if (!found) {
          void this.spawn(termId, dims.cols, dims.rows);
          return;
        }
        this.pending.delete(termId);
        this.post({ type: 'restore', termId, snapshot: snapshot ?? { ...dims, data: data ?? '' } });
        this.receiving.add(termId);
      },
      onSpawnError: (termId, message) => {
        this.post({ type: 'spawnError', termId, message });
        void vscode.window.showErrorMessage(`Muxentra: ${message}`);
      },
      onLost: () => {
        this.pending.clear();
        this.receiving.clear();
        this.post({ type: 'serverLost' });
      },
    });

    this.restartUsageTimer();
    this.branchTimer = setInterval(() => {
      if (this.panel.visible) this.refreshBranches(false);
    }, 5000);
  }

  // ------------------------------------------------------------------ bloqueo del grupo

  /**
   * Bloquea el grupo de editores donde vive el panel para que no se abran
   * archivos encima de las terminales. Solo una vez por panel: si el usuario
   * lo desbloquea a mano, se respeta.
   */
  private lockGroup(): void {
    if (this.locked) return;
    this.locked = true;
    if (!(vscode.workspace.getConfiguration('muxentra').get<boolean>('lockEditorGroup') ?? true)) return;
    void vscode.commands.executeCommand('workbench.action.lockEditorGroup').then(undefined, (err: unknown) => {
      log().warn(`no se pudo bloquear el grupo: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // ------------------------------------------------------------------ rama de git

  private setCwd(termId: string, raw: string): void {
    const cwd = normalizeCwd(raw);
    if (!cwd || this.cwds.get(termId) === cwd) return;
    this.cwds.set(termId, cwd);
    if (branchEnabled()) this.sendBranch(termId, cwd, true, readGitInfo(cwd));
  }

  private refreshBranches(force: boolean): void {
    if (!branchEnabled()) return;
    const readings = new Map<string, ReturnType<typeof readGitInfo>>();
    for (const [termId, cwd] of this.cwds) {
      if (!readings.has(cwd)) readings.set(cwd, readGitInfo(cwd));
      this.sendBranch(termId, cwd, force, readings.get(cwd));
    }
  }

  /** Envía la rama solo cuando cambia, salvo que se fuerce. */
  private sendBranch(termId: string, cwd: string, force: boolean, info: ReturnType<typeof readGitInfo>): void {
    if (!branchEnabled()) return;
    const branch = info?.branch ?? null;
    const detached = info?.detached ?? false;
    const key = `${branch ?? ''}|${detached}|${cwd}`;
    if (!force && this.branches.get(termId) === key) return;
    this.branches.set(termId, key);
    this.post({ type: 'branch', termId, branch, detached, cwd });
  }

  // ------------------------------------------------------------------ estado de las terminales

  /** Terminales que terminaron o piden atención, en orden de aviso. */
  private waiting(): { termId: string; state: PaneActivity; label: string }[] {
    const out: { termId: string; state: PaneActivity; label: string }[] = [];
    for (const [termId, entry] of this.activity) {
      if (entry.state === 'done' || entry.state === 'attention') out.push({ termId, ...entry });
    }
    return out;
  }

  /**
   * `silent` viene marcado cuando el usuario estaba mirando esa terminal: el
   * estado se pinta igual en el panel, pero ni cuenta como espera ni avisa.
   */
  private setActivity(termId: string, state: PaneActivity, rawLabel: string, message?: string, silent = false): void {
    const label = this.shortLabel(termId, rawLabel);
    const previous = this.activity.get(termId)?.state ?? 'idle';
    const waits = (state === 'done' || state === 'attention') && !silent;
    if (waits) this.activity.set(termId, { state, label });
    else this.activity.delete(termId);
    log().debug(`estado ${label}: ${state}${silent ? ' (mirándola)' : ''}`);
    this.refreshAttention();
    if (waits && previous !== state) this.notify(termId, state, label, message);
  }

  /**
   * Nombre corto para el aviso y la barra de estado. El título que reporta el
   * shell suele ser una ruta entera ("MINGW64:/c/Users/..."), así que en ese
   * caso se usa la carpeta de la terminal.
   */
  private shortLabel(termId: string, label: string): string {
    const clean = label.trim();
    if (clean && clean.length <= 28 && !clean.includes('/') && !clean.includes('\\')) return clean;
    const cwd = this.cwds.get(termId);
    const folder = cwd ? path.basename(cwd) : '';
    if (folder) return folder;
    if (!clean) return 'Terminal';
    return clean.length > 28 ? `…${clean.slice(-27)}` : clean;
  }

  private clearActivity(termId: string): void {
    if (!this.activity.delete(termId)) return;
    this.refreshAttention();
  }

  /** Refleja en el título del panel y en la barra de estado cuántas terminales esperan. */
  private refreshAttention(): void {
    const waiting = this.waiting();
    this.panel.title = waiting.length ? `Muxentra (${waiting.length})` : 'Muxentra';
    if (waiting.length === 0) {
      this.statusItem.hide();
      return;
    }
    const attention = waiting.filter(w => w.state === 'attention').length;
    this.statusItem.text =
      waiting.length === 1
        ? `$(bell) ${waiting[0].label}`
        : `$(bell) ${waiting.length} terminales`;
    this.statusItem.tooltip = waiting
      .map(w => `${w.label}: ${w.state === 'attention' ? 'pide atención' : 'terminó'}`)
      .join('\n');
    this.statusItem.backgroundColor = attention
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
    this.statusItem.show();
  }

  /** Aviso de VS Code, si la configuración lo pide. */
  private notify(termId: string, state: PaneActivity, label: string, message?: string): void {
    const mode = vscode.workspace.getConfiguration('muxentra').get<string>('notifyOn') ?? 'all';
    if (mode === 'none') return;
    if (mode === 'attention' && state !== 'attention') return;
    const what = state === 'attention' ? (message || 'necesita tu atención') : 'terminó';
    const go = 'Ir a la terminal';
    void vscode.window.showInformationMessage(`Muxentra · ${label}: ${what}`, go).then(answer => {
      if (answer === go) this.focusTerm(termId);
    });
  }

  /** Revela el panel y pone el foco en una terminal (la primera que espera, si no se indica). */
  focusTerm(termId?: string): void {
    const target = termId ?? this.waiting()[0]?.termId;
    if (!target) return;
    this.panel.reveal(undefined, false);
    this.post({ type: 'command', command: 'focusTerm', arg: target });
  }

  // ------------------------------------------------------------------ uso de agentes

  private restartUsageTimer(): void {
    if (this.usageTimer) {
      clearInterval(this.usageTimer);
      this.usageTimer = undefined;
    }
    this.sendUsage();
    if (!usageEnabled()) return;
    const seconds = Math.max(15, vscode.workspace.getConfiguration('muxentra').get<number>('usageRefreshSeconds') ?? 60);
    this.usageTimer = setInterval(() => {
      // Leer del disco solo sirve si el panel está a la vista.
      if (this.panel.visible) this.sendUsage();
    }, seconds * 1000);
  }

  private sendUsage(manual = false): void {
    const showUsage = usageEnabled();
    if (!showUsage) {
      this.post({ type: 'usage', usage: null, showUsage: false });
      return;
    }
    try {
      const resolved = currentAgentHomes();
      if (resolved.claude !== this.usageHomes?.claude || resolved.codex !== this.usageHomes?.codex ||
        resolved.claudeConfigFile !== this.usageHomes?.claudeConfigFile) {
        this.usageHomes = resolved;
        this.claudeLive = undefined;
        this.claudeLivePending = false;
        this.claudeLiveAttemptAt = 0;
      }
      const homes = this.usageHomes!;
      this.post({ type: 'usage', usage: readUsage(homes, this.claudeLive), showUsage: true });
      if (this.panel.visible) void this.refreshClaudeLive(manual, homes);
    } catch (err) {
      log().warn(`no se pudo leer el uso: ${err instanceof Error ? err.message : String(err)}`);
      this.post({ type: 'usage', usage: null, showUsage: true });
    }
  }

  private async refreshClaudeLive(manual: boolean, homes: AgentHomes): Promise<void> {
    const now = Date.now();
    // Claude también consulta esta cuota. Evitar peticiones por cada salida de
    // terminal y dejar un intervalo menor solo para el botón de actualizar.
    const interval = manual ? 60_000 : 5 * 60_000;
    if (this.claudeLivePending || now - this.claudeLiveAttemptAt < interval) return;
    this.claudeLiveAttemptAt = now;
    this.claudeLivePending = true;
    try {
      const live = await fetchClaudeUsage(homes.claude);
      if (!live || MuxentraPanel.current !== this || !usageEnabled() || this.usageHomes !== homes) return;
      this.claudeLive = live;
      this.post({ type: 'usage', usage: readUsage(homes, live), showUsage: true });
    } finally {
      if (this.usageHomes === homes) this.claudeLivePending = false;
    }
  }

  private refreshUsageSoon(): void {
    if (this.usageRefreshTimer || !usageEnabled() || !this.panel.visible) return;
    this.usageRefreshTimer = setTimeout(() => {
      this.usageRefreshTimer = undefined;
      if (this.panel.visible) this.sendUsage();
    }, 1500);
  }

  private async onMessage(m: WebviewMessage): Promise<void> {
    switch (m.type) {
      case 'git':
        await this.gitController.onMessage(m.message);
        break;
      case 'gitVisibility':
        this.gitActive = m.visible;
        break;
      case 'ready': {
        const layout = this.ctx.workspaceState.get<WorkspaceLayout>(LAYOUT_KEY) ?? null;
        try {
          await this.ptys.ready();
          if (!this.ptys.supportsStateReplay()) {
            void vscode.window.showWarningMessage(
              'Muxentra está conectado a un servidor anterior. La corrección del historial se aplicará al cerrar tus terminales y reiniciar el servidor; las sesiones actuales se conservan.',
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log().error(message);
          void vscode.window.showErrorMessage(`Muxentra: ${message}`);
        }
        const alive = this.ptys.aliveIds();
        log().info(`webview listo: ${layout?.tabs.length ?? 0} pestañas guardadas, ${alive.length} terminales vivas`);
        this.post({
          type: 'init',
          layout,
          settings: currentSettings(),
          alive,
          exited: this.ptys.takeExited(),
          showUsage: usageEnabled(),
          // El panel abre en la última pestaña de terminales; Git solo si el usuario lo pide.
          showGit: vscode.workspace.getConfiguration('muxentra').get<boolean>('openGitOnOpen', false) || this.pendingOpenGit,
        });
        this.webviewReady = true;
        if (this.pendingOpenGit) {
          this.post({ type: 'command', command: 'openGit' });
          this.pendingOpenGit = false;
        }
        this.sendUsage();
        break;
      }
      case 'spawn':
        this.terminalSizes.set(m.termId, { cols: m.cols, rows: m.rows });
        await this.spawn(m.termId, m.cols, m.rows);
        // Arranca en la carpeta del workspace; el shell avisará si cambia.
        this.setCwd(m.termId, workingDirectory());
        break;
      case 'attach':
        this.terminalSizes.set(m.termId, { cols: m.cols, rows: m.rows });
        this.receiving.delete(m.termId);
        this.pending.delete(m.termId);
        if (!this.cwds.has(m.termId)) this.setCwd(m.termId, workingDirectory());
        this.attachDims.set(m.termId, { cols: m.cols, rows: m.rows });
        try {
          await this.ptys.attachTerminal(m.termId, m.cols, m.rows);
        } catch (err) {
          this.attachDims.delete(m.termId);
          this.reportError(m.termId, err);
        }
        break;
      case 'input':
        if (!this.profileSwitch.acceptsInput(m.termId)) break;
        this.ptys.write(m.termId, m.data);
        if (/[\r\n]/.test(m.data)) this.refreshUsageSoon();
        break;
      case 'resize':
        this.terminalSizes.set(m.termId, { cols: m.cols, rows: m.rows });
        this.ptys.resize(m.termId, m.cols, m.rows);
        break;
      case 'kill':
        this.profileSwitch.forget(m.termId);
        this.terminalSizes.delete(m.termId);
        this.receiving.delete(m.termId);
        this.ptys.kill(m.termId);
        this.cwds.delete(m.termId);
        this.branches.delete(m.termId);
        this.clearActivity(m.termId);
        break;
      case 'cwd':
        this.setCwd(m.termId, m.cwd);
        break;
      case 'activity':
        this.setActivity(m.termId, m.state, m.label, m.message, m.silent);
        if (m.state === 'done') this.refreshUsageSoon();
        break;
      case 'layout':
        void this.ctx.workspaceState.update(LAYOUT_KEY, m.layout);
        break;
      case 'copy':
        void vscode.env.clipboard.writeText(m.text);
        break;
      case 'openLink':
        openExternalLink(m.url);
        break;
      case 'drop':
        await this.onDrop(m.termId, m.items);
        break;
      case 'dropText':
        if (await confirmPaste(m.text)) this.post({ type: 'insert', termId: m.termId, text: m.text });
        break;
      case 'refreshUsage':
        this.sendUsage(true);
        break;
      case 'setNotifications':
        await this.setNotifications(m.enabled);
        break;
    }
  }

  /** Guarda la preferencia desde el panel y conserva el modo detallado previo. */
  private async setNotifications(enabled: boolean): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('muxentra');
    const current = cfg.get<string>('notifyOn') ?? 'all';
    const target = cfg.inspect<string>('notifyOn')?.workspaceValue === undefined
      ? vscode.ConfigurationTarget.Global
      : vscode.ConfigurationTarget.Workspace;
    if (enabled) {
      const saved = this.ctx.globalState.get<string>(LAST_NOTIFY_MODE_KEY);
      const mode = saved === 'attention' || saved === 'all' ? saved : 'all';
      await cfg.update('notifyOn', mode, target);
      return;
    }
    if (current === 'attention' || current === 'all') {
      await this.ctx.globalState.update(LAST_NOTIFY_MODE_KEY, current);
    }
    await cfg.update('notifyOn', 'none', target);
  }

  private async spawn(termId: string, cols: number, rows: number): Promise<void> {
    this.receiving.add(termId);
    try {
      await this.ptys.spawn(termId, cols, rows);
    } catch (err) {
      this.reportError(termId, err);
    }
  }

  private reportError(termId: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    log().error(`terminal ${termId}: ${message}`);
    this.post({ type: 'spawnError', termId, message });
    void vscode.window.showErrorMessage(`Muxentra: ${message}`);
  }

  private enqueue(termId: string, data: string): void {
    let chunks = this.pending.get(termId);
    if (!chunks) {
      chunks = [];
      this.pending.set(termId, chunks);
    }
    chunks.push(data);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      setImmediate(() => this.flush());
    }
  }

  private flush(): void {
    this.flushScheduled = false;
    for (const [termId, chunks] of this.pending) {
      this.post({ type: 'data', termId, data: chunks.join('') });
    }
    this.pending.clear();
  }

  /**
   * Resuelve lo que se soltó sobre una terminal a rutas del proyecto y las
   * escribe en su prompt. Lo que falle se cuenta junto al final, para no
   * encadenar avisos cuando se sueltan varios archivos a la vez.
   */
  private async onDrop(termId: string, items: DropItem[]): Promise<void> {
    const paths: string[] = [];
    const problems: string[] = [];
    const limitMb = Math.round(attachLimitBytes() / (1024 * 1024));

    for (const item of items) {
      try {
        if (item.kind === 'uri') {
          const uri = vscode.Uri.parse(item.uri);
          if (uri.scheme !== 'file') {
            problems.push(`${item.uri} no es un archivo del disco`);
            continue;
          }
          paths.push(attachPath(uri.fsPath).relative);
        } else if (item.kind === 'file') {
          paths.push(attachBytes(item.name, Buffer.from(item.base64, 'base64')).relative);
        } else if (item.kind === 'tooBig') {
          problems.push(`${item.name} pesa más de ${limitMb} MB`);
        } else {
          problems.push(`no se pudo leer ${item.name}`);
        }
      } catch (err) {
        problems.push(err instanceof Error ? err.message : String(err));
      }
    }

    if (paths.length) {
      log().info(`soltados en la terminal: ${paths.join(', ')}`);
      this.post({ type: 'insert', termId, text: `${paths.map(quotePath).join(' ')} ` });
    }
    if (problems.length) void vscode.window.showWarningMessage(`Muxentra: ${problems.join('; ')}`);
  }

  private post(message: HostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private openGit(): void {
    if (this.webviewReady) this.post({ type: 'command', command: 'openGit' });
    else this.pendingOpenGit = true;
  }

  private dispose(): void {
    this.profileSwitch.dispose();
    log().info(`panel cerrado; ${this.ptys.aliveIds().length} terminales siguen vivas`);
    MuxentraPanel.current = undefined;
    if (this.usageTimer) clearInterval(this.usageTimer);
    this.usageTimer = undefined;
    if (this.usageRefreshTimer) clearTimeout(this.usageRefreshTimer);
    this.usageRefreshTimer = undefined;
    if (this.branchTimer) clearInterval(this.branchTimer);
    this.branchTimer = undefined;
    this.ptys.detach();
    this.gitController.dispose();
    this.pending.clear();
    for (const d of this.disposables.splice(0)) d.dispose();
  }

  private html(): string {
    const webview = this.panel.webview;
    const dist = vscode.Uri.joinPath(this.ctx.extensionUri, 'dist');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css'));
    const gitStyle = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'gitView.css'));
    // Fira Code y JetBrains Mono (licencia OFL, en assets/fonts) van dentro de
    // la extensión: se ven bien aunque el usuario no tenga ninguna instalada.
    const fonts = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'assets', 'fonts'));
    const bundledFonts = [
      ['Fira Code', 400, 'FiraCode-Regular.woff2'], ['Fira Code', 700, 'FiraCode-Bold.woff2'],
      ['JetBrains Mono', 400, 'JetBrainsMono-Regular.woff2'], ['JetBrains Mono', 700, 'JetBrainsMono-Bold.woff2'],
    ].map(([family, weight, file]) =>
      `@font-face { font-family: '${family}'; font-weight: ${weight}; font-display: swap; src: url('${fonts}/${file}') format('woff2'); }`,
    ).join('\n');
    const nonce = createNonce();
    // Sin saludo de apertura no hay capa que quitar ni nada que bloquear.
    const opening = vscode.workspace.getConfiguration('muxentra').get<boolean>('openingAnimation') ?? true;
    const gate = opening ? ' inert' : '';
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data: https://www.gravatar.com https://gravatar.com https://secure.gravatar.com https://github.com https://avatars.githubusercontent.com https://gitlab.com`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${style}">
  <style>${bundledFonts}</style>
  <title>Muxentra</title>
</head>
<body>
  <div id="app"${opening ? ' aria-busy="true"' : ''}>
    <div id="tabbar"${gate}></div>
    <div id="content"${gate}></div>
    <div id="git-view" data-style-uri="${gitStyle}" hidden${gate}></div>
    <div id="usage-popover" role="region" aria-label="Detalle de consumo" hidden></div>
    <div id="bottom-bar" hidden${gate}>
      <div id="usage" hidden></div>
    </div>
    ${opening ? bootScreen() : ''}
  </div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

export function currentSettings(): TermSettings {
  const cfg = vscode.workspace.getConfiguration('muxentra');
  const term = vscode.workspace.getConfiguration('terminal.integrated');
  const editor = vscode.workspace.getConfiguration('editor');
  const customFontFamily = (cfg.get<string>('fontFamily') ?? '').trim();
  const inheritedFontFamily = term.get<string>('fontFamily') || editor.get<string>('fontFamily') || 'monospace';
  const fontFamily = customFontFamily || inheritedFontFamily;
  const customFontSize = cfg.get<number>('fontSize') || 0;
  const inheritedFontSize = term.get<number>('fontSize') || editor.get<number>('fontSize') || 14;
  const fontSize = customFontSize || inheritedFontSize;
  const blink = term.get<string | boolean>('cursorBlinking');
  const windowsBuildNumber = process.platform === 'win32' ? Number.parseInt(os.release().split('.')[2] ?? '0', 10) || 0 : 0;
  return {
    fontFamily,
    fontSize,
    letterSpacing: term.get<number>('letterSpacing') ?? 0,
    lineHeight: Math.max(1, term.get<number>('lineHeight') ?? 1),
    fontWeight: terminalFontWeight(term.get<string>('fontWeight'), 'normal'),
    fontWeightBold: terminalFontWeight(term.get<string>('fontWeightBold'), 'bold'),
    scrollback: cfg.get<number>('scrollback') ?? 20000,
    rebuildAwareScrollback: cfg.get<boolean>('rebuildAwareScrollback') ?? true,
    cursorBlink: blink === undefined ? true : blink === true || blink === 'true',
    platform: process.platform,
    windowsBuildNumber,
    agentStatus: cfg.get<boolean>('agentStatus') ?? true,
    quietSeconds: Math.min(60, Math.max(1, cfg.get<number>('quietSeconds') ?? 3)),
    attentionSound: cfg.get<boolean>('attentionSound') ?? false,
    notificationsEnabled: (cfg.get<string>('notifyOn') ?? 'all') !== 'none',
    openingAnimation: cfg.get<boolean>('openingAnimation') ?? true,
    filePasteMaxBytes: attachLimitBytes(),
  };
}

function terminalFontWeight(value: string | undefined, fallback: TerminalFontWeight): TerminalFontWeight {
  const valid: TerminalFontWeight[] = [
    'normal', 'bold', '100', '200', '300', '400', '500', '600', '700', '800', '900',
  ];
  return valid.includes(value as TerminalFontWeight) ? (value as TerminalFontWeight) : fallback;
}

function usageEnabled(): boolean {
  return vscode.workspace.getConfiguration('muxentra').get<boolean>('showUsage') ?? true;
}

function branchEnabled(): boolean {
  return vscode.workspace.getConfiguration('muxentra').get<boolean>('showBranch') ?? true;
}

/**
 * El texto del enlace lo escribió el programa que corre en la terminal, así que
 * se valida aquí otra vez: solo http y https llegan al navegador. Esquemas como
 * file:, vscode: o command: abrirían cosas del equipo sin pedir permiso.
 */
function openExternalLink(raw: string): void {
  let url: vscode.Uri;
  try {
    url = vscode.Uri.parse(raw, true);
  } catch {
    return;
  }
  if (url.scheme !== 'http' && url.scheme !== 'https') return;
  if (!url.authority) return;
  void vscode.env.openExternal(url);
}

/**
 * El nonce es lo que separa al script de la extensión de cualquier otro que
 * acabe en la página, así que tiene que ser impredecible: Math.random no sirve
 * para eso.
 */
function createNonce(): string {
  return crypto.randomBytes(24).toString('base64');
}
