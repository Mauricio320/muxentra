import * as os from 'os';
import * as path from 'path';

export interface AgentHomes {
  claude: string;
  codex: string;
  claudeConfigFile?: string;
}

/** Shared by terminal startup, usage reads and the explicit status-line setup. */
export function agentHomes(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): AgentHomes {
  const home = (key: string, fallback: string): string => {
    const value = env[key];
    if (!value) return path.join(os.homedir(), fallback);
    const expanded = value === '~' || /^~[/\\]/.test(value) ? path.join(os.homedir(), value.slice(1)) : value;
    return path.resolve(cwd, expanded);
  };
  const claude = home('CLAUDE_CONFIG_DIR', '.claude');
  return {
    claude, codex: home('CODEX_HOME', '.codex'),
    // Explicitly setting even ~/.claude changes where Claude keeps this file.
    claudeConfigFile: path.join(env.CLAUDE_CONFIG_DIR ? claude : os.homedir(), '.claude.json'),
  };
}
