// Optional live compatibility probe. Uses a synthetic saved conversation, never sends a prompt.
// node tools/claude-resume-probe.cjs <native-claude-executable> <destination-config-directory>
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node-pty');
const { Terminal } = require('@xterm/headless');
const vm = require('node:vm');
const ts = require('typescript');
const sessionTools = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/claudeSession.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: sessionTools, require, process });

const [executable, destination] = process.argv.slice(2);
if (!executable || !destination) throw new Error('Specify native Claude and destination config directory.');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muxentra-resume-probe-'));
const sessionId = crypto.randomUUID();
const marker = `MUXENTRA-RESUME-${sessionId}`;
const transcript = path.join(dir, `${sessionId}.jsonl`);
const userId = crypto.randomUUID(), assistantId = crypto.randomUUID();
const common = { isSidechain: false, userType: 'external', cwd: dir, sessionId, version: '2.1.300', timestamp: new Date().toISOString() };
fs.writeFileSync(transcript, [
  { ...common, parentUuid: null, type: 'user', uuid: userId, message: { role: 'user', content: 'Synthetic saved compatibility check.' } },
  { ...common, parentUuid: userId, type: 'assistant', uuid: assistantId, message: {
    id: 'msg_muxentra_probe', type: 'message', role: 'assistant', model: 'claude-opus-4-6',
    content: [{ type: 'text', text: marker }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } },
].map(row => JSON.stringify(row)).join('\n') + '\n');
const mcp = path.join(dir, 'mcp.json'); fs.writeFileSync(mcp, '{"mcpServers":{}}');
const terminal = new Terminal({ cols: 140, rows: 40, scrollback: 5000, allowProposedApi: true });
const startedAt = Date.now();
const proc = spawn(executable, ['--resume', transcript, '--settings', '{"disableAllHooks":true}', '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', mcp], {
  cwd: dir, env: { ...process.env, CLAUDE_CONFIG_DIR: destination, TERM: 'xterm-256color' },
  cols: 140, rows: 40, useConptyDll: true,
});
let output = '';
proc.onData(data => { output += data; terminal.write(data); });
terminal.onData(data => proc.write(data));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  let registered = false, rendered = false, trusted = false;
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      await delay(500);
      const screen = Array.from({ length: terminal.buffer.active.length }, (_, index) => terminal.buffer.active.getLine(index)?.translateToString(true)).join('\n');
      // Approve only this generated empty test folder, never the user's home or repository.
      if (!trusted && screen.toLowerCase().includes(dir.toLowerCase()) && screen.includes('Yes, I trust this folder') && screen.includes('No, exit')) {
        trusted = true;
        await delay(1500);
        proc.write('\x1b[B'); await delay(500); proc.write('\r');
      }
      rendered = screen.includes(marker);
      try {
        const registry = JSON.parse(fs.readFileSync(path.join(destination, 'sessions', `${proc.pid}.json`), 'utf8'));
        registered = registry.sessionId === sessionId;
      } catch {}
      if (registered && rendered) break;
    }
    const processes = registered ? await sessionTools.processTree() : [];
    const detected = registered && sessionTools.findClaudeSession({ pid: proc.pid, startedAt, file: executable, claudeHome: destination,
      resumeSource: { sessionId, transcript } }, processes);
    console.log(JSON.stringify({ exactSessionRegisteredInDestination: registered, savedConversationRendered: rendered, detectedBySwitcher: detected?.sessionId === sessionId,
      noPromptSent: true, trustedTestFolder: trusted, authPrompt: /Please run \/login|Not logged in/.test(output),
      trustPrompt: /trust this folder|trust the files/i.test(output),
      missingTranscript: /No conversation found|Session not found/i.test(output) }));
    if (!registered || !rendered || detected?.sessionId !== sessionId) {
      process.exitCode = 1;
      if (registered) {
        const registry = JSON.parse(fs.readFileSync(path.join(destination, 'sessions', `${proc.pid}.json`), 'utf8'));
        const rootProcess = processes.find(item => item.pid === proc.pid);
        const projects = path.join(destination, 'projects');
        const count = fs.readdirSync(projects).filter(name => fs.existsSync(path.join(projects, name, `${sessionId}.jsonl`))).length;
        console.log(JSON.stringify({ rootFound: !!rootProcess, rootDelta: rootProcess?.startedAt - startedAt,
          sessionDelta: registry.startedAt - rootProcess?.startedAt, kind: registry.kind, entrypoint: registry.entrypoint,
          targetTranscripts: count }));
      }
      const screen = Array.from({ length: terminal.buffer.active.length }, (_, index) => terminal.buffer.active.getLine(index)?.translateToString(true)).join('\n');
      console.log(screen.replace(/[\w.+-]+@[\w.-]+/g, '[account]').slice(-2500));
    }
  } finally {
    // Only the PTY created above is stopped. Never touch another Claude process.
    proc.kill(); await delay(500); terminal.dispose();
    const projects = path.join(destination, 'projects');
    if (fs.existsSync(projects)) for (const entry of fs.readdirSync(projects, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(projects, entry.name, `${sessionId}.jsonl`);
      if (fs.existsSync(file)) fs.unlinkSync(file); // this randomly named synthetic transcript only
    }
    const resolved = fs.realpathSync(dir);
    if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('muxentra-resume-probe-')) throw new Error('Invalid cleanup directory');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => process.exit(process.exitCode ?? 0));
