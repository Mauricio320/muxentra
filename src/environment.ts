import * as os from 'os';
import * as vscode from 'vscode';
import { agentHomes, type AgentHomes } from './agentHomes';
import { platformKey, resolveShell } from './shell';

export type EnvironmentOverrides = Record<string, string | null>;

/** Uses VS Code's effective configuration, which belongs to the current window/profile. */
export function buildTerminalEnv(shellEnv?: EnvironmentOverrides, cwd = os.homedir()): Record<string, string> {
  const env: Record<string, string> = Object.create(null);
  const keyOf = (key: string): string => process.platform === 'win32' ? key.toUpperCase() : key;
  const allowed = (key: string): boolean => {
    const name = keyOf(key);
    return !!name && !/[=\0]/.test(name) && name !== 'ELECTRON_RUN_AS_NODE' && name !== 'ELECTRON_NO_ATTACH_CONSOLE'
      && (!name.startsWith('VSCODE_') || name.startsWith('VSCODE_GIT_'));
  };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && allowed(key)) env[keyOf(key)] = value;
  }
  const merge = (values: unknown): void => {
    if (!values || typeof values !== 'object' || Array.isArray(values)) return;
    const inherited = { ...env };
    for (const [key, value] of Object.entries(values)) {
      if (!allowed(key)) continue;
      if (value === null) delete env[keyOf(key)];
      else if (typeof value === 'string' && !value.includes('\0')) {
        env[keyOf(key)] = value.replace(/\$\{(env:([^}]+)|userHome|workspaceFolder)\}/g, (_match, variable: string, name: string) =>
          variable === 'userHome' ? os.homedir() : variable === 'workspaceFolder' ? cwd : inherited[keyOf(name)] ?? '');
      }
    }
  };
  merge(vscode.workspace.getConfiguration('terminal.integrated').get(`env.${platformKey()}`));
  merge(shellEnv);
  // Claude's extension sets these only for its own process. Mirror the active
  // profile's launch environment so `claude` in Muxentra uses that same account.
  const claudeEnv = vscode.workspace.getConfiguration('claudeCode').get<unknown>('environmentVariables');
  if (Array.isArray(claudeEnv)) {
    for (const entry of claudeEnv) {
      if (entry && typeof entry.name === 'string' && typeof entry.value === 'string') merge({ [entry.name]: entry.value });
    }
  }
  // Resolve relative/tilde directories once, consistently for shell and usage.
  const homes = agentHomes(env, cwd);
  if (env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = homes.claude;
  if (env.CODEX_HOME) env.CODEX_HOME = homes.codex;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'muxentra';
  return env;
}

export function currentAgentHomes(): AgentHomes {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const cwd = folder?.uri.scheme === 'file' ? folder.uri.fsPath : os.homedir();
  return agentHomes(buildTerminalEnv(resolveShell().env, cwd), cwd);
}
