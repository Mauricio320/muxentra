// Same explicit setup exposed by Muxentra's command, usable during development.
const Module = require('node:module');
const path = require('node:path');
const { buildSync } = require('esbuild');
const root = path.join(__dirname, '..');
const loaded = new Module(__filename);
loaded.paths = module.paths;
loaded._compile(buildSync({ entryPoints: [path.join(root, 'src/claudeUsageSetup.ts')], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, __filename);
loaded.exports.installClaudeUsage(root, undefined, process.execPath);
console.log('Claude usage connected; existing statusLine preserved and settings backed up.');
