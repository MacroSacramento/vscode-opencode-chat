import * as esbuild from 'esbuild';
import * as fs from 'node:fs';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
  banner: {
    // VS Code extension host: ESM deps (like @opencode-ai/sdk) need interop help in CJS bundles.
    js: `/* bundled by esbuild */`,
  },
};

/** @type {import('esbuild').BuildOptions} */
const webviewOptions = {
  entryPoints: ['media/js/app.js'],
  bundle: true,
  outfile: 'media/chat.bundle.js',
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  // No sourcemap for the webview bundle: the `.map` would trigger a fetch
  // from the page on devtools open, which the strict CSP (default-src 'none',
  // no connect-src) blocks — noisy console errors. Maps never ship in the
  // VSIX anyway (.vscodeignore excludes **/*.map). Host bundle keeps its map.
  sourcemap: false,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  const webviewCtx = await esbuild.context(webviewOptions);
  await ctx.watch();
  await webviewCtx.watch();
  console.log('watching…');
} else {
  fs.mkdirSync('dist', { recursive: true });
  await esbuild.build(options);
  await esbuild.build(webviewOptions);
}
