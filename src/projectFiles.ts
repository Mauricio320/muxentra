// Lo común a todo lo que Muxentra deja caer dentro del proyecto para poder
// pasárselo a un CLI que corre en la terminal: una carpeta de trabajo ignorada
// por git, nombres que no pisan los que ya están y una poda opcional.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { gitCommonDir } from './git';
import { log } from './log';

export interface SavedFile {
  /** Ruta absoluta del archivo. */
  absolute: string;
  /** Ruta relativa a la raíz del proyecto, siempre con "/". */
  relative: string;
}

/**
 * La carpeta sale de la configuración, que un repositorio puede fijar en su
 * .vscode/settings.json. Se exige que quede dentro del proyecto y sin
 * caracteres de control: con ".." los archivos se guardarían (y se borrarían)
 * fuera del workspace, y con un salto de línea se colarían reglas extra en
 * .git/info/exclude. Si el valor no sirve se usa el de por defecto.
 */
export function safeDirName(raw: string | undefined, root: string, fallback: string): string {
  const value = (raw ?? '').trim().replace(/[\\/]+$/, '');
  if (!value) return fallback;
  // eslint-disable-next-line no-control-regex
  const rejected = /[\u0000-\u001f\u007f]/.test(value) || path.isAbsolute(value);
  if (!rejected) {
    const rel = path.relative(root, path.resolve(root, value));
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return rel.split(path.sep).join('/');
    }
  }
  log().warn(`"${value}" no es una ruta válida dentro del proyecto; se usa ${fallback}`);
  return fallback;
}

/** `base.ext` dentro de `dir`, con sufijo -2, -3… si ese nombre ya está tomado. */
export function freeName(dir: string, base: string, ext: string): string {
  for (let i = 1; i < 100; i++) {
    const name = i === 1 ? `${base}${ext}` : `${base}-${i}${ext}`;
    const full = path.join(dir, name);
    if (!fs.existsSync(full)) return full;
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

/** Ruta relativa al proyecto; absoluta cuando el archivo queda fuera de él. */
export function relativeTo(root: string, absolute: string): string {
  const rel = path.relative(root, absolute);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return absolute;
  return rel.split(path.sep).join('/');
}

/**
 * Cómo se escribe una ruta en la línea de comandos. Con un espacio dentro hay
 * que entrecomillarla: si no, el shell —y el agente que la lee— la parten en
 * dos argumentos.
 */
export function quotePath(value: string): string {
  return /\s/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/** Archivo ya guardado en `dir` con el mismo contenido que `file`, si lo hay. */
export function findTwin(dir: string, file: string, pattern: RegExp): string | undefined {
  const size = statSize(file);
  const hash = size > 0 ? hashOf(file) : '';
  if (!hash) return undefined;

  for (const name of readDirSafe(dir)) {
    if (!pattern.test(name)) continue;
    const full = path.join(dir, name);
    if (path.resolve(full) === path.resolve(file)) continue;
    if (statSize(full) !== size) continue;
    if (hashOf(full) === hash) return full;
  }
  return undefined;
}

export function hashOf(file: string): string {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return '';
  }
}

/** Marca el archivo como el más reciente, para que la poda no se lo lleve. */
export function touch(file: string): void {
  try {
    const now = new Date();
    fs.utimesSync(file, now, now);
  } catch {
    // La fecha no es crítica.
  }
}

/** Deja solo los `max` archivos más recientes de los que encajan con `pattern`. */
export function prune(dir: string, max: number, pattern: RegExp): void {
  try {
    const files = readDirSafe(dir)
      .filter(name => pattern.test(name))
      .map(name => {
        const full = path.join(dir, name);
        return { full, mtime: statMtime(full) };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const file of files.slice(max)) {
      try {
        fs.unlinkSync(file.full);
      } catch {
        // Puede estar abierto en otro programa; se reintenta la próxima vez.
      }
    }
  } catch {
    // Sin permisos para listar: no pasa nada, solo no se limpia.
  }
}

export function readDirSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

export function statMtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export function statSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Ignora la carpeta en .git/info/exclude: es una regla local del clon, así que
 * no aparece como cambio del repositorio ni la ve el resto del equipo.
 */
export function ensureGitExclude(root: string, dirName: string, comment: string): void {
  try {
    const common = gitCommonDir(root);
    if (!common) return;

    const file = path.join(common, 'info', 'exclude');
    let content = '';
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      // Todavía no existe.
    }

    const already = content.split(/\r?\n/).some(line => {
      const clean = line.trim().replace(/^\/+/, '').replace(/\/+$/, '');
      return clean === dirName;
    });
    if (already) return;

    fs.mkdirSync(path.dirname(file), { recursive: true });
    const prefix = content && !content.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(file, `${prefix}# ${comment}\n${dirName}/\n`, 'utf8');
  } catch {
    // Que no se pueda escribir el exclude no debe impedir guardar el archivo.
  }
}
