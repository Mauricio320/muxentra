// Claude statusLine bridge: persist only quota metadata, pass stdin unchanged
// to the user's existing statusLine command when installed in a pipeline.
const fs = require('node:fs');
const path = require('node:path');

function capture(input, home = __dirname, now = Date.now()) {
  const limits = JSON.parse(input).rate_limits;
  if (!limits || typeof limits !== 'object') return false;
  const usageData = {};
  for (const [key, suffix] of [['five_hour', '5h'], ['seven_day', '7d']]) {
    const window = limits[key];
    if (!window || typeof window.used_percentage !== 'number' || !Number.isFinite(window.used_percentage)) continue;
    usageData[`utilization${suffix}`] = Math.min(100, Math.max(0, window.used_percentage)) / 100;
    if (typeof window.resets_at === 'number' && Number.isFinite(window.resets_at)) {
      usageData[`reset${suffix}At`] = window.resets_at;
    }
  }
  if (Object.keys(usageData).length === 0) return false;
  const target = path.join(home, 'muxentra-usage.json');
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, updatedAt: new Date(now).toISOString(), usageData }), { mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* already renamed or never written */ }
  }
  return true;
}

if (require.main === module) {
  const chunks = [];
  process.stdin.on('data', chunk => chunks.push(chunk));
  process.stdin.on('end', () => {
    const input = Buffer.concat(chunks);
    try { capture(input.toString('utf8')); } catch { /* Never break the existing status line. */ }
    if (process.argv.includes('--passthrough')) process.stdout.write(input);
  });
}

module.exports = { capture };
