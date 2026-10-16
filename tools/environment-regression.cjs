const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

function load(file, mocks = {}) {
  const loaded = new Module(__filename);
  loaded.paths = module.paths;
  loaded.require = name => name in mocks ? mocks[name] : require(name);
  loaded._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, file);
  return loaded.exports;
}

const homesModule = load('src/agentHomes.ts');
const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
const cwd = path.join(os.tmpdir(), 'muxentra-env-fixture');
const pdvDir = path.join(cwd, 'claude-pdv');
const personalDir = path.join(cwd, 'claude-personal');
const baseEnv = { ...process.env, CLAUDE_CONFIG_DIR: path.join(cwd, 'inherited'), KEEP: 'base', REMOVE: 'yes' };
let settings = {};
const vscode = { workspace: {
  workspaceFolders: [{ uri: { scheme: 'file', fsPath: cwd } }],
  getConfiguration: section => ({ get: key => settings[`${section}.${key}`] }),
} };
const shell = load('src/shell.ts', { vscode });
const envModule = load('src/environment.ts', { vscode, './shell': shell, './agentHomes': homesModule });

function checkProfiles() {
  const originalEnv = process.env;
  process.env = { ...baseEnv };
  try {
    settings = { 'claudeCode.environmentVariables': [{ name: 'CLAUDE_CONFIG_DIR', value: pdvDir }] };
    const pdv = envModule.buildTerminalEnv(undefined, cwd);
    assert.equal(pdv.CLAUDE_CONFIG_DIR, pdvDir);
    assert.equal(process.env.CLAUDE_CONFIG_DIR, baseEnv.CLAUDE_CONFIG_DIR, 'profile overrides never change the parent environment');
    assert.equal(envModule.currentAgentHomes().claude, pdvDir);
    settings = { 'claudeCode.environmentVariables': [{ name: 'CLAUDE_CONFIG_DIR', value: personalDir }] };
    const personal = envModule.buildTerminalEnv(undefined, cwd);
    assert.equal(personal.CLAUDE_CONFIG_DIR, personalDir);
    assert.equal(pdv.CLAUDE_CONFIG_DIR, pdvDir, 'existing environment snapshots do not switch accounts');
    settings = {};
    assert.equal(envModule.currentAgentHomes().claude, baseEnv.CLAUDE_CONFIG_DIR);
    delete process.env.CLAUDE_CONFIG_DIR;
    assert.equal(envModule.currentAgentHomes().claude, path.join(os.homedir(), '.claude'));

    settings = {
      [`terminal.integrated.env.${platform}`]: { KEEP: 'terminal', REMOVE: null, CODEX_HOME: '${workspaceFolder}/codex' },
      'claudeCode.environmentVariables': [{ name: 'CLAUDE_CONFIG_DIR', value: '${userHome}/claude-pdv' }],
    };
    const merged = envModule.buildTerminalEnv({ KEEP: 'shell', FROM_BASE: '${env:KEEP}', VSCODE_SECRET: 'blocked', ELECTRON_RUN_AS_NODE: '1' }, cwd);
    assert.equal(merged.KEEP, 'shell');
    assert.equal(merged.FROM_BASE, 'terminal');
    assert.equal(merged.REMOVE, undefined);
    assert.equal(merged.CLAUDE_CONFIG_DIR, path.join(os.homedir(), 'claude-pdv'));
    assert.equal(merged.CODEX_HOME, path.join(cwd, 'codex'));
    assert.equal(merged.VSCODE_SECRET, undefined);
    assert.equal(merged.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(merged.TERM_PROGRAM, 'muxentra');
    if (process.platform === 'win32') {
      settings = { 'terminal.integrated.env.windows': { keep: null } };
      assert.equal(envModule.buildTerminalEnv().KEEP, undefined, 'Windows env names are case insensitive');
    }

    settings = {
      [`terminal.integrated.defaultProfile.${platform}`]: 'Fixture',
      [`terminal.integrated.profiles.${platform}`]: { Fixture: { path: process.execPath, env: { CLAUDE_CONFIG_DIR: pdvDir } } },
    };
    assert.equal(shell.resolveShell().env.CLAUDE_CONFIG_DIR, pdvDir);
    assert.equal(envModule.currentAgentHomes().claude, pdvDir);
    settings['muxentra.shellPath'] = process.execPath;
    assert.equal(shell.resolveShell().env, undefined, 'custom shells do not inherit another shell profile');
    assert.equal(envModule.currentAgentHomes().claude, path.join(os.homedir(), '.claude'));
    assert.deepEqual(homesModule.agentHomes({ CLAUDE_CONFIG_DIR: './account', CODEX_HOME: '~/codex-test' }, cwd), {
      claude: path.join(cwd, 'account'), codex: path.join(os.homedir(), 'codex-test'),
      claudeConfigFile: path.join(cwd, 'account', '.claude.json'),
    });
    assert.equal(homesModule.agentHomes({}).claudeConfigFile, path.join(os.homedir(), '.claude.json'));
    assert.equal(homesModule.agentHomes({ CLAUDE_CONFIG_DIR: path.join(os.homedir(), '.claude') }).claudeConfigFile,
      path.join(os.homedir(), '.claude', '.claude.json'));
  } finally { process.env = originalEnv; }
  console.log('PASS: active-profile accounts, default fallback, environment precedence, null removal and shell profile env');
}

async function checkUsageRaces() {
  let home = pdvDir;
  const pending = [], posts = [], reads = [];
  const { MuxentraPanel } = load('src/panel.ts', {
    vscode: { workspace: { getConfiguration: () => ({ get: () => true }) } },
    './environment': { currentAgentHomes: () => ({ claude: home, codex: '/codex' }) },
    './usage': {
      readUsage: (homes, live) => { reads.push({ home: homes.claude, live }); return { items: live ? [live] : [], updatedAt: 1 }; },
      fetchClaudeUsage: selected => new Promise(resolve => pending.push({ home: selected, resolve })),
    },
    './git': {}, './gitPanel': {}, './brand': {}, './ptyClient': {}, './log': { log: () => ({ warn() {} }) },
    './claudeProfileSwitch': {},
    './attachedFile': { attachLimitBytes: () => 10 * 1024 * 1024 }, './pasteGuard': {}, './projectFiles': {},
  });
  const panel = Object.create(MuxentraPanel.prototype);
  Object.assign(panel, { panel: { visible: true }, claudeLivePending: false, claudeLiveAttemptAt: 0, post: message => posts.push(message) });
  MuxentraPanel.current = panel;
  panel.sendUsage();
  home = personalDir;
  panel.sendUsage();
  assert.deepEqual(pending.map(p => p.home), [pdvDir, personalDir]);
  const before = posts.length;
  pending[0].resolve({ id: 'claude', windows: [{ percent: .9 }] });
  await Promise.resolve();
  assert.equal(posts.length, before, 'previous account response is discarded');
  assert.equal(panel.claudeLivePending, true, 'old completion cannot clear the new request');
  const personal = { id: 'claude', windows: [{ percent: .2 }] };
  pending[1].resolve(personal);
  await Promise.resolve();
  assert.equal(panel.claudeLive, personal);
  assert.equal(reads.at(-1).home, personalDir);
  home = pdvDir;
  panel.sendUsage();
  assert.equal(reads.at(-1).live, undefined, 'switching back never reuses the other account quota');
  MuxentraPanel.current = undefined;
  pending[2].resolve(undefined);
  await Promise.resolve();
  console.log('PASS: profile-specific usage reads and stale cross-account response isolation');
}

async function checkSpawn() {
  settings = { 'claudeCode.environmentVariables': [{ name: 'CLAUDE_CONFIG_DIR', value: pdvDir }] };
  const { PtyClient } = load('src/ptyClient.ts', {
    vscode, './shell': shell, './environment': envModule, './serverProtocol': {},
    './agentHomes': homesModule,
    './log': { log: () => ({ info() {} }) },
  });
  const client = Object.create(PtyClient.prototype);
  const messages = [];
  Object.assign(client, { ready: async () => {}, alive: new Set(), pendingLaunches: new Map(), send: message => messages.push(message) });
  await client.spawn('fixture', 80, 24);
  assert.equal(messages[0].env.CLAUDE_CONFIG_DIR, pdvDir);
  assert.equal(messages[0].cwd, cwd);
  settings = { 'claudeCode.environmentVariables': [{ name: 'CLAUDE_CONFIG_DIR', value: personalDir }] };
  await client.attachTerminal('fixture', 80, 24);
  assert.equal(messages[1].t, 'attach');
  assert.equal(messages[1].env, undefined, 'reconnecting cannot replace a running process environment');
  await client.spawn('second', 80, 24);
  assert.equal(messages[2].env.CLAUDE_CONFIG_DIR, personalDir);
  console.log('PASS: PTY spawn carries the current profile environment; reconnection preserves running sessions');
}

(async () => { checkProfiles(); await checkSpawn(); await checkUsageRaces(); })().catch(error => { console.error(error); process.exitCode = 1; });
