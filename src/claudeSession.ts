import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface TerminalLaunch {
  pid: number;
  startedAt: number;
  file: string;
  claudeHome: string;
  claudeConfigFile?: string;
  resumeSource?: { sessionId: string; transcript: string };
}

export interface ClaudeSession {
  pid: number;
  sessionId: string;
  cwd: string;
  executable: string;
  transcript: string;
  idle: boolean;
}

export interface ProcessInfo { pid: number; ppid: number; executable: string; startedAt: number }

export function runFile(file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      // Never surface stdout/stderr: auth commands can contain account information.
      if (error) reject(new Error(`No se pudo ejecutar ${path.basename(file)} (${error.code ?? 'error'}).`));
      else resolve(stdout);
    });
  });
}

export async function processTree(): Promise<ProcessInfo[]> {
  if (process.platform === 'win32') {
    const script = 'Get-CimInstance Win32_Process | ForEach-Object { [PSCustomObject]@{pid=$_.ProcessId;ppid=$_.ParentProcessId;executable=$_.ExecutablePath;startedAt=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()} } | ConvertTo-Json -Compress';
    const text = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    const values = JSON.parse(text);
    return (Array.isArray(values) ? values : [values]).filter(item => typeof item.executable === 'string');
  }
  const text = await runFile('ps', ['-axo', 'pid=,ppid=,lstart=,comm=']);
  return text.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/.exec(line);
    if (!match) return [];
    let executable = match[4];
    if (process.platform === 'linux') {
      try { executable = fs.readlinkSync(`/proc/${match[1]}/exe`); } catch { return []; }
    }
    return [{ pid: Number(match[1]), ppid: Number(match[2]), startedAt: Date.parse(match[3]), executable }];
  });
}

function descendant(proc: ProcessInfo, root: number, tree: Map<number, ProcessInfo>): boolean {
  const seen = new Set<number>();
  while (!seen.has(proc.pid)) {
    if (proc.pid === root) return true;
    seen.add(proc.pid);
    const parent = tree.get(proc.ppid);
    if (!parent || parent.startedAt > proc.startedAt + 1000) return false;
    proc = parent;
  }
  return false;
}

/** Match PID ancestry and process creation time, never a title or the latest conversation. */
export function findClaudeSession(launch: TerminalLaunch, processes: ProcessInfo[]): ClaudeSession | undefined {
  const tree = new Map(processes.map(proc => [proc.pid, proc]));
  const root = tree.get(launch.pid);
  if (!root || Math.abs(root.startedAt - launch.startedAt) > 10000) return undefined;
  const candidates: ClaudeSession[] = [];
  for (const proc of processes) {
    if (!descendant(proc, launch.pid, tree)) continue;
    let session: Record<string, unknown>;
    try { session = JSON.parse(fs.readFileSync(path.join(launch.claudeHome, 'sessions', `${proc.pid}.json`), 'utf8')); }
    catch { continue; }
    if (session.pid !== proc.pid || session.kind !== 'interactive' || session.entrypoint !== 'cli' ||
      typeof session.sessionId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(session.sessionId) ||
      typeof session.cwd !== 'string' || !path.isAbsolute(session.cwd) ||
      typeof session.startedAt !== 'number' || session.startedAt < proc.startedAt - 1000) continue;
    if (process.platform === 'win32' && typeof session.procStart === 'string' && /^\d+$/.test(session.procStart)) {
      const nativeStart = Number((BigInt(session.procStart) - 116444736000000000n) / 10000n);
      if (Math.abs(nativeStart - proc.startedAt) > 1000) continue;
    }
    // Old npm/Node entrypoints need their script arguments; do not guess them.
    if (/^(node|electron|code)(\.exe)?$/i.test(path.basename(proc.executable))) continue;
    const projects = path.join(launch.claudeHome, 'projects');
    const transcripts: string[] = [];
    try {
      for (const entry of fs.readdirSync(projects, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = path.join(projects, entry.name, `${session.sessionId}.jsonl`);
        if (fs.existsSync(file) && fs.statSync(file).isFile() && fs.statSync(file).size > 0) transcripts.push(file);
      }
    } catch { /* A resumed session may not have written a destination transcript yet. */ }
    if (!transcripts.length && launch.resumeSource?.sessionId === session.sessionId &&
      path.isAbsolute(launch.resumeSource.transcript)) {
      try {
        if (fs.statSync(launch.resumeSource.transcript).isFile()) transcripts.push(launch.resumeSource.transcript);
      } catch { /* The original transcript was removed. */ }
    }
    if (transcripts.length !== 1) continue;
    candidates.push({ pid: proc.pid, executable: proc.executable, sessionId: session.sessionId,
      cwd: session.cwd, transcript: transcripts[0], idle: session.status === 'idle' });
  }
  // Nested interactive agents are ambiguous. Leave the terminal untouched.
  return candidates.length === 1 ? candidates[0] : undefined;
}

export async function accountReady(session: ClaudeSession, env: Record<string, string>): Promise<boolean> {
  const result = JSON.parse(await runFile(session.executable, ['auth', 'status', '--json'], { cwd: session.cwd, env }));
  return result.loggedIn === true;
}
