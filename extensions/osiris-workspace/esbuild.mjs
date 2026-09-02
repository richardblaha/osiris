import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production';

/** @type {import('esbuild').BuildOptions} */
const extension = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  target: 'es2022',
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
};

if (watch) {
  const ctx = await esbuild.context(extension);
  await ctx.watch();
  console.log('[osiris-workspace] esbuild watching…');
} else {
  await esbuild.build(extension);
  console.log('[osiris-workspace] build complete');
}
