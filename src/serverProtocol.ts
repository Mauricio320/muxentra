// Protocolo entre la extensión (cliente) y el servidor de terminales (proceso aparte).
// Mensajes JSON separados por salto de línea sobre un named pipe / socket unix.
//
// El saludo es un reto-respuesta mutuo: cada lado demuestra que conoce el token
// compartido calculando un HMAC sobre dos nonces, uno de cada parte. Así el
// token nunca viaja por el canal y el cliente no le entrega nada (ni el entorno
// del shell, ni lo que se teclea) a un impostor que se haya adelantado a ocupar
// el nombre del pipe.

import * as crypto from 'crypto';
import type { TerminalGeometry, TerminalSnapshot } from './protocol';

export const PROTOCOL_VERSION = 2;

/** Longitud máxima de una línea mientras la conexión no está autenticada. */
export const MAX_HANDSHAKE_CHARS = 4 * 1024;
/** Longitud máxima de una línea ya autenticada; un pegado grande cabe aquí. */
export const MAX_LINE_CHARS = 8 * 1024 * 1024;
/** Tiempo que se le da a una conexión para completar el saludo. */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

export type ClientMessage =
  | { t: 'hello'; version: number; nonce: string; stateReplay?: boolean }
  | { t: 'auth'; proof: string }
  | {
      t: 'spawn';
      id: string;
      file: string;
      args: string[];
      cwd: string;
      env: Record<string, string>;
      cols: number;
      rows: number;
      scrollback?: number;
      useConptyDll?: boolean;
    }
  | { t: 'attach'; id: string; cols: number; rows: number; scrollback?: number }
  | { t: 'configure'; id: string; scrollback: number }
  | { t: 'input'; id: string; data: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'kill'; id: string }
  | { t: 'killAll' }
  | { t: 'shutdown' };

export type ServerMessage =
  | { t: 'challenge'; version: number; nonce: string; proof: string }
  | { t: 'welcome'; ok: boolean; alive: string[]; exited: string[]; error?: string; stateReplay?: boolean }
  | { t: 'spawned'; id: string; pid: number; geometry?: TerminalGeometry }
  | { t: 'spawnError'; id: string; message: string }
  | { t: 'attached'; id: string; found: boolean; data?: string; snapshot?: TerminalSnapshot }
  | { t: 'data'; id: string; data: string }
  | { t: 'exit'; id: string; code: number };

export function newNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

/** Prueba que demuestra conocer el token sin revelarlo. */
export function proofFor(
  token: string,
  role: 'server' | 'client',
  clientNonce: string,
  serverNonce: string,
): string {
  return crypto
    .createHmac('sha256', token)
    .update(`muxentra:${role}:${clientNonce}:${serverNonce}`)
    .digest('hex');
}

/** Comparación en tiempo constante, tolerante a valores que no son texto. */
export function sameProof(a: unknown, b: string): boolean {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** JSON.parse devuelve cualquier cosa; solo son mensajes los objetos con `t`. */
export function parseMessage(line: string): { t: string } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const t = (value as { t?: unknown }).t;
  return typeof t === 'string' ? (value as { t: string }) : undefined;
}
