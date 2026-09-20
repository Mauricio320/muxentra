// Lee el uso de Claude Code y de OpenAI Codex desde los datos que cada
// herramienta deja en el disco. Todo es de solo lectura y tolerante a fallos:
// si una fuente no existe, ese elemento simplemente no se muestra.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { UsageItem, UsageSnapshot, UsageWindow } from './protocol';

const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const CODEX_HOME = path.join(os.homedir(), '.codex');

/** Antigüedad máxima del cache de Claude antes de preferir el conteo local de tokens. */
const CLAUDE_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const CLAUDE_TOKEN_WINDOW_MS = 5 * 60 * 60 * 1000;

export function readUsage(): UsageSnapshot {
  const items: UsageItem[] = [];
  const claude = safe(readClaude, 'claude');
  if (claude) items.push(claude);
  const codex = safe(readCodex, 'codex');
  if (codex) items.push(codex);
  return { items, updatedAt: Date.now() };
}

function safe(fn: () => UsageItem | undefined, id: 'claude' | 'codex'): UsageItem | undefined {
  try {
    return fn();
  } catch (err) {
    return { id, label: id === 'claude' ? 'Claude' : 'Codex', windows: [], error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------- Claude

interface ClaudeCache {
  updatedAt?: string;
  usageData?: {
    utilization5h?: number;
    utilization7d?: number;
    reset5hAt?: number;
    reset7dAt?: number;
    limitStatus?: string;
  };
}

function readClaude(): UsageItem | undefined {
  const fromCache = readClaudeCache();
  if (fromCache) return fromCache;
  return readClaudeTokens();
}

/**
 * Cache que escribe la extensión de estado de Claude a partir de las cabeceras
 * de límite de la API. Es la única fuente local con el porcentaje real del plan.
 */
function readClaudeCache(): UsageItem | undefined {
  const file = path.join(CLAUDE_HOME, 'vscode-claude-status-cache.json');
  if (!fs.existsSync(file)) return undefined;
  const cache = JSON.parse(fs.readFileSync(file, 'utf8')) as ClaudeCache;
  const data = cache.usageData;
  if (!data) return undefined;

  const updatedAt = cache.updatedAt ? Date.parse(cache.updatedAt) : NaN;
  if (Number.isFinite(updatedAt) && Date.now() - updatedAt > CLAUDE_CACHE_MAX_AGE_MS) return undefined;

  // El cache solo se reescribe cuando la extensión de Claude vuelve a consultar
  // la API. Si una ventana ya se reinició desde entonces, su porcentaje es de
  // antes del reinicio y engaña: se muestra en cero y sin cuenta atrás hasta
  // que llegue un dato nuevo.
  const nowSec = Date.now() / 1000;
  const windows: UsageWindow[] = [];
  const rolled: string[] = [];
  const add = (label: string, utilization: unknown, resetsAt: unknown): void => {
    if (typeof utilization !== 'number') return;
    const reset = typeof resetsAt === 'number' ? resetsAt : undefined;
    if (reset !== undefined && reset <= nowSec) {
      windows.push({ label, percent: 0, stale: true });
      rolled.push(label);
      return;
    }
    windows.push({ label, percent: clamp01(utilization), resetsAt: reset });
  };
  add('5h', data.utilization5h, data.reset5hAt);
  add('7d', data.utilization7d, data.reset7dAt);
  if (windows.length === 0) return undefined;

  return {
    id: 'claude',
    label: 'Claude',
    windows,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : undefined,
    // El aviso de límite acompaña al porcentaje viejo; sin él no dice nada.
    detail: rolled.length
      ? `${rolled.join(' y ')} ${rolled.length > 1 ? 'reiniciadas' : 'reiniciada'}`
      : claudeLimitDetail(data.limitStatus),
  };
}

/** Convierte estados internos de Claude en mensajes breves para la interfaz. */
function claudeLimitDetail(status: string | undefined): string | undefined {
  switch (status?.trim().toLowerCase()) {
    case 'allowed_warning':
      return 'Uso elevado';
    case 'limit_reached':
    case 'rate_limited':
    case 'blocked':
      return 'Límite alcanzado';
    default:
      return undefined;
  }
}

/** Respaldo: suma los tokens de las transcripciones de las últimas 5 horas. */
function readClaudeTokens(): UsageItem | undefined {
  const projects = path.join(CLAUDE_HOME, 'projects');
  if (!fs.existsSync(projects)) return undefined;
  const since = Date.now() - CLAUDE_TOKEN_WINDOW_MS;

  const files: { file: string; mtime: number }[] = [];
  for (const dir of readDirSafe(projects)) {
    if (!dir.isDirectory()) continue;
    for (const entry of readDirSafe(path.join(projects, dir.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const file = path.join(projects, dir.name, entry.name);
      const mtime = statMtime(file);
      if (mtime >= since) files.push({ file, mtime });
    }
  }
  if (files.length === 0) return undefined;
  files.sort((a, b) => b.mtime - a.mtime);

  let tokens = 0;
  for (const { file } of files.slice(0, 12)) {
    for (const line of readTail(file, 2 * 1024 * 1024).split('\n')) {
      if (!line.includes('"usage"')) continue;
      let entry: { timestamp?: string; message?: { usage?: Record<string, unknown> } };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
      if (!Number.isFinite(ts) || ts < since) continue;
      const usage = entry.message?.usage;
      if (!usage) continue;
      tokens +=
        num(usage.input_tokens) +
        num(usage.output_tokens) +
        num(usage.cache_creation_input_tokens) +
        num(usage.cache_read_input_tokens);
    }
  }
  if (tokens === 0) return undefined;
  return { id: 'claude', label: 'Claude', windows: [], detail: `${formatTokens(tokens)} en 5 h` };
}

// ---------------------------------------------------------------- Codex

interface CodexRateLimits {
  primary?: CodexWindow | null;
  secondary?: CodexWindow | null;
  plan_type?: string | null;
}

interface CodexWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
}

/**
 * Codex escribe eventos token_count con rate_limits en el rollout de cada
 * sesión; se toma el último del archivo de sesión más reciente.
 */
function readCodex(): UsageItem | undefined {
  const sessions = path.join(CODEX_HOME, 'sessions');
  if (!fs.existsSync(sessions)) return undefined;
  const newest = newestFile(sessions, name => name.startsWith('rollout-') && name.endsWith('.jsonl'));
  if (!newest) return undefined;

  const lines = readTail(newest.file, 1024 * 1024).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"rate_limits"')) continue;
    let limits: CodexRateLimits | undefined;
    try {
      limits = findRateLimits(JSON.parse(line));
    } catch {
      continue;
    }
    if (!limits) continue;

    const windows: UsageWindow[] = [];
    for (const w of [limits.primary, limits.secondary]) {
      if (!w || typeof w.used_percent !== 'number') continue;
      windows.push({
        label: windowLabel(w.window_minutes),
        percent: clamp01(w.used_percent / 100),
        resetsAt: typeof w.resets_at === 'number' ? w.resets_at : undefined,
      });
    }
    if (windows.length === 0) continue;
    return {
      id: 'codex',
      label: 'Codex',
      windows,
      plan: limits.plan_type ?? undefined,
      updatedAt: newest.mtime,
    };
  }
  return undefined;
}

/** rate_limits puede venir anidado dentro del evento; se busca en profundidad acotada. */
function findRateLimits(node: unknown, depth = 0): CodexRateLimits | undefined {
  if (!node || typeof node !== 'object' || depth > 6) return undefined;
  const obj = node as Record<string, unknown>;
  const direct = obj.rate_limits;
  if (direct && typeof direct === 'object') return direct as CodexRateLimits;
  for (const value of Object.values(obj)) {
    const found = findRateLimits(value, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function windowLabel(minutes: number | undefined): string {
  if (!minutes || !Number.isFinite(minutes)) return 'uso';
  if (minutes >= 10080) return minutes === 10080 ? 'semana' : `${Math.round(minutes / 1440)}d`;
  if (minutes >= 1440) return `${Math.round(minutes / 1440)}d`;
  if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
  return `${minutes}m`;
}

// ---------------------------------------------------------------- utilidades

/** Busca el archivo más reciente que cumpla `match`, sin recorrer todo el árbol. */
function newestFile(
  root: string,
  match: (name: string) => boolean,
  depth = 0,
): { file: string; mtime: number } | undefined {
  if (depth > 6) return undefined;
  let best: { file: string; mtime: number } | undefined;
  const dirs: { dir: string; mtime: number }[] = [];

  for (const entry of readDirSafe(root)) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      dirs.push({ dir: full, mtime: statMtime(full) });
    } else if (entry.isFile() && match(entry.name)) {
      const mtime = statMtime(full);
      if (!best || mtime > best.mtime) best = { file: full, mtime };
    }
  }

  // Solo se desciende por las carpetas más recientes: las sesiones se guardan por fecha.
  dirs.sort((a, b) => b.mtime - a.mtime);
  for (const { dir } of dirs.slice(0, 3)) {
    const found = newestFile(dir, match, depth + 1);
    if (found && (!best || found.mtime > best.mtime)) best = found;
  }
  return best;
}

/** Últimos `maxBytes` del archivo, descartando la primera línea parcial. */
function readTail(file: string, maxBytes: number): string {
  const size = statSize(file);
  if (size === 0) return '';
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  const text = buffer.toString('utf8');
  if (start === 0) return text;
  const nl = text.indexOf('\n');
  return nl >= 0 ? text.slice(nl + 1) : '';
}

function readDirSafe(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
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

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tokens`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k tokens`;
  return `${tokens} tokens`;
}
