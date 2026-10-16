// Deja un archivo a mano del CLI que corre en la terminal. Si ya vive dentro
// del proyecto basta con su ruta; si viene de fuera (arrastrado desde el
// explorador del sistema, donde el webview solo recibe el contenido y no la
// ruta) se copia a una carpeta de trabajo ignorada por git.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ensureGitExclude, freeName, hashOf, relativeTo, safeDirName, touch, type SavedFile } from './projectFiles';
import { workingDirectory } from './ptyClient';

const DEFAULT_DIR = '.muxentra-files';
const DEFAULT_MAX_MB = 10;
/** Nombres de dispositivo de Windows: un archivo así no se puede crear. */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const MAX_NAME = 120;

/** Tamaño máximo que el webview puede mandar de un archivo soltado. */
export function attachLimitBytes(): number {
  const mb = vscode.workspace.getConfiguration('muxentra').get<number>('filePasteMaxMB') ?? DEFAULT_MAX_MB;
  return Math.max(1, mb) * 1024 * 1024;
}

/**
 * Referencia un archivo que ya está en disco. Dentro del proyecto se usa tal
 * cual; fuera se copia, porque un agente no suele poder leer rutas de afuera
 * del workspace sin pedir permiso.
 */
export function attachPath(absolute: string): SavedFile {
  if (!fs.existsSync(absolute)) throw new Error(`${path.basename(absolute)} ya no está en disco`);

  const root = workingDirectory();
  const relative = relativeTo(root, absolute);
  if (relative !== absolute) return { absolute, relative };

  if (fs.statSync(absolute).isDirectory()) {
    throw new Error(`${path.basename(absolute)} es una carpeta de fuera del proyecto`);
  }
  return store(path.basename(absolute), target => fs.copyFileSync(absolute, target), hashOf(absolute));
}

/** Guarda en el proyecto el contenido de un archivo soltado en la terminal. */
export function attachBytes(name: string, data: Buffer): SavedFile {
  return store(name, target => fs.writeFileSync(target, data), sha1(data));
}

/**
 * Escribe el archivo en la carpeta de trabajo conservando su nombre, que es
 * parte de lo que el agente va a leer. Soltar dos veces lo mismo reutiliza el
 * archivo que ya estaba en vez de dejar un "contrato-2.ts" al lado.
 */
function store(rawName: string, write: (target: string) => void, hash: string): SavedFile {
  const root = workingDirectory();
  const dirName = safeDirName(vscode.workspace.getConfiguration('muxentra').get<string>('filePasteDir'), root, DEFAULT_DIR);
  const dir = path.join(root, dirName);
  fs.mkdirSync(dir, { recursive: true });

  const name = safeFileName(rawName);
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);

  let target = path.join(dir, name);
  if (fs.existsSync(target)) {
    if (hash && hashOf(target) === hash) {
      touch(target);
      ensureGitExclude(root, dirName, 'Muxentra: archivos soltados en la terminal');
      return { absolute: target, relative: relativeTo(root, target) };
    }
    target = freeName(dir, base, ext);
  }

  write(target);
  ensureGitExclude(root, dirName, 'Muxentra: archivos soltados en la terminal');
  return { absolute: target, relative: relativeTo(root, target) };
}

/**
 * El nombre llega del navegador y acaba siendo una ruta: se queda solo con el
 * último tramo y se le quitan los caracteres que Windows no acepta, los puntos
 * y espacios del final (que el sistema recorta en silencio) y los nombres de
 * dispositivo reservados.
 */
export function safeFileName(raw: string): string {
  const last = raw.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = last.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (!clean || clean === '.' || clean === '..') return 'archivo';

  const ext = path.extname(clean).slice(0, 16);
  const base = clean.slice(0, clean.length - path.extname(clean).length) || 'archivo';
  const safeBase = RESERVED.test(base) ? `_${base}` : base;
  return `${safeBase.slice(0, MAX_NAME - ext.length)}${ext}`;
}

function sha1(data: Buffer): string {
  return crypto.createHash('sha1').update(data).digest('hex');
}
