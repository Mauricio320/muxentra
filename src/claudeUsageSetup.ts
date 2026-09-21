import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Explicit setup only: preserve the existing command and every other setting. */
export function installClaudeUsage(extensionRoot: string, home = path.join(os.homedir(), '.claude'), node = 'node'): void {
  const settingsFile = path.join(home, 'settings.json');
  const original = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : undefined;
  const settings = original ? JSON.parse(original) : {};
  const script = path.join(home, 'muxentra-statusline.cjs');
  const source = fs.readFileSync(path.join(extensionRoot, 'assets', 'claude-usage.cjs'));
  const quote = (value: string): string => `'${value.replace(/\\/g, '/').replace(/'/g, `'"'"'`)}'`;
  const command = `${quote(node)} ${quote(script)}`;
  const current = settings.statusLine?.command;
  const ours = typeof current === 'string' && current.includes(quote(script));
  if (settings.statusLine && settings.statusLine.type !== 'command') {
    throw new Error('La configuración statusLine existente no es de tipo command.');
  }
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(script, source);
  if (ours) return;
  settings.statusLine = {
    ...settings.statusLine,
    type: 'command',
    command: current ? `${command} --passthrough | ( ${current}\n)` : command,
  };
  // Keep a byte-for-byte backup and refuse to overwrite concurrent settings edits.
  if (original !== undefined) {
    fs.writeFileSync(`${settingsFile}.muxentra-${Date.now()}.bak`, original, { flag: 'wx', mode: 0o600 });
  }
  const latest = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : undefined;
  if (latest !== original) throw new Error('Claude cambió su configuración durante la instalación. Reintenta.');
  const temporary = `${settingsFile}.muxentra-${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, settingsFile);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* renamed */ }
  }
}
