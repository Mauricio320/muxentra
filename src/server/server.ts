// Servidor de terminales: proceso independiente del extension host que
// mantiene vivos los shells (con node-pty) aunque VS Code se recargue o cierre.
// Uso: <node> server.js <pipePath> <tokenFile> [logFile]
//
// El token llega por la ruta de un archivo y no como argumento: los argumentos
// de un proceso los puede leer cualquier usuario de la máquina con ps.

import * as fs from 'fs';
import * as net from 'net';
import type { IPty } from 'node-pty';
import {
  HANDSHAKE_TIMEOUT_MS,
  MAX_HANDSHAKE_CHARS,
  MAX_LINE_CHARS,
  PROTOCOL_VERSION,
  newNonce,
  parseMessage,
  proofFor,
  sameProof,
  type ClientMessage,
  type ServerMessage,
} from '../serverProtocol';

const pipePath = process.argv[2];
const tokenFile = process.argv[3];
const logFile = process.argv[4];

const MAX_BUFFER_CHARS = 1024 * 1024;
const IDLE_EXIT_MS = 5 * 60 * 1000;
const MAX_LOG_BYTES = 512 * 1024;

interface Term {
  proc: IPty;
  chunks: string[];
  size: number;
  owner: Conn | null;
  /** Último tamaño aplicado al pty, para no repetir un resize que no cambia nada. */
  cols: number;
  rows: number;
}

const terms = new Map<string, Term>();
const exitedWithoutOwner = new Set<string>();
const conns = new Set<Conn>();
let lastActivity = Date.now();

let logBytes = -1;

function log(line: string): void {
  if (!logFile) return;
  try {
    if (logBytes < 0) {
      try {
        logBytes = fs.statSync(logFile).size;
      } catch {
        logBytes = 0;
      }
    }
    const entry = `${new Date().toISOString()} ${line}\n`;
    // El log vive en el disco del usuario sin nadie que lo limpie: se rota solo.
    if (logBytes + entry.length > MAX_LOG_BYTES) {
      try {
        fs.renameSync(logFile, `${logFile}.old`);
      } catch {
        // Si no se puede rotar se sigue escribiendo; el tamaño no es crítico.
      }
      logBytes = 0;
    }
    fs.appendFileSync(logFile, entry);
    logBytes += entry.length;
  } catch {
    // Sin log.
  }
}

class Conn {
  authed = false;
  private buffer = '';
  private clientNonce = '';
  private serverNonce = '';
  private greeted = false;
  private readonly timer: NodeJS.Timeout;

  constructor(readonly sock: net.Socket) {
    sock.setEncoding('utf8');
    sock.on('data', chunk => this.onData(String(chunk)));
    sock.on('close', () => this.onClose());
    sock.on('error', err => log(`socket error: ${err.message}`));
    // Una conexión que no se autentica no se queda ocupando el servidor.
    this.timer = setTimeout(() => {
      if (this.authed) return;
      log('saludo sin completar: se cierra la conexión');
      this.sock.destroy();
    }, HANDSHAKE_TIMEOUT_MS);
    this.timer.unref();
  }

  send(msg: ServerMessage): void {
    if (this.sock.destroyed) return;
    this.sock.write(JSON.stringify(msg) + '\n');
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) break;
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      const msg = parseMessage(line);
      if (!msg) {
        log('mensaje inválido');
        continue;
      }
      this.handle(msg as ClientMessage);
      if (this.sock.destroyed) return;
    }
    // Sin el límite, un cliente que nunca manda un salto de línea agota la memoria.
    const limit = this.authed ? MAX_LINE_CHARS : MAX_HANDSHAKE_CHARS;
    if (this.buffer.length > limit) {
      log(`línea demasiado larga (${this.buffer.length} caracteres): se cierra la conexión`);
      this.buffer = '';
      this.sock.destroy();
    }
  }

  private handle(msg: ClientMessage): void {
    lastActivity = Date.now();
    if (msg.t === 'hello') {
      this.onHello(msg);
      return;
    }
    if (msg.t === 'auth') {
      this.onAuth(msg);
      return;
    }
    if (!this.authed) {
      log(`mensaje ${msg.t} sin autenticar: se cierra la conexión`);
      this.sock.destroy();
      return;
    }
    handleAuthed(this, msg);
  }

  /** Paso 1: el cliente manda su nonce y el servidor demuestra conocer el token. */
  private onHello(msg: Extract<ClientMessage, { t: 'hello' }>): void {
    if (this.greeted || this.authed) {
      this.sock.destroy();
      return;
    }
    if (typeof msg.nonce !== 'string' || msg.nonce.length < 16 || msg.nonce.length > 128) {
      log('saludo con nonce inválido');
      this.sock.destroy();
      return;
    }
    this.greeted = true;
    this.clientNonce = msg.nonce;
    this.serverNonce = newNonce();
    this.send({
      t: 'challenge',
      version: PROTOCOL_VERSION,
      nonce: this.serverNonce,
      proof: proofFor(token, 'server', this.clientNonce, this.serverNonce),
    });
  }

  /** Paso 2: el cliente devuelve su propia prueba y queda autenticado. */
  private onAuth(msg: Extract<ClientMessage, { t: 'auth' }>): void {
    if (!this.greeted || this.authed) {
      this.sock.destroy();
      return;
    }
    const expected = proofFor(token, 'client', this.clientNonce, this.serverNonce);
    if (!sameProof(msg.proof, expected)) {
      log('prueba de cliente inválida');
      this.send({ t: 'welcome', ok: false, alive: [], exited: [], error: 'autenticación rechazada' });
      this.sock.end();
      return;
    }
    this.authed = true;
    clearTimeout(this.timer);
    this.send({
      t: 'welcome',
      ok: true,
      alive: [...terms.keys()],
      exited: [...exitedWithoutOwner],
    });
    exitedWithoutOwner.clear();
  }

  private onClose(): void {
    clearTimeout(this.timer);
    conns.delete(this);
    for (const term of terms.values()) {
      if (term.owner === this) term.owner = null;
    }
    log(`conexión cerrada (${conns.size} activas, ${terms.size} terminales)`);
  }
}

function handleAuthed(conn: Conn, msg: ClientMessage): void {
  switch (msg.t) {
    case 'spawn':
      spawn(conn, msg);
      break;
    case 'attach': {
      if (typeof msg.id !== 'string') break;
      const term = terms.get(msg.id);
      if (!term) {
        conn.send({ t: 'attached', id: msg.id, found: false });
        break;
      }
      term.owner = conn;
      conn.send({ t: 'attached', id: msg.id, found: true, data: term.chunks.join('') });
      resize(term, msg.cols, msg.rows);
      log(`attach ${msg.id}`);
      break;
    }
    case 'input':
      if (typeof msg.id === 'string' && typeof msg.data === 'string') {
        terms.get(msg.id)?.proc.write(msg.data);
      }
      break;
    case 'resize': {
      if (typeof msg.id !== 'string') break;
      const term = terms.get(msg.id);
      if (term) resize(term, msg.cols, msg.rows);
      break;
    }
    case 'kill':
      if (typeof msg.id === 'string') kill(msg.id);
      break;
    case 'killAll':
      for (const id of [...terms.keys()]) kill(id);
      break;
    case 'shutdown':
      shutdown(0);
      break;
  }
}

/** El cliente está autenticado, pero un mensaje mal formado no debe tumbar el servidor. */
function validSpawn(msg: Extract<ClientMessage, { t: 'spawn' }>): boolean {
  if (typeof msg.id !== 'string' || !msg.id) return false;
  if (typeof msg.file !== 'string' || !msg.file) return false;
  if (typeof msg.cwd !== 'string') return false;
  if (!Array.isArray(msg.args) || msg.args.some(a => typeof a !== 'string')) return false;
  if (!msg.env || typeof msg.env !== 'object' || Array.isArray(msg.env)) return false;
  return Object.values(msg.env).every(v => typeof v === 'string');
}

function spawn(conn: Conn, msg: Extract<ClientMessage, { t: 'spawn' }>): void {
  if (!validSpawn(msg)) {
    log('spawn con datos inválidos');
    return;
  }
  kill(msg.id);
  const cols = size(msg.cols, 80, 2);
  const rows = size(msg.rows, 24, 1);
  let proc: IPty;
  try {
    const pty = require('node-pty') as typeof import('node-pty');
    proc = pty.spawn(msg.file, msg.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: msg.cwd,
      env: msg.env,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`spawn ${msg.id} falló: ${message}`);
    conn.send({ t: 'spawnError', id: msg.id, message });
    return;
  }
  const term: Term = { proc, chunks: [], size: 0, owner: conn, cols, rows };
  terms.set(msg.id, term);
  exitedWithoutOwner.delete(msg.id);
  log(`spawn ${msg.id}: pid ${proc.pid} ${msg.file} ${msg.args.join(' ')}`);
  conn.send({ t: 'spawned', id: msg.id, pid: proc.pid });

  proc.onData(data => {
    term.chunks.push(data);
    term.size += data.length;
    while (term.size > MAX_BUFFER_CHARS && term.chunks.length > 1) {
      term.size -= term.chunks.shift()!.length;
    }
    term.owner?.send({ t: 'data', id: msg.id, data });
  });

  proc.onExit(({ exitCode }) => {
    log(`exit ${msg.id}: pid ${proc.pid} código ${exitCode}`);
    if (terms.get(msg.id) !== term) return;
    terms.delete(msg.id);
    lastActivity = Date.now();
    if (term.owner) term.owner.send({ t: 'exit', id: msg.id, code: exitCode });
    else exitedWithoutOwner.add(msg.id);
  });
}

function size(value: unknown, fallback: number, min: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(5000, Math.floor(value)));
}

function resize(term: Term, rawCols: unknown, rawRows: unknown): void {
  const cols = size(rawCols, 80, 2);
  const rows = size(rawRows, 24, 1);
  // Un resize al mismo tamaño manda igual un SIGWINCH, y las TUI de los agentes
  // responden repintando el marco entero. Al reconectar eso dejaba una copia
  // del último frame justo debajo del historial que se acababa de reproducir.
  if (cols === term.cols && rows === term.rows) return;
  term.cols = cols;
  term.rows = rows;
  try {
    term.proc.resize(cols, rows);
  } catch {
    // Proceso terminando.
  }
}

function kill(id: string): void {
  const term = terms.get(id);
  if (!term) return;
  terms.delete(id);
  log(`kill ${id}: pid ${term.proc.pid}`);
  try {
    term.proc.kill();
  } catch {
    // Ya estaba muerto.
  }
}

function shutdown(code: number): void {
  log(`apagando (${terms.size} terminales)`);
  for (const id of [...terms.keys()]) kill(id);
  server.close();
  if (process.platform !== 'win32') {
    try {
      fs.unlinkSync(pipePath);
    } catch {
      // Ya no existe.
    }
  }
  setTimeout(() => process.exit(code), 200);
}

if (!pipePath || !tokenFile) {
  console.error('uso: server.js <pipePath> <tokenFile> [logFile]');
  process.exit(2);
}

// En POSIX el socket nace con los permisos del umask: sin esto quedaría legible
// para todo el mundo durante el instante que va del listen al chmod.
if (process.platform !== 'win32') process.umask(0o077);

let token = '';
try {
  token = fs.readFileSync(tokenFile, 'utf8').trim();
} catch (err) {
  console.error(`no se pudo leer el token: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
if (!token) {
  console.error('el archivo de token está vacío');
  process.exit(2);
}

process.title = 'muxentra-server';

const server = net.createServer(sock => {
  const conn = new Conn(sock);
  conns.add(conn);
  lastActivity = Date.now();
  log(`conexión nueva (${conns.size} activas)`);
});

server.on('error', err => {
  log(`server error: ${err.message}`);
  process.exit(3);
});

if (process.platform !== 'win32' && fs.existsSync(pipePath)) {
  // Socket huérfano de una ejecución anterior (si estuviera en uso, connect habría funcionado antes).
  try {
    fs.unlinkSync(pipePath);
  } catch {
    // Ignorar.
  }
}

server.listen(pipePath, () => {
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(pipePath, 0o600);
    } catch {
      // El umask ya lo dejó restringido.
    }
  }
  log(`escuchando en ${pipePath} (pid ${process.pid})`);
});

setInterval(() => {
  if (terms.size === 0 && conns.size === 0 && Date.now() - lastActivity > IDLE_EXIT_MS) {
    log('sin terminales ni clientes: saliendo');
    shutdown(0);
  }
}, 30 * 1000).unref();

process.on('uncaughtException', err => {
  log(`uncaughtException: ${err.stack ?? err.message}`);
});
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
