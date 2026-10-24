// Bundles the extension (Node, `vscode` from the host) and the panel's webview (browser, React) into dist/.
import { context, build } from "esbuild";

const watch = process.argv.includes("--watch");
const targets = [
  { entryPoints: ["src/extension.ts"], outfile: "dist/extension.js", platform: "node", format: "cjs", external: ["vscode"], target: "node20" },
  { entryPoints: { webview: "webview/main.tsx" }, outdir: "dist", platform: "browser", format: "iife", jsx: "automatic", target: "es2022", loader: { ".css": "css" }, inject: [] },
];
for (const options of targets) {
  const o = { bundle: true, sourcemap: true, minify: !watch, logLevel: "info", ...options };
  if (watch) await (await context(o)).watch();
  else await build(o);
}
await build({ entryPoints: { webview: "webview/style.css" }, outdir: "dist", bundle: true, minify: true, logLevel: "info" });
