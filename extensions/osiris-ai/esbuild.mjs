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

// React panel — bundled (CSP forbids remote scripts). Emits media/panel.js + media/panel.css.
const webview = {
  ...common,
  entryPoints: ['webview/main.tsx'],
  outfile: 'media/panel.js',
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  loader: { '.css': 'css' },
};

if (watch) {
  const ctxs = await Promise.all([esbuild.context(extension), esbuild.context(webview)]);
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('[osiris-ai] esbuild watching…');
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(webview)]);
  console.log('[osiris-ai] build complete');
}
