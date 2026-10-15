const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, mocks = {}, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: name => name in mocks ? mocks[name] : require(name),
    process, setTimeout, clearTimeout, ...globals });
  return exports;
}
const { findClaudeSession } = load('src/claudeSession.ts');
const { agentHomes } = load('src/agentHomes.ts');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muxentra-profile-test-'));
const personal = path.join(root, 'personal'), pdv = path.join(root, 'pdv');
const sessionId = '11111111-2222-3333-4444-555555555555';
const transcript = path.join(personal, 'projects', 'workspace', `${sessionId}.jsonl`);
const startedAt = Date.now();
const launch = { pid: 100, startedAt, file: '/shell', claudeHome: personal };
const processes = [
  { pid: 100, ppid: 1, executable: '/shell', startedAt },
  { pid: 200, ppid: 100, executable: '/claude', startedAt: startedAt + 100 },
  { pid: 300, ppid: 1, executable: '/claude', startedAt: startedAt + 100 },
];
const sessionFile = path.join(personal, 'sessions', '200.json');
const metadata = { pid: 200, sessionId, cwd: root, kind: 'interactive', entrypoint: 'cli', status: 'idle', startedAt: startedAt + 100 };

function sessionChecks() {
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(transcript, '{"type":"assistant"}\n');
  fs.writeFileSync(sessionFile, JSON.stringify(metadata));
  const session = findClaudeSession(launch, processes);
  assert.equal(session.sessionId, sessionId);
  assert.equal(session.transcript, transcript);
  assert.equal(session.idle, true);
  assert.equal(findClaudeSession({ ...launch, pid: 300 }, processes), undefined, 'another terminal cannot claim this conversation');
  assert.equal(findClaudeSession({ ...launch, startedAt: startedAt - 100000 }, processes), undefined, 'reject reused parent PID');
  fs.writeFileSync(sessionFile, JSON.stringify({ ...metadata, startedAt: startedAt - 100000 }));
  assert.equal(findClaudeSession(launch, processes), undefined, 'reject stale Claude PID metadata');
  fs.writeFileSync(sessionFile, JSON.stringify({ ...metadata, status: 'working' }));
  assert.equal(findClaudeSession(launch, processes).idle, false, 'working Claude waits');
  fs.writeFileSync(sessionFile, JSON.stringify({ ...metadata, entrypoint: 'claude-vscode' }));
  assert.equal(findClaudeSession(launch, processes), undefined, 'official extension processes are not ours');
  fs.writeFileSync(sessionFile, JSON.stringify(metadata));
  fs.mkdirSync(path.join(personal, 'projects', 'duplicate'));
  const duplicate = path.join(personal, 'projects', 'duplicate', `${sessionId}.jsonl`);
  fs.copyFileSync(transcript, duplicate);
  assert.equal(findClaudeSession(launch, processes), undefined, 'duplicate transcript is ambiguous');
  fs.unlinkSync(duplicate);
  fs.writeFileSync(sessionFile, JSON.stringify({ ...metadata, sessionId: '../escape' }));
  assert.equal(findClaudeSession(launch, processes), undefined, 'session ID cannot traverse paths');
  fs.writeFileSync(sessionFile, JSON.stringify(metadata));
  fs.mkdirSync(path.join(pdv, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(pdv, 'sessions', '200.json'), JSON.stringify(metadata));
  assert.equal(findClaudeSession({ ...launch, claudeHome: pdv, resumeSource: { sessionId, transcript } }, processes).transcript,
    transcript, 'before the next turn Claude still uses the source transcript');
  assert.equal(findClaudeSession({ ...launch, claudeHome: pdv, resumeSource: { sessionId: 'different', transcript } }, processes),
    undefined, 'a cleared or different session never reuses the old transcript');
  console.log('PASS: exact session/process ancestry, idle detection, PID reuse, unrelated accounts and ambiguous history');
}

function controllerFixture() {
  let home = pdv, idle = true, authenticated = true, found = true, supported = true, treeHook, restartError;
  const launchMap = new Map([['pane', { ...launch }]]), calls = [], notices = [], timers = new Map();
  const session = { pid: 200, sessionId, cwd: root, executable: '/claude', transcript };
  const { ClaudeProfileSwitch } = load('src/claudeProfileSwitch.ts', {
    './agentHomes': { agentHomes }, './environment': { buildTerminalEnv: () => ({ CLAUDE_CONFIG_DIR: home }) },
    './shell': { resolveShell: () => ({ env: {} }) }, './ptyClient': { workingDirectory: () => root },
    './claudeSession': {
      processTree: async () => { if (treeHook) await treeHook(); return []; },
      findClaudeSession: () => found ? { ...session, idle } : undefined,
      accountReady: async () => authenticated,
    },
  }, {
    setTimeout: (callback, ms) => {
      if (ms === 250 || ms === 1000) { queueMicrotask(callback); return 1; }
      const id = Symbol(); timers.set(id, callback); return id;
    },
    clearTimeout: id => timers.delete(id),
  });
  const client = {
    supportsProfileSwitch: () => supported,
    launchInfo: id => launchMap.get(id),
    restartClaude: async (...args) => {
      if (restartError) throw restartError;
      assert.equal(controller.acceptsInput('pane'), false, 'block input during replacement');
      calls.push(args);
      launchMap.set('pane', { ...launch, claudeHome: home, claudeConfigFile: path.join(home, '.claude.json') });
    },
  };
  const controller = new ClaudeProfileSwitch(client, () => ({ cols: 110, rows: 35 }), (id, status) => notices.push({ id, ...status }));
  controller.track('pane');
  return { controller, calls, notices, launchMap,
    setHome: value => { home = value; }, setIdle: value => { idle = value; },
    setFound: value => { found = value; }, setAuth: value => { authenticated = value; },
    setSupported: value => { supported = value; },
    setTreeHook: value => { treeHook = value; }, setError: value => { restartError = value; } };
}

async function controllerChecks() {
  const test = controllerFixture();
  await test.controller.check();
  assert.equal(test.calls.length, 1);
  assert.equal(test.calls[0][0], 'pane');
  assert.equal(test.calls[0][1].transcript, transcript);
  assert.equal(test.calls[0][2].CLAUDE_CONFIG_DIR, pdv);
  assert.equal(test.calls[0][3], 110);
  assert.equal(test.calls[0][4], 35);
  assert.equal(test.controller.acceptsInput('pane'), true);
  await test.controller.check();
  assert.equal(test.calls.length, 1, 'same account does not restart twice');
  test.setHome(personal); test.controller.changed(); await test.controller.check();
  assert.equal(test.calls.length, 2, 'switching back adopts the original account');
  const busy = controllerFixture(); busy.setIdle(false); await busy.controller.check();
  assert.equal(busy.calls.length, 0); assert.equal(busy.notices.at(-1).state, 'waiting');
  busy.setIdle(true); await busy.controller.check(); assert.equal(busy.calls.length, 1);
  const logout = controllerFixture(); logout.setAuth(false); await logout.controller.check();
  assert.equal(logout.calls.length, 0, 'missing destination login preserves original');
  assert.equal(logout.notices.at(-1).state, 'error');
  const unknown = controllerFixture(); unknown.setFound(false); await unknown.controller.check();
  assert.equal(unknown.calls.length, 0, 'no exact session means no destructive restart');
  const stale = controllerFixture(); let once = false;
  stale.setTreeHook(() => { if (!once) { once = true; stale.setHome(personal); stale.controller.changed(); } });
  await stale.controller.check(); assert.equal(stale.calls.length, 0, 'rapid profile changes cancel old target');
  const removed = controllerFixture(); removed.controller.forget('pane'); await removed.controller.check();
  assert.equal(removed.calls.length, 0, 'closing a pane prevents replacement');
  const disposed = controllerFixture(); disposed.controller.dispose(); await disposed.controller.check();
  assert.equal(disposed.calls.length, 0, 'host restart cancels pending work');
  const failed = controllerFixture(); failed.setError(new Error('launch failed')); await failed.controller.check();
  assert.equal(failed.controller.acceptsInput('pane'), true, 'input unlocks on failure');
  assert.equal(failed.notices.at(-1).state, 'error');
  const legacy = controllerFixture(); legacy.setSupported(false); await legacy.controller.check();
  assert.equal(legacy.calls.length, 0, 'old server is never killed to upgrade');
  for (const item of [test, busy, logout, unknown, stale, removed, disposed, failed, legacy]) item.controller.dispose();
  console.log('PASS: profile switch/back, same-pane resume, busy deferral, auth failure, stale target, close and disposal');
}

function runnerChecks() {
  const events = [], children = [];
  load('src/claudeResume.ts', { child_process: { spawn: (file, args, options) => {
    const listeners = {};
    events.push({ file, args, options });
    const child = { on: (event, callback) => { listeners[event] = callback; }, listeners };
    children.push(child); return child;
  } } }, { process: { argv: ['node', 'runner', '/claude', "a ' b ; $x.jsonl", '/shell', '["--login","-i"]'],
    env: { CLAUDE_CONFIG_DIR: pdv, ELECTRON_RUN_AS_NODE: '1' }, on() {}, exit() {}, stderr: { write() {} } } });
  assert.equal(events[0].args[0], '--resume');
  assert.equal(events[0].args[1], "a ' b ; $x.jsonl", 'paths stay literal without shell interpolation');
  assert.equal(events[0].options.env.CLAUDE_CONFIG_DIR, pdv);
  assert.equal(events[0].options.env.ELECTRON_RUN_AS_NODE, undefined);
  children[0].listeners.exit(0);
  assert.equal(events[1].file, '/shell');
  assert.deepEqual([...events[1].args], ['--login', '-i']);
  console.log('PASS: resume launcher argument safety, account env and return to interactive shell');
}

(async () => { try { sessionChecks(); await controllerChecks(); runnerChecks(); }
  finally { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
