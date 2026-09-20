import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export interface ShellSpec {
  path: string;
  args: string[];
}

/**
 * Resuelve el shell a lanzar: primero la configuración propia, luego el perfil
 * por defecto de VS Code (terminal.integrated.defaultProfile) y por último un
 * valor razonable para la plataforma.
 */
export function resolveShell(): ShellSpec {
  const cfg = vscode.workspace.getConfiguration('muxentra');
  const custom = (cfg.get<string>('shellPath') ?? '').trim();
  if (custom) {
    return { path: custom, args: cfg.get<string[]>('shellArgs') ?? [] };
  }
  return fromVsCodeProfile() ?? platformDefault();
}

type PlatformKey = 'windows' | 'osx' | 'linux';

function platformKey(): PlatformKey {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'osx';
  return 'linux';
}

interface ProfileLike {
  path?: string | string[];
  args?: string | string[];
  source?: string;
}

function fromVsCodeProfile(): ShellSpec | undefined {
  const term = vscode.workspace.getConfiguration('terminal.integrated');
  const key = platformKey();
  const name = term.get<string | null>(`defaultProfile.${key}`);
  if (!name) return undefined;

  const profiles = term.get<Record<string, ProfileLike | null>>(`profiles.${key}`) ?? {};
  const profile = profiles[name];
  if (profile && typeof profile === 'object') {
    if (profile.path) {
      const candidates = Array.isArray(profile.path) ? profile.path : [profile.path];
      const found = candidates.map(String).find(isExecutable);
      if (found) return { path: found, args: toArgs(profile.args) };
    }
    if (profile.source) return fromSource(profile.source, toArgs(profile.args));
  }
  // Perfiles integrados de VS Code que no aparecen en profiles.<plataforma>.
  return fromSource(name, []);
}

function fromSource(source: string, args: string[]): ShellSpec | undefined {
  if (process.platform !== 'win32') return undefined;
  switch (source) {
    case 'PowerShell':
      return { path: findPwsh() ?? 'powershell.exe', args };
    case 'Windows PowerShell':
      return { path: 'powershell.exe', args };
    case 'Command Prompt':
      return { path: process.env.COMSPEC || 'cmd.exe', args };
    case 'Git Bash': {
      const bash = findGitBash();
      return bash ? { path: bash, args: args.length ? args : ['--login', '-i'] } : undefined;
    }
    default:
      return undefined;
  }
}

function platformDefault(): ShellSpec {
  if (process.platform === 'win32') {
    return { path: findPwsh() ?? 'powershell.exe', args: [] };
  }
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  return { path: shell, args: ['-l'] };
}

function toArgs(args: string | string[] | undefined): string[] {
  if (!args) return [];
  return Array.isArray(args) ? args.map(String) : [String(args)];
}

function isExecutable(candidate: string): boolean {
  if (candidate.includes('/') || candidate.includes('\\')) {
    return fs.existsSync(candidate);
  }
  return findInPath(candidate) !== undefined;
}

function findInPath(name: string): string | undefined {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === 'win32' && !path.extname(name)
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
      : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      if (fs.existsSync(full)) return full;
    }
  }
  return undefined;
}

function findPwsh(): string | undefined {
  const inPath = findInPath('pwsh.exe');
  if (inPath) return inPath;
  const candidates = [
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'WindowsApps', 'pwsh.exe'),
  ];
  return candidates.find(c => fs.existsSync(c));
}

function findGitBash(): string | undefined {
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : undefined,
  ].filter((r): r is string => !!r);
  for (const root of roots) {
    const candidate = path.join(root, 'Git', 'bin', 'bash.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  const git = findInPath('git.exe');
  if (git) {
    // <git>/cmd/git.exe  ->  <git>/bin/bash.exe
    const candidate = path.join(path.dirname(path.dirname(git)), 'bin', 'bash.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}
