// Runs inside a PTY. Arguments are passed directly, never interpreted as shell code.
import { spawn } from 'child_process';

const [executable, transcript, shell, rawArgs] = process.argv.slice(2);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;
const shellArgs: unknown = JSON.parse(rawArgs);
if (!executable || !transcript || !shell || !Array.isArray(shellArgs) || shellArgs.some(arg => typeof arg !== 'string')) {
  throw new Error('Argumentos de reanudación inválidos.');
}
// Ctrl+C is handled by the foreground child; the wrapper must survive to open
// the shell when Claude exits. No prompts or commands are injected into a TUI.
process.on('SIGINT', () => {});
const claude = spawn(executable, ['--resume', transcript], { stdio: 'inherit', env });
let opened = false;
const openShell = (): void => {
  if (opened) return;
  opened = true;
  const child = spawn(shell, shellArgs as string[], { stdio: 'inherit', env });
  child.on('exit', code => process.exit(code ?? 0));
  child.on('error', () => { process.stderr.write('Muxentra: no se pudo abrir el shell.\n'); process.exit(1); });
};
claude.on('error', () => { process.stderr.write('Muxentra: no se pudo reanudar Claude.\n'); openShell(); });
claude.on('exit', openShell);
