import * as path from 'path';
import { agentHomes } from './agentHomes';
import { buildTerminalEnv } from './environment';
import { resolveShell } from './shell';
import { accountReady, findClaudeSession, processTree, type ClaudeSession } from './claudeSession';
import { workingDirectory, type PtyClient } from './ptyClient';
import type { ProfileSwitchStatus } from './protocol';

const samePath = (a = '', b = ''): boolean => process.platform === 'win32'
  ? path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase() : path.normalize(a) === path.normalize(b);

/** One controller per panel; only terminals actually attached to that panel are eligible. */
export class ClaudeProfileSwitch {
  private readonly owned = new Set<string>();
  private readonly blocked = new Map<string, string>();
  private readonly statuses = new Map<string, ProfileSwitchStatus>();
  private readonly locked = new Set<string>();
  private timer?: NodeJS.Timeout;
  private running = false;
  private disposed = false;
  private revision = 0;

  constructor(
    private readonly ptys: PtyClient,
    private readonly dimensions: (id: string) => { cols: number; rows: number },
    private readonly notify: (id: string, status: ProfileSwitchStatus) => void,
  ) {}

  track(id: string): void { this.owned.add(id); this.schedule(500); }
  forget(id: string): void { this.owned.delete(id); this.locked.delete(id); this.blocked.delete(id); this.statuses.delete(id); }
  acceptsInput(id: string): boolean { return !this.locked.has(id); }
  changed(): void { this.revision++; this.blocked.clear(); this.schedule(500); }
  dispose(): void {
    this.disposed = true;
    this.revision++;
    if (this.timer) clearTimeout(this.timer);
  }

  private status(id: string, state: ProfileSwitchStatus['state'], message: string): void {
    if (this.disposed || !this.owned.has(id)) return;
    const previous = this.statuses.get(id);
    const blockInput = state === 'switching' && this.locked.has(id);
    if (previous?.state === state && previous.message === message && previous.blockInput === blockInput) return;
    const status = { state, message, blockInput };
    this.statuses.set(id, status);
    this.notify(id, status);
  }

  private schedule(ms: number): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.check(); }, ms);
  }

  private target(cwd = workingDirectory()): { env: Record<string, string>; key: string; home: string; config?: string } {
    const env = buildTerminalEnv(resolveShell().env, cwd);
    const homes = agentHomes(env, cwd);
    return { env, key: `${homes.claude}|${homes.claudeConfigFile}`, home: homes.claude, config: homes.claudeConfigFile };
  }

  private current(id: string, revision: number): boolean {
    return !this.disposed && this.owned.has(id) && this.revision === revision;
  }

  private async check(): Promise<void> {
    if (this.running || this.disposed) { if (!this.disposed) this.schedule(2000); return; }
    this.running = true;
    const revision = this.revision;
    let retry = false;
    try {
      if (!this.ptys.supportsProfileSwitch()) {
        for (const id of this.owned) this.status(id, 'error', 'Cambio automático disponible al reiniciar el servidor anterior. Las sesiones actuales se conservan.');
        return;
      }
      const target = this.target();
      const ids = [...this.owned].filter(id => {
        const launch = this.ptys.launchInfo(id);
        if (!launch) {
          this.status(id, 'error', 'Terminal anterior a esta actualización: abre una nueva para habilitar el cambio automático.');
          return false;
        }
        const matches = samePath(launch.claudeHome, target.home) && samePath(launch.claudeConfigFile, target.config);
        if (matches) this.status(id, 'ready', '');
        return !matches && this.blocked.get(id) !== target.key;
      });
      if (!ids.length) return;
      const processes = await processTree();
      for (const id of ids) {
        if (!this.current(id, revision)) break;
        const launch = this.ptys.launchInfo(id);
        if (!launch) continue;
        const session = findClaudeSession(launch, processes);
        if (!session) {
          this.status(id, 'error', 'No se identificó una conversación de Claude para cambiar de cuenta. La terminal se conserva.');
          // A normal shell can launch Claude later. Only mismatched panes are polled.
          retry = true;
          continue;
        }
        if (!session.idle) {
          this.status(id, 'waiting', 'Cambio de cuenta pendiente: esperando a que Claude termine.');
          retry = true;
          continue;
        }
        const next = this.target(session.cwd);
        try {
          if (!await accountReady(session, next.env)) throw new Error('Inicia sesión en Claude con el perfil nuevo antes de cambiar esta conversación.');
          if (!this.current(id, revision) || next.key !== this.target(session.cwd).key) { retry = true; continue; }
          this.locked.add(id);
          this.status(id, 'switching', 'Cambiando cuenta y reanudando conversación…');
          // Stop new input, then recheck the exact process/session and idle state.
          await new Promise(resolve => setTimeout(resolve, 250));
          const confirmed = findClaudeSession(launch, await processTree());
          if (!this.current(id, revision) || !confirmed?.idle || confirmed.pid !== session.pid || confirmed.sessionId !== session.sessionId) {
            retry = true;
            this.status(id, 'waiting', 'Cambio de cuenta pendiente: esperando a que Claude termine.');
            continue;
          }
          const dims = this.dimensions(id);
          await this.ptys.restartClaude(id, session, next.env, dims.cols, dims.rows,
            () => this.current(id, revision) && this.target(session.cwd).key === next.key);
          // The new TUI needs terminal responses (cursor queries, etc.) during startup.
          this.locked.delete(id);
          this.status(id, 'switching', 'Reanudando conversación con la cuenta del perfil…');
          // Confirm the resumed process registered the same session in the target home.
          const resumed = await this.waitForResume(id, session, revision);
          if (this.current(id, revision)) {
            this.status(id, resumed ? 'ready' : 'error', resumed ? '' : 'Claude se relanzó; comprueba el inicio de sesión o la reanudación en la terminal.');
          }
        } catch (error) {
          if (this.current(id, revision)) {
            this.blocked.set(id, target.key);
            this.status(id, 'error', error instanceof Error ? error.message : 'No se pudo cambiar la cuenta.');
          }
        } finally { this.locked.delete(id); }
      }
    } catch {
      for (const id of this.owned) this.status(id, 'error', 'No se pudo comprobar la sesión de Claude. La terminal se conserva.');
    } finally {
      this.running = false;
      if (retry || revision !== this.revision) this.schedule(3000);
    }
  }

  private async waitForResume(id: string, previous: ClaudeSession, revision: number): Promise<boolean> {
    for (let attempt = 0; attempt < 10 && this.current(id, revision); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const launch = this.ptys.launchInfo(id);
      if (!launch) return false;
      const session = findClaudeSession(launch, await processTree());
      if (session?.sessionId === previous.sessionId) return true;
    }
    return false;
  }
}
