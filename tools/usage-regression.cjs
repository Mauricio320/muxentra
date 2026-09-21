// Uses isolated fixtures, never the user's transcripts or credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

const compiled = buildSync({ entryPoints: ['src/usage.ts'], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
const loaded = new Module(__filename);
loaded.paths = module.paths;
loaded._compile(compiled, __filename);
const { readUsage } = loaded.exports;
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
