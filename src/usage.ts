// Claude combina una lectura puntual de la cuenta con sus caches locales;
// Codex se lee de sus sesiones en disco. Si falta un porcentaje vigente,
// se indica como pendiente en vez de inventar consumo.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { UsageItem, UsageSnapshot, UsageWindow } from './protocol';

const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const CODEX_HOME = path.join(os.homedir(), '.codex');

/** A partir de esta edad se identifica el dato como antiguo, sin ocultarlo. */
const CLAUDE_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const CLAUDE_SESSION_MAX_AGE_MS = 8 * 60 * 1000;
const CLAUDE_TOKEN_WINDOW_MS = 5 * 60 * 60 * 1000;

export function readUsage(
  homes = { claude: CLAUDE_HOME, codex: CODEX_HOME },
  liveClaude?: UsageItem,
): UsageSnapshot {
  const items: UsageItem[] = [];
  for (const id of ['claude', 'codex'] as const) {
    const item = safe(() => id === 'claude' ? readClaude(homes.claude, liveClaude) : readCodex(homes.codex), id);
    items.push(item ?? { id, label: id === 'claude' ? 'Claude' : 'Codex', windows: [], detail: 'Sin datos de cuota' });
  }
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
    scoped?: { label: string; utilization: number; resetsAt?: number }[];
    limitStatus?: string;
  };
}

interface ClaudeNativeLimit {
  kind?: string;
  percent?: number;
  resets_at?: string;
  scope?: { model?: { display_name?: string } };
}

interface ClaudeNativeUsage {
  fetchedAtMs?: number;
  utilization?: {
    five_hour?: { utilization?: number; resets_at?: string };
    seven_day?: { utilization?: number; resets_at?: string };
    limits?: ClaudeNativeLimit[];
  };
}

function readClaude(home: string, live?: UsageItem): UsageItem | undefined {
  const sources: UsageItem[] = [];
  if (live?.id === 'claude') sources.push(refreshClaudeLive(live));
  // /usage conserva las mismas ventanas y nombres que muestra Claude. Las
  // cabeceras del statusLine pueden ser parciales o diferir en el redondeo.
  for (const read of [readClaudeNativeCache, readClaudeStatusline, readClaudeCache]) {
    try {
      const item = read(home);
      if (item) sources.push(item);
    } catch {
      // Una fuente puede estar a medio escribir sin invalidar las demás.
    }
  }
  if (!sources.length) return readClaudeTokens(home);
  const windows = new Map<string, UsageWindow>();
  let selectedAt: number | undefined;
  for (const source of sources) {
    for (const window of source.windows) {
      const previous = windows.get(window.label);
      // Las fuentes de respaldo completan ventanas ausentes o caducadas;
      // nunca reemplazan una lectura válida de /usage por una cabecera parcial.
      if (!previous || (previous.stale && !window.stale && window.percent !== undefined)) {
        windows.set(window.label, window);
        selectedAt = Math.max(selectedAt ?? 0, source.updatedAt ?? 0);
      }
    }
  }
  const merged = [...windows.values()];
  return {
    id: 'claude', label: 'Claude', windows: merged,
    updatedAt: selectedAt || undefined,
    detail: merged.every(window => window.stale || window.percent === undefined)
      ? 'Sin actualizar' : sources[0].detail === 'Sin actualizar' ? undefined : sources[0].detail,
  };
}

function refreshClaudeLive(item: UsageItem): UsageItem {
  const age = Date.now() - (item.updatedAt ?? 0);
  return {
    ...item,
    windows: item.windows.map(window => {
      if (window.resetsAt !== undefined && window.resetsAt <= Date.now() / 1000) {
        return { label: window.label, stale: true };
      }
      if (age > CLAUDE_CACHE_MAX_AGE_MS || (window.label === '5h' && age > CLAUDE_SESSION_MAX_AGE_MS)) {
        return { ...window, percent: undefined, stale: true };
      }
      return window;
    }),
  };
}

/** Consulta el mismo uso de la cuenta que muestra Claude, sin guardar el token ni la respuesta. */
export async function fetchClaudeUsage(
  home = CLAUDE_HOME,
  request: typeof fetch = fetch,
): Promise<UsageItem | undefined> {
  try {
    const credentials = JSON.parse(fs.readFileSync(path.join(home, '.credentials.json'), 'utf8')) as {
      claudeAiOauth?: { accessToken?: unknown };
    };
    const token = credentials.claudeAiOauth?.accessToken;
    if (typeof token !== 'string' || !token) return undefined;
    const response = await request('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return undefined;
    const utilization = await response.json() as ClaudeNativeUsage['utilization'];
    return claudeNativeItem({ fetchedAtMs: Date.now(), utilization });
  } catch {
    return undefined;
  }
}

/**
 * Cache que escribe la extensión de estado de Claude a partir de las cabeceras
 * de límite de la API. Se conserva como respaldo de las fuentes nativas.
 */
function readClaudeCache(home: string): UsageItem | undefined {
  const file = path.join(home, 'vscode-claude-status-cache.json');
  if (!fs.existsSync(file)) return undefined;
  const cache = JSON.parse(fs.readFileSync(file, 'utf8')) as ClaudeCache;
  return claudeCacheItem(cache);
}

/** Cuotas recibidas del JSON oficial de statusLine, sin credenciales ni peticiones. */
function readClaudeStatusline(home: string): UsageItem | undefined {
  const file = path.join(home, 'muxentra-usage.json');
  if (!fs.existsSync(file)) return undefined;
  return claudeCacheItem(JSON.parse(fs.readFileSync(file, 'utf8')) as ClaudeCache);
}

/** Claude actualiza esta copia al consultar /usage; fetchedAtMs es la fecha del dato. */
function readClaudeNativeCache(home: string): UsageItem | undefined {
  const file = home === CLAUDE_HOME
    ? path.join(os.homedir(), '.claude.json') : path.join(home, '.claude.json');
  if (!fs.existsSync(file)) return undefined;
  const data = JSON.parse(fs.readFileSync(file, 'utf8')).cachedUsageUtilization as ClaudeNativeUsage | undefined;
  return claudeNativeItem(data);
}

function claudeNativeItem(data: ClaudeNativeUsage | undefined): UsageItem | undefined {
  if (!data || typeof data.fetchedAtMs !== 'number' || !Number.isFinite(data.fetchedAtMs)) return undefined;
  const usage = data.utilization;
  const limits = Array.isArray(usage?.limits) ? usage.limits : [];
  const session = limits.find(limit => limit?.kind === 'session');
  const weekly = limits.find(limit => limit?.kind === 'weekly_all');
  const percent = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value / 100 : undefined;
  const reset = (value: unknown): number | undefined =>
    typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) / 1000 : undefined;
  const scoped = limits.flatMap(limit => {
    if (limit?.kind !== 'weekly_scoped') return [];
    const label = limit.scope?.model?.display_name;
    const utilization = percent(limit.percent);
    if (typeof label !== 'string' || !label.trim() || utilization === undefined) return [];
    return [{ label: label.trim(), utilization, resetsAt: reset(limit.resets_at) }];
  });
  return claudeCacheItem({
    updatedAt: new Date(data.fetchedAtMs).toISOString(),
    usageData: {
      utilization5h: percent(session?.percent ?? usage?.five_hour?.utilization),
      reset5hAt: reset(session?.resets_at ?? usage?.five_hour?.resets_at),
      utilization7d: percent(weekly?.percent ?? usage?.seven_day?.utilization),
      reset7dAt: reset(weekly?.resets_at ?? usage?.seven_day?.resets_at),
      scoped,
    },
  });
}

function claudeCacheItem(cache: ClaudeCache): UsageItem | undefined {
  const data = cache.usageData;
  if (!data) return undefined;

  const updatedAt = cache.updatedAt ? Date.parse(cache.updatedAt) : NaN;
  const outdated = !Number.isFinite(updatedAt) || Date.now() - updatedAt > CLAUDE_CACHE_MAX_AGE_MS;

  // El cache solo se reescribe cuando la extensión de Claude vuelve a consultar
  // la API. Si una ventana ya se reinició desde entonces, su porcentaje es de
  // antes del reinicio y engaña: se muestra pendiente y sin cuenta atrás hasta
  // que llegue un dato nuevo.
  const nowSec = Date.now() / 1000;
  const windows: UsageWindow[] = [];
  const rolled: string[] = [];
  const add = (label: string, utilization: unknown, resetsAt: unknown): void => {
    if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return;
    const reset = typeof resetsAt === 'number' && Number.isFinite(resetsAt) ? resetsAt : undefined;
    if (reset !== undefined && reset <= nowSec) {
      windows.push({ label, stale: true });
      rolled.push(label);
      return;
    }
    const sessionOutdated = label === '5h' && (!Number.isFinite(updatedAt) || Date.now() - updatedAt > CLAUDE_SESSION_MAX_AGE_MS);
    windows.push({
      label,
      percent: sessionOutdated ? undefined : clamp01(utilization),
      resetsAt: reset,
      stale: outdated || sessionOutdated || undefined,
    });
  };
  add('5h', data.utilization5h, data.reset5hAt);
  add('7d', data.utilization7d, data.reset7dAt);
  for (const scoped of data.scoped ?? []) add(scoped.label, scoped.utilization, scoped.resetsAt);
  if (windows.length === 0) return undefined;

  return {
    id: 'claude',
    label: 'Claude',
    windows,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : undefined,
    // El aviso de límite acompaña al porcentaje viejo; sin él no dice nada.
    detail: outdated ? 'Sin actualizar' : rolled.length
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
function readClaudeTokens(home: string): UsageItem | undefined {
  const projects = path.join(home, 'projects');
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
function readCodex(home: string): UsageItem | undefined {
  const sessions = path.join(home, 'sessions');
  if (!fs.existsSync(sessions)) return undefined;
  // Abrir una sesión crea el archivo antes del primer evento de límites.
  // Consultar también sesiones anteriores evita que desaparezca el indicador.
  const candidates = newestFiles(sessions, name => name.startsWith('rollout-') && name.endsWith('.jsonl'));
  for (const candidate of candidates) {
    const item = readCodexFile(candidate);
    if (item) return item;
  }
  return undefined;
}

function readCodexFile(candidate: { file: string; mtime: number }): UsageItem | undefined {
  const lines = readTail(candidate.file, 1024 * 1024).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"rate_limits"')) continue;
    let limits: CodexRateLimits | undefined;
    let updatedAt: number | undefined;
    try {
      const event = JSON.parse(line);
      limits = findRateLimits(event);
      const timestamp = typeof event?.timestamp === 'string' ? Date.parse(event.timestamp) : NaN;
      updatedAt = Number.isFinite(timestamp) ? timestamp : undefined;
    } catch {
      continue;
    }
    if (!limits) continue;

    const windows: UsageWindow[] = [];
    for (const w of [limits.primary, limits.secondary]) {
      if (!w || typeof w.used_percent !== 'number' || !Number.isFinite(w.used_percent)) continue;
      const reset = typeof w.resets_at === 'number' && Number.isFinite(w.resets_at) ? w.resets_at : undefined;
      const expired = reset !== undefined && reset <= Date.now() / 1000;
      windows.push({
        label: windowLabel(w.window_minutes),
        percent: expired ? undefined : clamp01(w.used_percent / 100),
        resetsAt: expired ? undefined : reset,
        stale: expired || undefined,
      });
    }
    if (windows.length === 0) continue;
    return {
      id: 'codex',
      label: 'Codex',
      windows,
      plan: limits.plan_type ?? undefined,
      updatedAt,
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

/** Candidatos recientes, con recorrido y lecturas acotados. */
function newestFiles(
  root: string,
  match: (name: string) => boolean,
  depth = 0,
): { file: string; mtime: number }[] {
  if (depth > 6) return [];
  const files: { file: string; mtime: number }[] = [];
  const dirs: { dir: string; mtime: number }[] = [];

  for (const entry of readDirSafe(root)) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      dirs.push({ dir: full, mtime: statMtime(full) });
    } else if (entry.isFile() && match(entry.name)) {
      const mtime = statMtime(full);
      files.push({ file: full, mtime });
    }
  }

  // Solo se desciende por las carpetas más recientes: las sesiones se guardan por fecha.
  dirs.sort((a, b) => b.mtime - a.mtime);
  for (const { dir } of dirs.slice(0, 3)) {
    files.push(...newestFiles(dir, match, depth + 1));
  }
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, 12);
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
