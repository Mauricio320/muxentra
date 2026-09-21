// Uses isolated fixtures, never the user's transcripts or credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const { spawnSync } = require('node:child_process');
const { capture } = require('../assets/claude-usage.cjs');

const compiled = buildSync({ entryPoints: ['src/usage.ts'], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
const loaded = new Module(__filename);
loaded.paths = module.paths;
loaded._compile(compiled, __filename);
const { readUsage, fetchClaudeUsage } = loaded.exports;
const setupModule = new Module(__filename);
setupModule.paths = module.paths;
setupModule._compile(buildSync({ entryPoints: ['src/claudeUsageSetup.ts'], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, __filename);
const { installClaudeUsage } = setupModule.exports;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muxentra-usage-'));
const homes = { claude: path.join(root, 'claude'), codex: path.join(root, 'codex') };
const now = Date.now();
const byId = id => readUsage(homes).items.find(item => item.id === id);
const save = (file, data, mtime = now) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  fs.utimesSync(file, new Date(mtime), new Date(mtime));
};
const cacheFile = path.join(homes.claude, 'vscode-claude-status-cache.json');
async function main() {
try {
  assert.deepEqual(readUsage(homes).items.map(item => [item.id, item.windows.length]), [['claude', 0], ['codex', 0]]);
  console.log('PASS: clean start keeps both providers available without invented percentages');

  save(cacheFile, { updatedAt: new Date(now - 16 * 3600000).toISOString(), usageData: {
    utilization5h: 0.9, utilization7d: 0.11, reset5hAt: now / 1000 - 3600, reset7dAt: now / 1000 + 3 * 86400,
  } });
  let claude = byId('claude');
  assert.equal(claude.windows.length, 2);
  assert.equal(claude.windows[0].percent, undefined);
  assert.equal(claude.windows[0].stale, true);
  assert.equal(claude.windows[1].percent, 0.11);
  assert.equal(claude.detail, 'Sin actualizar');
  console.log('PASS: stale Claude cache retains last known quota; expired window is pending');

  save(cacheFile, { updatedAt: new Date(now).toISOString(), usageData: {
    utilization5h: 0, utilization7d: 0.12, reset5hAt: now / 1000 + 1000, reset7dAt: now / 1000 + 3 * 86400,
  } });
  claude = byId('claude');
  assert.equal(claude.windows[0].percent, 0);
  assert.equal(claude.windows[0].stale, undefined);
  assert.equal(claude.detail, undefined);
  console.log('PASS: fresh genuine zero remains different from unknown');

  save(cacheFile, '{"usageData":');
  assert.equal(byId('claude').windows.length, 0);
  save(path.join(homes.claude, 'projects', 'fixture', 'session.jsonl'), {
    timestamp: new Date(now).toISOString(), message: { usage: { input_tokens: 1000, output_tokens: 100 } },
  });
  claude = byId('claude');
  assert.equal(claude.windows.length, 0);
  assert.ok(claude.detail.includes('tokens'));
  console.log('PASS: partial cache and transcript tokens never invent a quota percentage');

  const nativeFile = path.join(homes.claude, '.claude.json');
  const liveFile = path.join(homes.claude, 'muxentra-usage.json');
  save(nativeFile, { cachedUsageUtilization: { fetchedAtMs: now - 10000, utilization: {
    five_hour: { utilization: 14, resets_at: new Date(now + 3600000).toISOString() },
    seven_day: { utilization: 21, resets_at: new Date(now + 86400000).toISOString() },
  } } });
  claude = byId('claude');
  assert.deepEqual(claude.windows.map(w => w.percent), [0.14, 0.21]);
  assert.equal(claude.updatedAt, now - 10000);
  console.log('PASS: native /usage cache supplies current percentages with its actual observation time');

  const payload = JSON.stringify({ session_id: 'private-session', transcript_path: 'private-path', rate_limits: {
    five_hour: { used_percentage: 0, resets_at: now / 1000 + 3600 },
    seven_day: { used_percentage: 22, resets_at: now / 1000 + 86400 },
  } });
  assert.equal(capture(payload, homes.claude, now), true);
  claude = byId('claude');
  assert.deepEqual(claude.windows.map(w => w.percent), [0.14, 0.21]);
  assert.equal(claude.updatedAt, now - 10000);
  assert.equal(claude.detail, undefined);
  const captured = fs.readFileSync(liveFile, 'utf8');
  assert.ok(!captured.includes('private-'));
  assert.equal(capture('{"rate_limits":null}', homes.claude, now + 1000), false);
  assert.equal(fs.readFileSync(liveFile, 'utf8'), captured);
  assert.throws(() => capture('{', homes.claude));
  assert.equal(fs.readFileSync(liveFile, 'utf8'), captured);
  console.log('PASS: /usage stays authoritative over partial statusLine readings and bridge stores only quota metadata');

  save(nativeFile, { cachedUsageUtilization: { fetchedAtMs: now + 1000, utilization: { limits: [
    { kind: 'session', percent: 0, resets_at: new Date(now + 3600000).toISOString() },
    { kind: 'weekly_all', percent: 26, resets_at: new Date(now + 86400000).toISOString() },
    { kind: 'weekly_scoped', percent: 38, resets_at: new Date(now + 86400000).toISOString(), scope: { model: { display_name: 'Fable' } } },
  ] } } });
  claude = byId('claude');
  assert.deepEqual(claude.windows.map(w => [w.label, w.percent]), [['5h', 0], ['7d', 0.26], ['Fable', 0.38]]);
  assert.equal(claude.updatedAt, now + 1000);
  console.log('PASS: Claude /usage limits match session, weekly and named model quotas');

  save(path.join(homes.claude, '.credentials.json'), { claudeAiOauth: { accessToken: 'fixture-token' } });
  const live = await fetchClaudeUsage(homes.claude, async (_url, options) => {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer fixture-token');
    return { ok: true, json: async () => ({ limits: [
      { kind: 'session', percent: 9, resets_at: new Date(now + 3600000).toISOString() },
      { kind: 'weekly_all', percent: 27, resets_at: new Date(now + 86400000).toISOString() },
      { kind: 'weekly_scoped', percent: 40, resets_at: new Date(now + 86400000).toISOString(), scope: { model: { display_name: 'Fable' } } },
    ] }) };
  });
  assert.deepEqual(readUsage(homes, live).items[0].windows.map(w => w.percent), [0.09, 0.27, 0.4]);
  assert.equal(await fetchClaudeUsage(homes.claude, async () => ({ ok: false })), undefined);
  console.log('PASS: live account usage replaces stale local zero without persisting credentials or response');

  save(nativeFile, { cachedUsageUtilization: { fetchedAtMs: now + 1000, utilization: {
    five_hour: { utilization: 4, resets_at: new Date(now + 3600000).toISOString() },
  } } });
  assert.equal(byId('claude').windows[0].percent, 0.04);
  save(nativeFile, '{');
  assert.equal(byId('claude').windows[0].percent, 0);
  capture(JSON.stringify({ rate_limits: { five_hour: { used_percentage: 79, resets_at: now / 1000 - 1 } } }), homes.claude, now);
  assert.equal(byId('claude').windows[0].percent, undefined);
  console.log('PASS: incomplete native windows use fallback, malformed source is ignored, and expired quotas stay pending');

  const settingsFile = path.join(homes.claude, 'settings.json');
  const settings = { statusLine: { type: 'command', command: 'cat', padding: 2 }, hooks: { preserved: true }, env: { KEEP: 'value' } };
  save(settingsFile, settings);
  const originalSettings = fs.readFileSync(settingsFile, 'utf8');
  installClaudeUsage(process.cwd(), homes.claude, process.execPath);
  const installed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(installed.statusLine.padding, 2);
  assert.ok(installed.statusLine.command.endsWith('| ( cat\n)'));
  assert.deepEqual(installed.hooks, settings.hooks);
  assert.deepEqual(installed.env, settings.env);
  const backups = fs.readdirSync(homes.claude).filter(f => f.endsWith('.bak'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(homes.claude, backups[0]), 'utf8'), originalSettings);
  installClaudeUsage(process.cwd(), homes.claude, process.execPath);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), installed);
  assert.equal(fs.readdirSync(homes.claude).filter(f => f.endsWith('.bak')).length, 1);
  const bridge = path.join(homes.claude, 'muxentra-statusline.cjs');
  for (const input of [payload, '{not json}']) {
    const result = spawnSync(process.execPath, [bridge, '--passthrough'], { input, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, input);
  }
  const silent = spawnSync(process.execPath, [bridge], { input: payload, encoding: 'utf8', windowsHide: true });
  assert.equal(silent.status, 0, silent.stderr);
  assert.equal(silent.stdout, '');
  assert.deepEqual(byId('claude').windows.map(w => w.percent), [0, 0.22]);
  console.log('PASS: setup preserves existing settings and backup; bridge forwards exact stdin and is silent without a prior statusLine');

  const sessions = path.join(homes.codex, 'sessions', '2026', '09', '21');
  const observedAt = now - 120000;
  save(path.join(sessions, 'rollout-old.jsonl'), {
    timestamp: new Date(observedAt).toISOString(), payload: { rate_limits: {
      primary: { used_percent: 25, window_minutes: 300, resets_at: now / 1000 + 1000 },
      secondary: { used_percent: 81, window_minutes: 10080, resets_at: now / 1000 + 3 * 86400 }, plan_type: 'pro',
    } },
  }, now - 5000);
  save(path.join(sessions, 'rollout-new.jsonl'), { timestamp: new Date(now).toISOString(), type: 'session_meta' });
  let codex = byId('codex');
  assert.deepEqual(codex.windows.map(window => window.percent), [0.25, 0.81]);
  assert.equal(codex.updatedAt, observedAt);
  console.log('PASS: new Codex session without limits preserves prior event and its real timestamp');

  save(path.join(sessions, 'rollout-new.jsonl'), JSON.stringify({
    timestamp: new Date(now).toISOString(), payload: { rate_limits: {
      primary: { used_percent: 35, window_minutes: 300, resets_at: now / 1000 + 1000 },
      secondary: { used_percent: 81, window_minutes: 10080, resets_at: now / 1000 - 1000 },
    } },
  }) + '\n{"payload":');
  codex = byId('codex');
  assert.equal(codex.windows[0].percent, 0.35);
  assert.equal(codex.windows[1].percent, undefined);
  assert.equal(codex.windows[1].stale, true);
  assert.equal(codex.updatedAt, now);
  console.log('PASS: first fresh Codex event replaces prior usage despite a partial trailing line');
} finally {
  const target = fs.realpathSync(root);
  assert.equal(path.dirname(target), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('muxentra-usage-'));
  fs.rmSync(target, { recursive: true, force: true });
}
}
void main().catch(err => { console.error(err); process.exitCode = 1; });
