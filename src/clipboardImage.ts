// Deja en el proyecto lo que haya en el portapapeles y devuelve su ruta, para
// poder pasársela a un CLI que corre dentro de la terminal. La imagen se guarda
// como archivo nuevo; si lo copiado es un archivo del explorador, se referencia
// ese archivo. En Windows el portapapeles se lee con System.Windows.Forms desde
// PowerShell; en macOS con AppleScript a través de osascript.

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { attachPath } from './attachedFile';
import { ensureGitExclude, findTwin, freeName, prune, relativeTo, safeDirName, touch, type SavedFile } from './projectFiles';
import { workingDirectory } from './ptyClient';

const DEFAULT_DIR = '.muxentra-img';
const DEFAULT_MAX = 6;
const READ_TIMEOUT_MS = 8000;

/** Archivos que crea esta función; la limpieza solo borra los que encajan. */
const SAVED_NAME = /^img-\d{8}-\d{6}(?:-\d+)?\.(?:png|jpe?g|gif|webp|bmp|svg)$/i;

export interface ClipboardAttachment extends SavedFile {
  /** `image` cuando se volcó un mapa de bits; `file` cuando se copió un archivo. */
  kind: 'image' | 'file';
}

/**
 * Vuelca el portapapeles en el proyecto. Devuelve undefined si no trae ni una
 * imagen ni un archivo.
 */
export async function saveClipboardAttachment(): Promise<ClipboardAttachment | undefined> {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    throw new Error('pegar imágenes y archivos del portapapeles solo está disponible en Windows y macOS.');
  }

  const cfg = vscode.workspace.getConfiguration('muxentra');
  const max = Math.max(1, Math.floor(cfg.get<number>('imagePasteMax') ?? DEFAULT_MAX));

  const root = workingDirectory();
  const dirName = safeDirName(cfg.get<string>('imagePasteDir'), root, DEFAULT_DIR);
  const dir = path.join(root, dirName);
  fs.mkdirSync(dir, { recursive: true });

  const target = freeName(dir, `img-${stamp()}`, '.png');
  const result = process.platform === 'win32' ? await readClipboardWindows(target) : await readClipboardMac(target);

  // Un archivo copiado en el explorador no se vuelca aquí: ya está en disco.
  if (result.startsWith('file:')) {
    cleanIfEmpty(dir);
    return { ...attachPath(result.slice('file:'.length)), kind: 'file' };
  }

  if (result !== 'image') {
    cleanIfEmpty(dir);
    return undefined;
  }

  // Pegar dos veces lo mismo reutiliza la imagen que ya estaba.
  let absolute = target;
  const twin = findTwin(dir, absolute, SAVED_NAME);
  if (twin) {
    try {
      fs.unlinkSync(absolute);
    } catch {
      // Si no se puede borrar la copia, al menos se devuelve la original.
    }
    touch(twin);
    absolute = twin;
  }

  ensureGitExclude(root, dirName, 'Muxentra: imágenes pegadas desde el portapapeles');
  prune(dir, max, SAVED_NAME);
  return { absolute, relative: relativeTo(root, absolute), kind: 'image' };
}

/** img-20260920-154101 */
function stamp(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** No deja la carpeta recién creada cuando al final no se guardó nada en ella. */
function cleanIfEmpty(dir: string): void {
  try {
    fs.rmdirSync(dir);
  } catch {
    // Tenía archivos de pegados anteriores.
  }
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
