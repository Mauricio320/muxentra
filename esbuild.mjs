import * as esbuild from 'esbuild';

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

if (watch) {
  await Promise.all([extension.watch(), server.watch(), webview.watch()]);
} else {
  await Promise.all([extension.rebuild(), server.rebuild(), webview.rebuild()]);
  await Promise.all([extension.dispose(), server.dispose(), webview.dispose()]);
}
