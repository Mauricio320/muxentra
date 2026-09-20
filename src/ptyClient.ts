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

export interface PtyListeners {
  onData?: (id: string, data: string) => void;
  onExit?: (id: string, code: number) => void;
  onAttached?: (id: string, found: boolean, data: string | undefined) => void;
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
  private readonly pipePath: string;
  private readonly tokenFile: string;
  private readonly token: string;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.tokenFile = path.join(ctx.globalStorageUri.fsPath, 'server-token');
    this.token = loadToken(this.tokenFile);
    this.pipePath = pipePathFor(this.token);
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

  takeExited(): string[] {
    const ids = [...this.exitedWhileDetached];
    this.exitedWhileDetached.clear();
    return ids;
  }

  /** Garantiza una conexión con el servidor, lanzándolo si no existe. */
  ready(): Promise<void> {
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
    this.send({ t: 'spawn', id, file: shell.path, args: shell.args, cwd, env: buildEnv(), cols, rows });
  }

  async attachTerminal(id: string, cols: number, rows: number): Promise<void> {
    await this.ready();
    this.send({ t: 'attach', id, cols, rows });
  }

  write(id: string, data: string): void {
    this.send({ t: 'input', id, data });
  }

  resize(id: string, cols: number, rows: number): void {
    this.send({ t: 'resize', id, cols, rows });
  }

  kill(id: string): void {
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
      try {
        const sock = await this.tryConnect();
        const { welcome, version } = await this.handshake(sock);
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
      sock.write(JSON.stringify({ t: 'hello', version: PROTOCOL_VERSION, nonce: clientNonce } satisfies ClientMessage) + '\n');
    });
  }

  private adopt(sock: net.Socket, welcome: Extract<ServerMessage, { t: 'welcome' }>): void {
    this.sock = sock;
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
        this.alive.delete(msg.id);
        log().info(`exit ${msg.id}: código ${msg.code}`);
        if (this.listeners.onExit) this.listeners.onExit(msg.id, msg.code);
        else this.exitedWhileDetached.add(msg.id);
        break;
      case 'spawned':
        this.alive.add(msg.id);
        log().info(`spawned ${msg.id}: pid ${msg.pid}`);
        break;
      case 'spawnError':
        this.alive.delete(msg.id);
        log().error(`spawn ${msg.id} falló: ${msg.message}`);
        this.listeners.onSpawnError?.(msg.id, msg.message);
        break;
      case 'attached':
        if (!msg.found) this.alive.delete(msg.id);
        this.listeners.onAttached?.(msg.id, msg.found, msg.data);
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

/** Variables internas del extension host que no deben llegar al shell (igual que hace la terminal de VS Code). */
function isInternalVar(key: string): boolean {
  if (key === 'ELECTRON_RUN_AS_NODE' || key === 'ELECTRON_NO_ATTACH_CONSOLE') return true;
  return key.startsWith('VSCODE_') && !key.startsWith('VSCODE_GIT_');
}

function buildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !isInternalVar(key)) env[key] = value;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'muxentra';
  return env;
}
