import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { normalizeCwd, readGitInfo } from './git';
import { log } from './log';
import type {
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

export class MuxentraPanel {
  static readonly viewType = 'muxentra';
  static readonly legacyViewType = 'orcaTerminals';
  private static current: MuxentraPanel | undefined;

  static createOrShow(ctx: vscode.ExtensionContext, ptys: PtyClient): void {
    if (MuxentraPanel.current) {
      MuxentraPanel.current.panel.reveal(undefined, false);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      MuxentraPanel.viewType,
      'Muxentra',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist')],
      },
    );
    MuxentraPanel.current = new MuxentraPanel(panel, ctx, ptys);
    // El panel acaba de tomar el foco, así que su grupo es el activo.
    MuxentraPanel.current.lockGroup();
  }

  static revive(panel: vscode.WebviewPanel, ctx: vscode.ExtensionContext, ptys: PtyClient): void {
    MuxentraPanel.current?.panel.dispose();
    MuxentraPanel.current = new MuxentraPanel(panel, ctx, ptys);
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
  private branchTimer: NodeJS.Timeout | undefined;
  /** Directorio actual y última rama enviada, por terminal. */
  private readonly cwds = new Map<string, string>();
  private readonly branches = new Map<string, string>();
  /** Terminales que terminaron o piden atención, en el orden en que avisaron. */
  private readonly activity = new Map<string, { state: PaneActivity; label: string }>();
  private readonly statusItem: vscode.StatusBarItem;
  private locked = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly ctx: vscode.ExtensionContext,
    private readonly ptys: PtyClient,
  ) {
    panel.title = 'Muxentra';
    panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'assets', 'muxentra-icon.png');
    this.statusItem = vscode.window.createStatusBarItem('muxentra.attention', vscode.StatusBarAlignment.Left, 90);
    this.statusItem.name = 'Muxentra';
    this.statusItem.command = 'muxentra.focusAttention';
    this.disposables.push(this.statusItem);
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist')],
    };
    panel.webview.html = this.html();

    panel.webview.onDidReceiveMessage((m: WebviewMessage) => void this.onMessage(m), undefined, this.disposables);
    panel.onDidChangeViewState(
      e => {
        if (e.webviewPanel.active) this.lockGroup();
        if (!e.webviewPanel.visible) return;
        this.post({ type: 'command', command: 'refit' });
        this.sendUsage();
        this.refreshBranches(true);
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
          this.post({ type: 'settings', settings: currentSettings() });
          this.ptys.configure(currentSettings().scrollback);
        }
        if (e.affectsConfiguration('muxentra.showUsage') || e.affectsConfiguration('muxentra.usageRefreshSeconds')) {
          this.restartUsageTimer();
        }
      },
      undefined,
      this.disposables,
    );

    ptys.attach({
      onData: (termId, data) => {
        if (this.receiving.has(termId)) this.enqueue(termId, data);
      },
      onGeometry: (termId, geometry) => this.post({ type: 'geometry', termId, geometry }),
      onExit: (termId, code) => {
        this.flush();
        this.clearActivity(termId);
        this.post({ type: 'exit', termId, code });
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
    this.sendBranch(termId, cwd, true);
  }

  private refreshBranches(force: boolean): void {
    if (!branchEnabled()) return;
    for (const [termId, cwd] of this.cwds) this.sendBranch(termId, cwd, force);
  }

  /** Envía la rama solo cuando cambia, salvo que se fuerce. */
  private sendBranch(termId: string, cwd: string, force: boolean): void {
    if (!branchEnabled()) return;
    let branch: string | null = null;
    let detached = false;
    try {
      const info = readGitInfo(cwd);
      if (info) {
        branch = info.branch;
        detached = info.detached;
      }
    } catch {
      branch = null;
    }
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
      this.post({ type: 'usage', usage: readUsage(undefined, this.claudeLive), showUsage: true });
      if (this.panel.visible) void this.refreshClaudeLive(manual);
    } catch (err) {
      log().warn(`no se pudo leer el uso: ${err instanceof Error ? err.message : String(err)}`);
      this.post({ type: 'usage', usage: null, showUsage: true });
    }
  }

  private async refreshClaudeLive(manual: boolean): Promise<void> {
    const now = Date.now();
    // Claude también consulta esta cuota. Evitar peticiones por cada salida de
    // terminal y dejar un intervalo menor solo para el botón de actualizar.
    const interval = manual ? 60_000 : 5 * 60_000;
    if (this.claudeLivePending || now - this.claudeLiveAttemptAt < interval) return;
    this.claudeLiveAttemptAt = now;
    this.claudeLivePending = true;
    try {
      const live = await fetchClaudeUsage();
      if (!live || MuxentraPanel.current !== this || !usageEnabled()) return;
      this.claudeLive = live;
      this.post({ type: 'usage', usage: readUsage(undefined, live), showUsage: true });
    } finally {
      this.claudeLivePending = false;
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
        });
        this.sendUsage();
        break;
      }
      case 'spawn':
        await this.spawn(m.termId, m.cols, m.rows);
        // Arranca en la carpeta del workspace; el shell avisará si cambia.
        this.setCwd(m.termId, workingDirectory());
        break;
      case 'attach':
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
        this.ptys.write(m.termId, m.data);
        if (/[\r\n]/.test(m.data)) this.refreshUsageSoon();
        break;
      case 'resize':
        this.ptys.resize(m.termId, m.cols, m.rows);
        break;
      case 'kill':
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
      case 'refreshUsage':
        this.sendUsage(true);
        break;
    }
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

  private post(message: HostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private dispose(): void {
    log().info(`panel cerrado; ${this.ptys.aliveIds().length} terminales siguen vivas`);
    MuxentraPanel.current = undefined;
    if (this.usageTimer) clearInterval(this.usageTimer);
    this.usageTimer = undefined;
    if (this.usageRefreshTimer) clearTimeout(this.usageRefreshTimer);
    this.usageRefreshTimer = undefined;
    if (this.branchTimer) clearInterval(this.branchTimer);
    this.branchTimer = undefined;
    this.ptys.detach();
    this.pending.clear();
    for (const d of this.disposables.splice(0)) d.dispose();
  }

  private html(): string {
    const webview = this.panel.webview;
    const dist = vscode.Uri.joinPath(this.ctx.extensionUri, 'dist');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css'));
    const nonce = createNonce();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${style}">
  <title>Muxentra</title>
</head>
<body>
  <div id="app">
    <div id="tabbar"></div>
    <div id="content"></div>
    <div id="usage-popover" role="region" aria-label="Detalle de consumo" hidden></div>
    <div id="usage" hidden></div>
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
  const fontFamily =
    cfg.get<string>('fontFamily') || term.get<string>('fontFamily') || editor.get<string>('fontFamily') || 'monospace';
  const fontSize =
    cfg.get<number>('fontSize') || term.get<number>('fontSize') || editor.get<number>('fontSize') || 14;
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
 * El nonce es lo que separa al script de la extensión de cualquier otro que
 * acabe en la página, así que tiene que ser impredecible: Math.random no sirve
 * para eso.
 */
function createNonce(): string {
  return crypto.randomBytes(24).toString('base64');
}
