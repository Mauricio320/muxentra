// Guarda la imagen del portapapeles como archivo dentro del proyecto y devuelve
// su ruta, para poder pasársela a un CLI que corre dentro de la terminal.
// En Windows la imagen se lee con System.Windows.Forms.Clipboard desde
// PowerShell; en macOS con AppleScript a través de osascript.

import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { gitCommonDir } from './git';
import { log } from './log';
import { workingDirectory } from './ptyClient';

const DEFAULT_DIR = '.muxentra-img';
const DEFAULT_MAX = 6;
const READ_TIMEOUT_MS = 8000;

/** Extensiones que se aceptan cuando el portapapeles trae un archivo en vez de un mapa de bits. */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
/** Archivos que crea esta función; la limpieza solo borra los que encajan. */
const SAVED_NAME = /^img-\d{8}-\d{6}(?:-\d+)?\.(?:png|jpe?g|gif|webp|bmp|svg)$/i;

export interface SavedImage {
  /** Ruta absoluta del archivo guardado. */
  absolute: string;
  /** Ruta relativa a la raíz del proyecto, siempre con "/". */
  relative: string;
}

/**
 * Vuelca la imagen del portapapeles en la carpeta temporal del proyecto.
 * Devuelve undefined si el portapapeles no trae ninguna imagen.
 */
export async function saveClipboardImage(): Promise<SavedImage | undefined> {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    throw new Error('pegar imágenes del portapapeles solo está disponible en Windows y macOS.');
  }

  const cfg = vscode.workspace.getConfiguration('muxentra');
  const max = Math.max(1, Math.floor(cfg.get<number>('imagePasteMax') ?? DEFAULT_MAX));

  const root = workingDirectory();
  const dirName = safeDirName(cfg.get<string>('imagePasteDir'), root);
  const dir = path.join(root, dirName);
  fs.mkdirSync(dir, { recursive: true });

  const target = freeName(dir, '.png');
  const result = process.platform === 'win32' ? await readClipboardWindows(target) : await readClipboardMac(target);

  let absolute: string | undefined;
  if (result === 'image') {
    absolute = target;
  } else if (result.startsWith('file:')) {
    absolute = copyFromDisk(dir, result.slice('file:'.length));
  }

  // Pegar dos veces lo mismo reutiliza el archivo que ya estaba.
  if (absolute) {
    const twin = findTwin(dir, absolute);
    if (twin) {
      try {
        fs.unlinkSync(absolute);
      } catch {
        // Si no se puede borrar la copia, al menos se devuelve la original.
      }
      touch(twin);
      absolute = twin;
    }
  }

  if (!absolute) {
    // No dejar la carpeta creada si no se guardó nada.
    try {
      fs.rmdirSync(dir);
    } catch {
      // Tenía archivos de pegados anteriores.
    }
    return undefined;
  }

  ensureGitExclude(root, dirName);
  prune(dir, max);
  return { absolute, relative: path.relative(root, absolute).split(path.sep).join('/') };
}

/**
 * La carpeta sale de la configuración, que un repositorio puede fijar en su
 * .vscode/settings.json. Se exige que quede dentro del proyecto y sin
 * caracteres de control: con ".." las capturas se guardarían (y se borrarían)
 * fuera del workspace, y con un salto de línea se colarían reglas extra en
 * .git/info/exclude. Si el valor no sirve se usa el de por defecto.
 */
export function safeDirName(raw: string | undefined, root: string): string {
  const value = (raw ?? '').trim().replace(/[\\/]+$/, '');
  if (!value) return DEFAULT_DIR;
  // eslint-disable-next-line no-control-regex
  const rejected = /[\u0000-\u001f\u007f]/.test(value) || path.isAbsolute(value);
  if (!rejected) {
    const rel = path.relative(root, path.resolve(root, value));
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return rel.split(path.sep).join('/');
    }
  }
  log().warn(`imagePasteDir "${value}" no es una ruta válida dentro del proyecto; se usa ${DEFAULT_DIR}`);
  return DEFAULT_DIR;
}

// ---------------------------------------------------------------- portapapeles

/**
 * Pide la imagen a Windows PowerShell. Devuelve 'image' si la guardó en `dest`,
 * 'file:<ruta>' si el portapapeles traía un archivo, o 'none'.
 */
function readClipboardWindows(dest: string): Promise<string> {
  const script = `$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$dest='${dest.replace(/'/g, "''")}'
if ([Windows.Forms.Clipboard]::ContainsImage()) {
  $img=[Windows.Forms.Clipboard]::GetImage()
  $img.Save($dest,[Drawing.Imaging.ImageFormat]::Png)
  $img.Dispose()
  'image'
} elseif ([Windows.Forms.Clipboard]::ContainsFileDropList()) {
  $f=[Windows.Forms.Clipboard]::GetFileDropList() | Select-Object -First 1
  if ($f -and (Test-Path -LiteralPath $f)) { "file:$f" } else { 'none' }
} else { 'none' }`;

  const args = ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  return new Promise<string>((resolve, reject) => {
    cp.execFile(
      powershellPath(),
      args,
      { windowsHide: true, timeout: READ_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(firstLine(stderr) || err.message));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

/**
 * Lo mismo en macOS. AppleScript convierte el portapapeles a PNG ("class PNGf")
 * y lo escribe; si no hay imagen pero sí un archivo copiado en Finder
 * ("class furl"), devuelve su ruta. El guion va por la entrada estándar y la
 * ruta se interpola citada, que en AppleScript se escapa igual que en JSON.
 */
function readClipboardMac(dest: string): Promise<string> {
  const script = `set destPath to ${JSON.stringify(dest)}
try
  set imageData to (the clipboard as «class PNGf»)
on error
  try
    return "file:" & (POSIX path of (the clipboard as «class furl»))
  on error
    return "none"
  end try
end try
set fileRef to (open for access (POSIX file destPath) with write permission)
try
  set eof fileRef to 0
  write imageData to fileRef
  close access fileRef
on error errMsg
  try
    close access fileRef
  end try
  error errMsg
end try
return "image"`;

  return new Promise<string>((resolve, reject) => {
    const child = cp.execFile(
      '/usr/bin/osascript',
      ['-'],
      { timeout: READ_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(firstLine(stderr) || err.message));
          return;
        }
        resolve(stdout.trim());
      },
    );
    child.stdin?.end(script, 'utf8');
  });
}

/**
 * Windows PowerShell 5.1, no pwsh 7: este último arranca en MTA y
 * Clipboard::GetImage() exige un hilo STA.
 */
function powershellPath(): string {
  const full = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(full) ? full : 'powershell.exe';
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? '';
}

// ---------------------------------------------------------------- archivos

/** Copia a la carpeta un archivo de imagen que venía en el portapapeles. */
function copyFromDisk(dir: string, source: string): string | undefined {
  const ext = path.extname(source).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) return undefined;
  const target = freeName(dir, ext);
  try {
    fs.copyFileSync(source, target);
    return target;
  } catch {
    return undefined;
  }
}

/** img-20260920-154101.png, con sufijo -2, -3… si ya existe. */
function freeName(dir: string, ext: string): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  for (let i = 1; i < 100; i++) {
    const name = i === 1 ? `img-${stamp}${ext}` : `img-${stamp}-${i}${ext}`;
    const full = path.join(dir, name);
    if (!fs.existsSync(full)) return full;
  }
  return path.join(dir, `img-${stamp}-${Date.now()}${ext}`);
}

/** Imagen ya guardada con el mismo contenido que `file`, si la hay. */
function findTwin(dir: string, file: string): string | undefined {
  const size = statSize(file);
  const hash = size > 0 ? hashOf(file) : '';
  if (!hash) return undefined;

  for (const name of readDirSafe(dir)) {
    if (!SAVED_NAME.test(name)) continue;
    const full = path.join(dir, name);
    if (path.resolve(full) === path.resolve(file)) continue;
    if (statSize(full) !== size) continue;
    if (hashOf(full) === hash) return full;
  }
  return undefined;
}

function hashOf(file: string): string {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return '';
  }
}

/** Marca la imagen como la más reciente, para que la limpieza no se la lleve. */
function touch(file: string): void {
  try {
    const now = new Date();
    fs.utimesSync(file, now, now);
  } catch {
    // La fecha no es crítica.
  }
}

/** Deja solo las `max` imágenes más recientes. */
function prune(dir: string, max: number): void {
  try {
    const files = readDirSafe(dir)
      .filter(name => SAVED_NAME.test(name))
      .map(name => {
        const full = path.join(dir, name);
        return { full, mtime: statMtime(full) };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const file of files.slice(max)) {
      try {
        fs.unlinkSync(file.full);
      } catch {
        // Puede estar abierta en otro programa; se reintenta en el próximo pegado.
      }
    }
  } catch {
    // Sin permisos para listar: no pasa nada, solo no se limpia.
  }
}

function readDirSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function statMtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function statSize(file: string): number {
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
function ensureGitExclude(root: string, dirName: string): void {
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
    fs.appendFileSync(file, `${prefix}# Muxentra: imágenes pegadas desde el portapapeles\n${dirName}/\n`, 'utf8');
  } catch {
    // Que no se pueda escribir el exclude no debe impedir pegar la imagen.
  }
}
