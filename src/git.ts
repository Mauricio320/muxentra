// Resuelve la rama de un directorio leyendo .git directamente, sin lanzar git.
// Soporta worktrees, donde .git es un archivo que apunta al gitdir real.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface GitInfo {
  /** Nombre de la rama, o el sha corto si está en HEAD desacoplado. */
  branch: string;
  detached: boolean;
  /** Raíz del árbol de trabajo (útil para distinguir worktrees). */
  root: string;
}

const MAX_PARENTS = 40;
/** Una ruta más larga que esto no es un directorio real, es ruido de la terminal. */
const MAX_CWD_CHARS = 512;

/**
 * Rutas que no se deben tocar ni para hacerles stat. En Windows, todo lo que
 * empieza por dos barras es UNC (\\host\recurso) o un espacio de dispositivos
 * (\\.\ , \\?\): abrirlas lanza una conexión SMB al host que diga la ruta, que
 * en una red local sirve para capturar el hash NTLM del usuario, y además deja
 * el extension host bloqueado hasta que la conexión expira. Todo esto llega
 * desde fuera (el título de la terminal, un OSC 7, un archivo .git de un
 * repositorio ajeno), así que se descarta antes de mirarlo.
 */
function isRemoteLike(value: string): boolean {
  return process.platform === 'win32' && /^[\\/]{2}/.test(value);
}

/**
 * Convierte a una ruta usable del sistema lo que reporta el shell: URI de
 * OSC 7, ruta estilo MSYS (/c/Users/...), cygwin o con ~.
 */
export function normalizeCwd(raw: string): string | undefined {
  let value = raw.trim().replace(/\0/g, '');
  if (!value || value.length > MAX_CWD_CHARS) return undefined;
  // Los caracteres de control no aparecen en rutas reales y sí en salida basura.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;

  if (/^file:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return undefined;
    }
    // file://host/recurso es una ruta de red; solo vale el host vacío o local.
    const host = url.hostname.toLowerCase();
    if (host && host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') return undefined;
    try {
      value = decodeURIComponent(url.pathname);
    } catch {
      return undefined;
    }
    // file:///C:/x -> /C:/x
    if (/^\/[A-Za-z]:/.test(value)) value = value.slice(1);
  }

  value = value.replace(/^"(.*)"$/, '$1');

  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    value = path.join(os.homedir(), value.slice(1));
  }

  if (isRemoteLike(value)) return undefined;

  if (process.platform === 'win32') {
    const cygwin = /^\/cygdrive\/([A-Za-z])(\/.*)?$/.exec(value);
    if (cygwin) value = `${cygwin[1].toUpperCase()}:${cygwin[2] ?? '\\'}`;
    const msys = /^\/([A-Za-z])(\/.*)?$/.exec(value);
    if (msys) value = `${msys[1].toUpperCase()}:${msys[2] ?? '\\'}`;
  } else {
    // En POSIX "//x" es una ruta normal, pero path.resolve la conserva tal cual.
    value = value.replace(/^\/{2,}/, '/');
  }

  if (!path.isAbsolute(value)) return undefined;
  const resolved = path.resolve(value);
  // path.resolve puede volver a producir una ruta UNC a partir de una relativa.
  if (isRemoteLike(resolved)) return undefined;
  try {
    return fs.statSync(resolved).isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/** Devuelve la rama del directorio, subiendo por los padres hasta encontrar .git. */
export function readGitInfo(cwd: string): GitInfo | undefined {
  let dir = path.resolve(cwd);
  if (isRemoteLike(dir)) return undefined;
  for (let i = 0; i < MAX_PARENTS; i++) {
    const gitDir = gitDirAt(dir);
    if (gitDir) {
      const head = readHead(gitDir);
      if (head) return { ...head, root: dir };
      return undefined;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Directorio .git común del repositorio que contiene `dir`, subiendo por los
 * padres. En un worktree el gitdir es .git/worktrees/<nombre> y los archivos
 * compartidos (info/exclude, objects) viven donde apunta commondir.
 */
export function gitCommonDir(dir: string): string | undefined {
  let current = path.resolve(dir);
  if (isRemoteLike(current)) return undefined;
  for (let i = 0; i < MAX_PARENTS; i++) {
    const gitDir = gitDirAt(current);
    if (gitDir) return commonDirOf(gitDir);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function commonDirOf(gitDir: string): string {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
  } catch {
    // Repositorio normal: no existe commondir.
    return gitDir;
  }
  if (!raw) return gitDir;
  const target = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(gitDir, raw);
  // El contenido lo escribe el repositorio, que puede no ser de fiar.
  return isRemoteLike(target) ? gitDir : target;
}

/** Ruta del gitdir si `dir` es la raíz de un repositorio o de un worktree. */
function gitDirAt(dir: string): string | undefined {
  const dotGit = path.join(dir, '.git');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return undefined;
  }
  if (stat.isDirectory()) return dotGit;
  if (!stat.isFile()) return undefined;

  // Worktree o submódulo: "gitdir: <ruta al gitdir real>".
  let content: string;
  try {
    content = fs.readFileSync(dotGit, 'utf8');
  } catch {
    return undefined;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(content);
  if (!match) return undefined;
  const target = match[1].trim();
  // Cualquiera que clone un repositorio elige este contenido: si apunta a una
  // ruta de red, leerla sería contactar con la máquina que él diga.
  if (!target || target.length > MAX_CWD_CHARS || isRemoteLike(target)) return undefined;
  const resolved = path.isAbsolute(target) ? path.normalize(target) : path.resolve(dir, target);
  return isRemoteLike(resolved) ? undefined : resolved;
}

function readHead(gitDir: string): { branch: string; detached: boolean } | undefined {
  let head: string;
  try {
    head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
  } catch {
    return undefined;
  }
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  // El nombre de la rama acaba en la interfaz: se acota para que no la desborde.
  if (ref) return { branch: ref[1].trim().slice(0, 120), detached: false };
  if (/^[0-9a-f]{7,40}$/i.test(head)) return { branch: head.slice(0, 8), detached: true };
  return undefined;
}
