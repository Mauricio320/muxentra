// Servidor de terminales: proceso independiente del extension host que
// mantiene vivos los shells (con node-pty) aunque VS Code se recargue o cierre.
// Uso: <node> server.js <pipePath> <tokenFile> [logFile]
//
// El token llega por la ruta de un archivo y no como argumento: los argumentos
// de un proceso los puede leer cualquier usuario de la máquina con ps.

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { IPty } from 'node-pty';
import type { ResumeAgent } from '../protocol';
import { TerminalState } from './terminalState';
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

const IDLE_EXIT_MS = 5 * 60 * 1000;
const MAX_LOG_BYTES = 512 * 1024;
/** Cada cuánto se vuelca a disco el historial de las terminales con salida nueva. */
const SAVE_INTERVAL_MS = 2 * 60 * 1000;
/** Un historial que nadie reclama en dos semanas ya no vuelve: se borra al arrancar. */
const SESSION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const SESSION_VERSION = 1;

interface Term {
  proc: IPty;
  state: TerminalState;
  pendingData?: { chunks: string[] };
  owner: Conn | null;
  /** Último tamaño aplicado al pty, para no repetir un resize que no cambia nada. */
  cols: number;
  rows: number;
  /** Hubo salida desde el último volcado a disco. */
  dirty: boolean;
  /** Línea que el usuario está tecleando, para saber qué programa lanzó. */
  line: string;
  escape: 0 | 1 | 2;
  /** Agente que se lanzó desde el prompt y aún no ha devuelto el título al shell. */
  running?: ResumeAgent;
}

/**
 * Historial guardado en disco. El proceso no sobrevive a un apagado del PC,
 * pero lo que había en pantalla sí puede volver encima de un shell nuevo.
 */
interface SavedSession {
  version: number;
  savedAt: number;
  cols: number;
  rows: number;
  data: string;
  resume?: ResumeAgent;
}

const terms = new Map<string, Term>();
const exitedWithoutOwner = new Set<string>();
const conns = new Set<Conn>();
let lastActivity = Date.now();
const sessionsDir = path.join(path.dirname(tokenFile ?? '.'), 'sessions');

/** Solo ids como los que genera el webview: nada que pueda salirse del directorio. */
function sessionFile(id: string): string | undefined {
  return /^[a-z0-9]{6,32}$/i.test(id) ? path.join(sessionsDir, `${id}.json`) : undefined;
}

function deleteSession(id: string): void {
  const file = sessionFile(id);
  if (!file) return;
  try {
    fs.unlinkSync(file);
  } catch {
    // No había nada guardado.
  }
}

/** Escritura atómica: un apagado a mitad de volcado no deja un archivo corrupto. */
function saveSession(id: string, term: Term): void {
  const file = sessionFile(id);
  if (!file || !term.dirty) return;
  const snapshot = term.state.historySnapshot();
  const session: SavedSession = {
    version: SESSION_VERSION, savedAt: Date.now(), cols: snapshot.cols, rows: snapshot.rows,
    data: snapshot.data, resume: term.running,
  };
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, JSON.stringify(session), { mode: 0o600 });
    fs.renameSync(temporary, file);
    term.dirty = false;
  } catch (err) {
    log(`no se pudo guardar el historial de ${id}: ${String(err)}`);
    try { fs.unlinkSync(temporary); } catch { /* ya renombrado o nunca escrito */ }
  }
}

function saveAll(): void {
  for (const [id, term] of terms) {
    if (term.dirty) void term.state.run(() => saveSession(id, term));
  }
}

/** Lee y consume el historial guardado de una terminal, si lo hay y es válido. */
function loadSession(id: string): SavedSession | undefined {
  const file = sessionFile(id);
  if (!file) return undefined;
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  deleteSession(id);
  try {
    const session = JSON.parse(raw) as Partial<SavedSession>;
    if (session.version !== SESSION_VERSION || typeof session.data !== 'string' || !session.data) return undefined;
    if (typeof session.savedAt !== 'number' || !Number.isFinite(session.savedAt)) return undefined;
    return {
      version: SESSION_VERSION, savedAt: session.savedAt, data: session.data,
      cols: size(session.cols, 80, 2), rows: size(session.rows, 24, 1),
      resume: session.resume === 'claude' || session.resume === 'codex' ? session.resume : undefined,
    };
  } catch {
    return undefined;
  }
}

function cleanSessions(): void {
  let names: string[];
  try {
    names = fs.readdirSync(sessionsDir);
  } catch {
    return;
  }
  const limit = Date.now() - SESSION_MAX_AGE_MS;
  for (const name of names) {
    const file = path.join(sessionsDir, name);
    try {
      if (name.endsWith('.tmp') || fs.statSync(file).mtimeMs < limit) fs.unlinkSync(file);
    } catch {
      // Se intentará en el próximo arranque.
    }
  }
}

/** Línea separadora que va entre el historial recuperado y el prompt del shell nuevo. */
function sessionDivider(savedAt: number): string {
  const when = new Date(savedAt).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return `\r\n\x1b[0;2m── sesión anterior · ${when} ──\x1b[0m\r\n`;
}

/**
 * Qué agente corre en la terminal. El comando tecleado lo abre; el título lo
 * confirma (Claude Code pone el suyo) o lo cierra, porque el shell vuelve a
 * poner el suyo, con la ruta, en cuanto recupera el prompt.
 */
function noteTitle(term: Term, title: string): void {
  const lower = title.toLowerCase();
  if (lower.includes('claude') || title.trimStart().startsWith('✳')) term.running = 'claude';
  else if (lower.includes('codex')) term.running = 'codex';
  else if (/mingw|msys|cygwin|powershell|cmd\.exe|:[\\/]|^[a-z]:\\|^\/|~/i.test(title)) term.running = undefined;
}

function noteInput(term: Term, data: string): void {
  for (const char of data) {
    const code = char.charCodeAt(0);
    if (term.escape === 1) {
      term.escape = char === '[' || char === 'O' ? 2 : 0;
      continue;
    }
    if (term.escape === 2) {
      if (code >= 0x40 && code <= 0x7e) term.escape = 0;
      continue;
    }
    if (char === '\x1b') {
      term.escape = 1;
    } else if (char === '\r' || char === '\n') {
      const command = term.line.trim();
      term.line = '';
      const match = /^(claude|codex)(\s|$)/.exec(command);
      if (match) term.running = match[1] as ResumeAgent;
    } else if (char === '\x7f' || char === '\b') {
      term.line = term.line.slice(0, -1);
    } else if (char === '\x03' || char === '\x15') {
      term.line = '';
    } else if (code >= 0x20 && term.line.length < 512) {
      term.line += char;
    }
  }
}

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
  stateReplay = false;
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
    this.stateReplay = msg.stateReplay === true;
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
      stateReplay: true,
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
    // VS Code se ha ido: es el momento de dejar el historial a salvo, porque
    // lo siguiente puede ser un apagado del PC que no avisa.
    saveAll();
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
      // El snapshot es una barrera: contiene toda la salida anterior y ningún
      // byte posterior. Reconectar nunca cambia el tamaño del proceso.
      term.pendingData = undefined;
      void term.state.run(() => {
        if (conn.sock.destroyed) return;
        if (msg.scrollback !== undefined) term.state.configure(msg.scrollback);
        const snapshot = term.state.snapshot();
        conn.send(conn.stateReplay
          ? { t: 'attached', id: msg.id, found: true, snapshot }
          : { t: 'attached', id: msg.id, found: true, data: snapshot.data });
        term.owner = conn;
        if (!conn.stateReplay) resize(term, msg.cols, msg.rows);
      }).catch(err => log(`snapshot ${msg.id}: ${String(err)}`));
      log(`attach ${msg.id}`);
      break;
    }
    case 'input':
      if (typeof msg.id === 'string' && typeof msg.data === 'string') {
        const term = terms.get(msg.id);
        if (term) {
          noteInput(term, msg.data);
          term.proc.write(msg.data);
        }
      }
      break;
    case 'resize': {
      if (typeof msg.id !== 'string') break;
      const term = terms.get(msg.id);
      if (term) {
        term.pendingData = undefined;
        void term.state.run(() => resize(term, msg.cols, msg.rows));
      }
      break;
    }
    case 'configure': {
      const term = terms.get(msg.id);
      if (term) {
        term.pendingData = undefined;
        void term.state.run(() => term.state.configure(msg.scrollback));
      }
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
  // Leer el historial antes de kill(), porque kill() borra el archivo de sesión.
  // Si esta terminal dejó historial en disco, el shell nuevo nace con el tamaño
  // de entonces para que las líneas guardadas no se partan al volver; el cliente
  // lo ajusta después, como en cualquier reconexión.
  const saved = loadSession(msg.id);
  kill(msg.id);
  const cols = saved ? saved.cols : size(msg.cols, 80, 2);
  const rows = saved ? saved.rows : size(msg.rows, 24, 1);
  let proc: IPty;
  const useConptyDll = process.platform === 'win32' && msg.useConptyDll !== false;
  try {
    const pty = require('node-pty') as typeof import('node-pty');
    proc = pty.spawn(msg.file, msg.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: msg.cwd,
      env: msg.env,
      useConptyDll,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`spawn ${msg.id} falló: ${message}`);
    conn.send({ t: 'spawnError', id: msg.id, message });
    return;
  }
  const state = new TerminalState({
    cols, rows,
    ...(process.platform === 'win32' ? {
      // node-pty 1.1.0 incluye ConPTY 1.23: soporta el reflow moderno aunque el
      // SO sea Windows 10. xterm necesita la capacidad del backend, no la del SO.
      windowsPty: { backend: 'conpty' as const, buildNumber: useConptyDll ? 22621 : Number(os.release().split('.')[2]) },
    } : {}),
  }, msg.scrollback);
  const term: Term = { proc, state, owner: conn, cols, rows, dirty: false, line: '', escape: 0 };
  terms.set(msg.id, term);
  exitedWithoutOwner.delete(msg.id);
  log(`spawn ${msg.id}: pid ${proc.pid} ${msg.file} ${msg.args.join(' ')}${saved ? ' (revive historial)' : ''}`);
  if (saved) {
    // El historial entra en la cola antes que cualquier byte del shell nuevo,
    // así que el snapshot que recibe el cliente lo contiene entero y nada más.
    void state.run(async () => {
      await state.write(saved.data + sessionDivider(saved.savedAt));
      term.dirty = true;
      conn.send({ t: 'spawned', id: msg.id, pid: proc.pid, geometry: state.geometry, snapshot: state.snapshot(), resume: saved.resume });
    }).catch(err => log(`revive ${msg.id}: ${String(err)}`));
  } else {
    conn.send({ t: 'spawned', id: msg.id, pid: proc.pid, geometry: state.geometry });
  }

  proc.onData(data => {
    if (term.pendingData) {
      term.pendingData.chunks.push(data);
      return;
    }
    const batch = { chunks: [data] };
    term.pendingData = batch;
    void state.run(async () => {
      if (term.pendingData === batch) term.pendingData = undefined;
      const output = batch.chunks.join('');
      const title = state.title;
      await state.write(output);
      if (state.title !== title) noteTitle(term, state.title);
      term.dirty = true;
      term.owner?.send({ t: 'data', id: msg.id, data: output });
    }).catch(err => log(`salida ${msg.id}: ${String(err)}`));
  });

  proc.onExit(({ exitCode }) => {
    log(`exit ${msg.id}: pid ${proc.pid} código ${exitCode}`);
    if (terms.get(msg.id) !== term) return;
    terms.delete(msg.id);
    // El shell terminó por sí mismo: no hay sesión que recuperar.
    deleteSession(msg.id);
    lastActivity = Date.now();
    void state.run(() => {
      if (term.owner) term.owner.send({ t: 'exit', id: msg.id, code: exitCode });
      else exitedWithoutOwner.add(msg.id);
      state.dispose();
    });
  });
}

function size(value: unknown, fallback: number, min: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(5000, Math.floor(value)));
}

function resize(term: Term, rawCols: unknown, rawRows: unknown): void {
  const cols = size(rawCols, term.cols, 2);
  const rows = size(rawRows, term.rows, 1);
  // Un resize al mismo tamaño manda igual un SIGWINCH, y las TUI de los agentes
  // responden repintando el marco entero. Al reconectar eso dejaba una copia
  // del último frame justo debajo del historial que se acababa de reproducir.
  if (cols === term.cols && rows === term.rows) return;
  try {
    term.proc.resize(cols, rows);
    term.state.resize(cols, rows);
    term.cols = cols;
    term.rows = rows;
  } catch {
    // Proceso terminando.
  }
}

function kill(id: string): void {
  // Cerrar una terminal a propósito también tira su historial guardado.
  deleteSession(id);
  const term = terms.get(id);
  if (!term) return;
  terms.delete(id);
  log(`kill ${id}: pid ${term.proc.pid}`);
  try {
    term.proc.kill();
  } catch {
    // Ya estaba muerto.
  }
  void term.state.run(() => term.state.dispose());
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
cleanSessions();

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

// Un apagado del PC no avisa: lo que haya cambiado desde el último volcado se
// pierde, así que se vuelca periódicamente además de al irse el cliente.
setInterval(saveAll, SAVE_INTERVAL_MS).unref();

process.on('uncaughtException', err => {
  log(`uncaughtException: ${err.stack ?? err.message}`);
});
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
