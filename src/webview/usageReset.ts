import type { UsageWindow } from '../protocol';

/** Only current provider timestamps are eligible; never infer a reset time. */
export function preferredUsageReset(windows: UsageWindow[], now = Date.now() / 1000): UsageWindow | undefined {
  const available = (window: UsageWindow): boolean => !window.stale
    && typeof window.resetsAt === 'number'
    && Number.isFinite(window.resetsAt)
    && window.resetsAt > now;
  return windows.find(window => window.label === '5h' && available(window))
    ?? windows.find(window => (window.label === '7d' || window.label === 'semana') && available(window));
}

/** Epoch seconds to a compact remaining duration, shared with usage details. */
export function formatReset(resetsAt: number | undefined, now = Date.now() / 1000): string | undefined {
  if (resetsAt === undefined || !Number.isFinite(resetsAt) || resetsAt <= 0) return undefined;
  const seconds = resetsAt - now;
  if (seconds <= 0) return 'ahora';
  if (seconds < 60) return '<1m';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
