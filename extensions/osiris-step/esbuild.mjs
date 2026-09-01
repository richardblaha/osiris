import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production';

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  target: 'es2022',
};

const extension = {
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
};

// three.js is bundled straight into the webview payload (CSP forbids remote CDNs).
const webview = {
  ...common,
  entryPoints: ['webview/main.ts'],
  outfile: 'media/preview.js',
  platform: 'browser',
  format: 'iife',
};

if (watch) {
  const ctxs = await Promise.all([esbuild.context(extension), esbuild.context(webview)]);
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('[osiris-step] esbuild watching…');
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(webview)]);
  console.log('[osiris-step] build complete');
}
