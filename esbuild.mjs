import * as esbuild from 'esbuild';
import * as fs from 'node:fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const extension = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/extension.js',
  external: ['vscode', 'node-pty'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
});

const server = await esbuild.context({
  entryPoints: ['src/server/server.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/server.js',
  external: ['node-pty'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
});

const webview = await esbuild.context({
  entryPoints: ['src/webview/main.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  outfile: 'dist/webview.js',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
});

const gitView = await esbuild.context({
  entryPoints: ['src/gitView/styles.css'],
  bundle: true,
  outfile: 'dist/gitView.css',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
});

const gitPreview = production ? undefined : await esbuild.context({
  entryPoints: ['tools/fixtures/git-preview-entry.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  outfile: 'dist/gitView.js',
  sourcemap: true,
  logLevel: 'info',
});

if (production) {
  for (const file of ['dist/gitView.js', 'dist/gitView.js.map']) fs.rmSync(file, { force: true });
}

if (watch) {
  await Promise.all([extension.watch(), server.watch(), webview.watch(), gitView.watch(), gitPreview?.watch()]);
} else {
  await Promise.all([extension.rebuild(), server.rebuild(), webview.rebuild(), gitView.rebuild(), gitPreview?.rebuild()]);
  await Promise.all([extension.dispose(), server.dispose(), webview.dispose(), gitView.dispose(), gitPreview?.dispose()]);
}
