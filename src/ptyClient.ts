import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { log } from './log';
import {
  MAX_HANDSHAKE_CHARS,
  PROTOCOL_VERSION,
  newNonce,
  parseMessage,
  proofFor,
  sameProof,
  type ClientMessage,
  type ServerMessage,
} from './serverProtocol';
import { resolveShell } from './shell';
import { buildTerminalEnv } from './environment';
import { agentHomes } from './agentHomes';
import type { ClaudeSession, TerminalLaunch } from './claudeSession';
import type { ResumeAgent, TerminalGeometry, TerminalSnapshot } from './protocol';

export interface PtyListeners {
  onLaunch?: (id: string, launch: TerminalLaunch | undefined) => void;
  onData?: (id: string, data: string) => void;
  onExit?: (id: string, code: number) => void;
  onAttached?: (id: string, found: boolean, data: string | undefined, snapshot?: TerminalSnapshot) => void;
  /** La terminal revivió con el historial guardado en disco por un servidor anterior. */
  onRevived?: (id: string, snapshot: TerminalSnapshot, resume?: ResumeAgent) => void;
  onGeometry?: (id: string, geometry: TerminalGeometry) => void;
  onSpawnError?: (id: string, message: string) => void;
  /** Se perdió la conexión con el servidor: todas las terminales se dan por muertas. */
  onLost?: () => void;
}

const CONNECT_ATTEMPTS = 40;
const CONNECT_INTERVAL_MS = 150;
const HANDSHAKE_TIMEOUT_MS = 5000;

/**
 * Al otro lado del pipe hay algo que no conoce el token. Lanzar otro servidor
 * no arreglaría nada (el nombre ya está ocupado) y seguir hablando le entregaría
 * el entorno del shell y lo que se teclea, así que se aborta sin reintentar.
 */
class ImpostorError extends Error {}

/**
 * Cliente del servidor de terminales. Los shells corren en un proceso aparte
 * (dist/server.js) que sobrevive a recargas y cierres de VS Code; aquí solo se
 * habla con él por un named pipe / socket unix.
 */
export class PtyClient {
  private sock: net.Socket | undefined;
  private buffer = '';
  private connecting: Promise<void> | undefined;
  private readonly alive = new Set<string>();
  private readonly exitedWhileDetached = new Set<string>();
  private listeners: PtyListeners = {};
  private disposed = false;
  private stateReplay = false;
  private profileSwitch = false;
  private readonly pipePath: string;
  private readonly tokenFile: string;
  private readonly token: string;
  private readonly launches = new Map<string, TerminalLaunch>();
  private readonly pendingLaunches = new Map<string, Omit<TerminalLaunch, 'pid'>>();
  private readonly replacements = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.tokenFile = path.join(ctx.globalStorageUri.fsPath, 'server-token');
    this.token = loadToken(this.tokenFile);
    this.pipePath = pipePathFor(this.token);
    for (const [id, launch] of Object.entries(ctx.workspaceState.get<Record<string, TerminalLaunch>>('muxentra.launches') ?? {})) {
      this.launches.set(id, launch);
    }
  }

  attach(listeners: PtyListeners): void {
    this.listeners = listeners;
  }

  detach(): void {
    this.listeners = {};
  }

  aliveIds(): string[] {
    return [...this.alive];
  }

  supportsStateReplay(): boolean {
    return this.stateReplay;
  }

  supportsProfileSwitch(): boolean { return this.profileSwitch; }

  configure(scrollback: number): void {
    if (!this.stateReplay) return;
    for (const id of this.alive) this.send({ t: 'configure', id, scrollback });
  }

  takeExited(): string[] {
    const ids = [...this.exitedWhileDetached];
    this.exitedWhileDetached.clear();
    return ids;
  }

  /** Garantiza una conexión con el servidor, lanzándolo si no existe. */
  ready(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('El host de extensiones se cerró.'));
    if (this.sock && !this.sock.destroyed) return Promise.resolve();
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = undefined;
      });
    }
    return this.connecting;
  }

  async spawn(id: string, cols: number, rows: number): Promise<void> {
    await this.ready();
    const shell = resolveShell();
    const cwd = workingDirectory();
    log().info(`spawn ${id}: "${shell.path}" ${shell.args.join(' ')} (${cols}x${rows}) en ${cwd}`);
    this.alive.add(id);
    const config = vscode.workspace.getConfiguration('muxentra');
    const env = buildTerminalEnv(shell.env, cwd);
    this.prepareLaunch(id, shell.path, env, cwd);
    this.send({ t: 'spawn', id, file: shell.path, args: shell.args, cwd, env, cols, rows,
      scrollback: config.get<number>('scrollback') ?? 20000,
      useConptyDll: config.get<boolean>('rebuildAwareScrollback') ?? true,
    });
  }

  launchInfo(id: string): TerminalLaunch | undefined { return this.launches.get(id); }

  /** Replace only this pane, keeping its ID and restoring the exact transcript. */
  async restartClaude(id: string, session: ClaudeSession, env: Record<string, string>, cols: number, rows: number,
    stillCurrent: () => boolean = () => true): Promise<void> {
    await this.ready();
    if (this.disposed || !this.alive.has(id) || !stillCurrent()) throw new Error('El cambio de perfil ya no está vigente.');
    if (!this.profileSwitch) throw new Error('El cambio de cuenta necesita reiniciar el servidor de terminales de la versión anterior.');
    const shell = resolveShell();
    const script = path.join(this.ctx.extensionPath, 'dist', 'claudeResume.js');
    if (!fs.existsSync(script)) throw new Error('Falta compilar el lanzador de Claude.');
    const config = vscode.workspace.getConfiguration('muxentra');
    const resumeSource = { sessionId: session.sessionId, transcript: session.transcript };
    this.prepareLaunch(id, process.execPath, env, session.cwd, resumeSource);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.replacements.delete(id);
        reject(new Error('El servidor no confirmó la reanudación de Claude.'));
      }, 15000);
      this.replacements.set(id, { resolve, reject, timer });
      this.send({ t: 'spawn', id, file: process.execPath,
        args: [script, session.executable, session.transcript, shell.path, JSON.stringify(shell.args)],
        cwd: session.cwd, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, cols, rows, preserveHistory: true, resumeSource,
        scrollback: config.get<number>('scrollback') ?? 20000,
        useConptyDll: config.get<boolean>('rebuildAwareScrollback') ?? true });
    });
  }

  private prepareLaunch(id: string, file: string, env: Record<string, string>, cwd: string, resumeSource?: TerminalLaunch['resumeSource']): void {
    const homes = agentHomes(env, cwd);
    this.pendingLaunches.set(id, { file, startedAt: Date.now(), claudeHome: homes.claude, claudeConfigFile: homes.claudeConfigFile, resumeSource });
  }

  private rememberLaunch(id: string, launch?: TerminalLaunch, pid?: number): void {
    const pending = this.pendingLaunches.get(id);
    if (!launch && pid && pending) launch = { ...pending, pid };
    if (launch) {
      this.launches.set(id, launch);
      this.pendingLaunches.delete(id);
      this.saveLaunches();
    }
    this.listeners.onLaunch?.(id, this.launches.get(id));
  }

  private saveLaunches(): void {
    void this.ctx.workspaceState.update('muxentra.launches', Object.fromEntries(this.launches)).then(undefined,
      () => log().warn('no se pudo guardar la referencia de las terminales'));
  }

  async attachTerminal(id: string, cols: number, rows: number): Promise<void> {
    await this.ready();
    this.send({ t: 'attach', id, cols, rows,
      scrollback: vscode.workspace.getConfiguration('muxentra').get<number>('scrollback') ?? 20000,
    });
  }

  write(id: string, data: string): void {
    this.send({ t: 'input', id, data });
  }

  resize(id: string, cols: number, rows: number): void {
    this.send({ t: 'resize', id, cols, rows });
  }

  kill(id: string): void {
    this.launches.delete(id);
    this.pendingLaunches.delete(id);
    this.saveLaunches();
    this.alive.delete(id);
    log().info(`kill ${id}`);
    this.send({ t: 'kill', id });
  }

  async killAll(): Promise<void> {
    await this.ready();
    log().info('killAll');
    this.send({ t: 'killAll' });
  }

  /** Desconecta sin matar terminales (se reconectan en la próxima sesión). */
  dispose(): void {
    this.disposed = true;
    this.listeners = {};
    this.sock?.end();
    this.sock = undefined;
    for (const pending of this.replacements.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('El host de extensiones se cerró.'));
    }
    this.replacements.clear();
  }

  // ------------------------------------------------------------------ interno

  private send(msg: ClientMessage): void {
    if (!this.sock || this.sock.destroyed) {
      log().warn(`sin conexión, se descarta mensaje ${msg.t}`);
      return;
    }
    this.sock.write(JSON.stringify(msg) + '\n');
  }

  private async connect(): Promise<void> {
    let spawned = false;
    let lastError = '';
    for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
      if (this.disposed) throw new Error('El host de extensiones se cerró.');
      try {
        const sock = await this.tryConnect();
        const { welcome, version } = await this.handshake(sock);
        if (this.disposed) { sock.destroy(); throw new Error('El host de extensiones se cerró.'); }
        if (version !== PROTOCOL_VERSION) {
          log().warn(`servidor con protocolo ${version} (esperado ${PROTOCOL_VERSION}); se reinicia`);
          sock.write(JSON.stringify({ t: 'shutdown' } satisfies ClientMessage) + '\n');
          sock.end();
          await delay(500);
          spawned = false;
          continue;
        }
        this.adopt(sock, welcome);
        return;
      } catch (err) {
        if (err instanceof ImpostorError) throw err;
        lastError = err instanceof Error ? err.message : String(err);
      }
      if (!spawned) {
        this.spawnServer();
        spawned = true;
      }
      await delay(CONNECT_INTERVAL_MS);
    }
    throw new Error(`no se pudo conectar con el servidor de terminales: ${lastError}`);
  }

  private tryConnect(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.pipePath);
      sock.setEncoding('utf8');
      sock.once('connect', () => resolve(sock));
      sock.once('error', reject);
    });
  }

  /**
   * Reto-respuesta mutuo. Primero el servidor demuestra que conoce el token y
   * solo entonces el cliente manda su propia prueba: si al otro lado hay un
   * impostor, la conversación se corta antes de darle nada.
   */
  private handshake(sock: net.Socket): Promise<{ welcome: Extract<ServerMessage, { t: 'welcome' }>; version: number }> {
    return new Promise((resolve, reject) => {
      const clientNonce = newNonce();
      let buf = '';
      let version = PROTOCOL_VERSION;
      let answered = false;
      let settled = false;

      const cleanup = (): void => {
        sock.off('data', onData);
        sock.off('error', onError);
        clearTimeout(timer);
      };
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        sock.destroy();
        reject(err);
      };
      const done = (welcome: Extract<ServerMessage, { t: 'welcome' }>): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this.buffer = buf;
        resolve({ welcome, version });
      };

      const onData = (chunk: string): void => {
        buf += chunk;
        if (buf.length > MAX_HANDSHAKE_CHARS && buf.indexOf('\n') < 0) {
          fail(new Error('respuesta de saludo demasiado larga'));
          return;
        }
        for (;;) {
          if (settled) return;
          const index = buf.indexOf('\n');
          if (index < 0) return;
          const line = buf.slice(0, index);
          buf = buf.slice(index + 1);
          if (!line) continue;
          const msg = parseMessage(line) as ServerMessage | undefined;
          if (!msg) {
            fail(new Error('respuesta de saludo inválida'));
            return;
          }
          if (!answered) {
            if (msg.t !== 'challenge') {
              fail(new Error(`respuesta inesperada al saludo: ${msg.t}`));
              return;
            }
            if (typeof msg.nonce !== 'string' || msg.nonce.length < 16) {
              fail(new Error('reto del servidor inválido'));
              return;
            }
            if (!sameProof(msg.proof, proofFor(this.token, 'server', clientNonce, msg.nonce))) {
              fail(
                new ImpostorError(
                  'otro proceso está ocupando el canal de las terminales y no conoce la clave de esta instalación. ' +
                    'Cierra ese proceso o reinicia la sesión.',
                ),
              );
              return;
            }
            answered = true;
            version = typeof msg.version === 'number' ? msg.version : 0;
            sock.write(
              JSON.stringify({
                t: 'auth',
                proof: proofFor(this.token, 'client', clientNonce, msg.nonce),
              } satisfies ClientMessage) + '\n',
            );
            continue;
          }
          if (msg.t !== 'welcome') {
            fail(new Error(`respuesta inesperada tras autenticar: ${msg.t}`));
            return;
          }
          if (!msg.ok) {
            fail(new Error(msg.error ?? 'saludo rechazado'));
            return;
          }
          done(msg);
          return;
        }
      };
      const onError = (err: Error): void => fail(err);
      const timer = setTimeout(() => fail(new Error('el servidor no respondió al saludo')), HANDSHAKE_TIMEOUT_MS);

      sock.on('data', onData);
      sock.once('error', onError);
      sock.write(JSON.stringify({ t: 'hello', version: PROTOCOL_VERSION, nonce: clientNonce, stateReplay: true } satisfies ClientMessage) + '\n');
    });
  }

  private adopt(sock: net.Socket, welcome: Extract<ServerMessage, { t: 'welcome' }>): void {
    this.sock = sock;
    this.stateReplay = welcome.stateReplay === true;
    this.profileSwitch = welcome.profileSwitch === true;
    this.alive.clear();
    for (const id of welcome.alive) this.alive.add(id);
    for (const id of welcome.exited) this.exitedWhileDetached.add(id);
    log().info(`conectado al servidor: ${welcome.alive.length} terminales vivas, ${welcome.exited.length} terminadas`);
    sock.removeAllListeners('error');
    sock.on('data', chunk => this.onData(String(chunk)));
    sock.on('error', err => log().error(`socket: ${err.message}`));
    sock.on('close', () => {
      if (this.sock !== sock) return;
      this.sock = undefined;
      this.buffer = '';
      if (this.disposed) return;
      log().warn('conexión con el servidor perdida');
      this.alive.clear();
      this.listeners.onLost?.();
    });
    if (this.buffer) {
      const pending = this.buffer;
      this.buffer = '';
      this.onData(pending);
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      const msg = parseMessage(line) as ServerMessage | undefined;
      if (msg) this.onMessage(msg);
    }
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case 'data':
        this.listeners.onData?.(msg.id, msg.data);
        break;
      case 'exit':
        this.launches.delete(msg.id);
        this.saveLaunches();
        this.alive.delete(msg.id);
        log().info(`exit ${msg.id}: código ${msg.code}`);
        if (this.listeners.onExit) this.listeners.onExit(msg.id, msg.code);
        else this.exitedWhileDetached.add(msg.id);
        break;
      case 'spawned':
        this.alive.add(msg.id);
        log().info(`spawned ${msg.id}: pid ${msg.pid}${msg.snapshot ? ` con historial recuperado${msg.resume ? ` (${msg.resume})` : ''}` : ''}`);
        if (msg.snapshot) this.listeners.onRevived?.(msg.id, msg.snapshot, msg.resume);
        if (msg.geometry) this.listeners.onGeometry?.(msg.id, msg.geometry);
        this.rememberLaunch(msg.id, msg.launch, msg.pid);
        {
          const pending = this.replacements.get(msg.id);
          if (pending) { clearTimeout(pending.timer); this.replacements.delete(msg.id); pending.resolve(); }
        }
        break;
      case 'spawnError':
        this.pendingLaunches.delete(msg.id);
        {
          const pending = this.replacements.get(msg.id);
          if (pending) { clearTimeout(pending.timer); this.replacements.delete(msg.id); pending.reject(new Error(msg.message)); }
        }
        if (!msg.preserved) this.alive.delete(msg.id);
        log().error(`spawn ${msg.id} falló: ${msg.message}`);
        this.listeners.onSpawnError?.(msg.id, msg.message);
        break;
      case 'attached':
        if (!msg.found) this.alive.delete(msg.id);
        this.listeners.onAttached?.(msg.id, msg.found, msg.data, msg.snapshot);
        if (msg.found) this.rememberLaunch(msg.id, msg.launch);
        break;
      case 'challenge':
      case 'welcome':
        // Solo tienen sentido durante el saludo.
        break;
    }
  }

  private spawnServer(): void {
    const script = path.join(this.ctx.extensionPath, 'dist', 'server.js');
    const logFile = path.join(this.ctx.globalStorageUri.fsPath, 'server.log');
    log().info(`lanzando servidor de terminales: ${process.execPath} ${script}`);
    try {
      // El token se pasa por la ruta de su archivo: los argumentos de un proceso
      // son visibles para otros usuarios de la máquina.
      const child = cp.spawn(process.execPath, [script, this.pipePath, this.tokenFile, logFile], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
      child.on('error', err => log().error(`servidor: ${err.message}`));
      child.unref();
    } catch (err) {
      log().error(`no se pudo lanzar el servidor: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * El nombre se deriva del token, así que otro usuario de la máquina no puede
 * adivinarlo para adelantarse a ocuparlo. En Windows el espacio de nombres de
 * los pipes es común a todo el sistema y en Linux /tmp es compartido, así que
 * un nombre predecible bastaba para suplantar al servidor.
 */
function pipePathFor(token: string): string {
  const id = crypto.createHmac('sha256', token).update('muxentra-pipe').digest('hex').slice(0, 16);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\muxentra-${id}`
    : path.join(socketDir(), `muxentra-${id}.sock`);
}

/** Directorio del socket unix: privado del usuario siempre que se pueda. */
function socketDir(): string {
  // En macOS el temporal ya está confinado por usuario, y las rutas de socket
  // tienen un límite de ~104 bytes, así que no conviene anidar más.
  if (process.platform === 'darwin') return os.tmpdir();

  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg && path.isAbsolute(xdg) && isPrivateDir(xdg)) return xdg;

  const uid = typeof process.getuid === 'function' ? process.getuid() : os.userInfo().username;
  const dir = path.join(os.tmpdir(), `muxentra-${uid}`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // Puede existir ya; lo comprueba isPrivateDir.
  }
  if (isPrivateDir(dir)) return dir;

  log().warn(`no se pudo crear un directorio privado para el socket; se usa ${os.tmpdir()}`);
  return os.tmpdir();
}

/** Directorio que existe, es nuestro, no es un enlace y no deja entrar a nadie más. */
function isPrivateDir(dir: string): boolean {
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory()) return false;
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return false;
    if ((stat.mode & 0o077) !== 0) {
      fs.chmodSync(dir, 0o700);
      return (fs.lstatSync(dir).mode & 0o077) === 0;
    }
    return true;
  } catch {
    return false;
  }
}

function loadToken(file: string): string {
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // No existe todavía.
  }
  const token = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, token, { mode: 0o600 });
  } catch (err) {
    log().warn(`no se pudo guardar el token: ${err instanceof Error ? err.message : String(err)}`);
  }
  return token;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Directorio donde arrancan las terminales nuevas. */
export function workingDirectory(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder && folder.uri.scheme === 'file' ? folder.uri.fsPath : os.homedir();
}
