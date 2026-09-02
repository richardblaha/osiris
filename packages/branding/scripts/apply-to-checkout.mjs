#!/usr/bin/env node
/**
 * Copy the Osiris visual identity into a cloned upstream checkout (VSCodium for
 * the desktop app, openvscode-server for the web app).
 *
 * Both apply-branding.mjs scripts call copyBrandingIntoCheckout() after they
 * have merged product.json. Icons are rendered on demand from
 * assets/osiris-icon.svg; the Fira Code face is copied in (with an @font-face
 * appended to the workbench stylesheet) so a fresh install needs no system font.
 */
import { cp, mkdir, copyFile, readFile, writeFile, appendFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderIcons, generatedDir } from './render-icons.mjs';

const assetsDir = fileURLToPath(new URL('../assets/', import.meta.url));

const FONT_FACE_MARKER = '/* >>> Osiris bundled Fira Code */';
const FONT_FACE_RULE = `${FONT_FACE_MARKER}
@font-face {
  font-family: 'Fira Code';
  src: url('./FiraCode-VF.woff2') format('woff2-variations');
  font-weight: 300 700;
  font-display: block;
}
/* <<< Osiris bundled Fira Code */
`;

/**
 * Register the bundled face in the workbench stylesheet. Appending (rather than a
 * context patch) survives upstream drift; the marker keeps it idempotent.
 */
async function registerFontFace(checkoutDir) {
  const candidates = [
    path.join(checkoutDir, 'src', 'vs', 'workbench', 'browser', 'media', 'style.css'),
    path.join(checkoutDir, 'src', 'vs', 'workbench', 'browser', 'style.css'),
  ];
  for (const cssPath of candidates) {
    if (!existsSync(cssPath)) continue;
    const existing = await readFile(cssPath, 'utf8');
    if (existing.includes(FONT_FACE_MARKER)) return true;
    await appendFile(cssPath, `\n${FONT_FACE_RULE}`);
    console.log(`[branding] @font-face registered in ${path.relative(checkoutDir, cssPath)}`);
    return true;
  }
  console.warn(
    '[branding] no workbench style.css found — add the @font-face manually (see branding README)',
  );
  return false;
}

async function ensureIcons() {
  if (!existsSync(path.join(generatedDir, 'darwin', 'code.icns'))) {
    await renderIcons();
  }
  return generatedDir;
}

/**
 * Rename the per-workspace configuration folder `.vscode` → `.osiris` in the
 * upstream source, so an Osiris build reads `.osiris/{settings,tasks,launch,
 * extensions}.json` (and workspace snippets, MCP config, …).
 *
 * A sweep, not a curated list: every `.ts` under `src/vs/workbench` is rewritten,
 * then all of `src/vs` is scanned and the build FAILS if a bare `.vscode`
 * survives — so an upstream refactor that moves or adds a reference is caught
 * loudly instead of silently reading the wrong folder. `\.vscode` followed by
 * `-` or a word char (`.vscode-remote`, `vscode-userdata`, `.vscodeignore`) is
 * left alone by {@link rewriteConfigFolder}.
 */
const SWEEP_REL = 'src/vs/workbench';
const SCAN_REL = 'src/vs';
const SKIP_DIR = /^(test|node_modules)$/;
const TS_FILE = /\.[cm]?ts$/;
const SKIP_FILE = /\.test\.[cm]?ts$/;
const BARE_VSCODE = /\.vscode(?![\w-])/;

/** Pure: `.vscode` → `.osiris`, leaving `.vscode-remote` / `.vscodeignore` alone. */
export function rewriteConfigFolder(source) {
  return source.replace(/\.vscode(?![\w-])/g, '.osiris');
}

async function* walkTs(dir, rel) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_DIR.test(entry.name)) yield* walkTs(path.join(dir, entry.name), childRel);
    } else if (TS_FILE.test(entry.name) && !SKIP_FILE.test(entry.name)) {
      yield { abs: path.join(dir, entry.name), rel: childRel };
    }
  }
}

/** Rewrite the sweep tree and scan the wider tree. Pure-ish: returns what it did. */
export async function sweepConfigFolder(checkoutDir) {
  const changed = [];
  for await (const file of walkTs(path.join(checkoutDir, SWEEP_REL), SWEEP_REL)) {
    const before = await readFile(file.abs, 'utf8');
    const after = rewriteConfigFolder(before);
    if (after !== before) {
      await writeFile(file.abs, after);
      changed.push(file.rel);
    }
  }

  const stray = [];
  for await (const file of walkTs(path.join(checkoutDir, SCAN_REL), SCAN_REL)) {
    const text = await readFile(file.abs, 'utf8');
    text.split('\n').forEach((line, i) => {
      if (BARE_VSCODE.test(line)) stray.push({ file: file.rel, line: i + 1, text: line.trim() });
    });
  }
  return { changed, stray };
}

async function renameWorkspaceConfigFolder(checkoutDir) {
  if (!existsSync(path.join(checkoutDir, SWEEP_REL))) {
    throw new Error(
      `[branding] config-folder rename: ${SWEEP_REL} not found — upstream layout moved`,
    );
  }
  const { changed, stray } = await sweepConfigFolder(checkoutDir);
  if (changed.length === 0) {
    throw new Error(
      '[branding] config-folder rename: swept src/vs/workbench but nothing changed — verify manually',
    );
  }
  console.log(`[branding] config-folder rename: .vscode → .osiris in ${changed.length} file(s)`);
  if (stray.length > 0) {
    const sample = stray
      .slice(0, 20)
      .map((s) => `  ${s.file}:${s.line}  ${s.text}`)
      .join('\n');
    throw new Error(
      `[branding] config-folder rename: ${stray.length} stray ".vscode" reference(s) outside the sweep — ` +
        `extend SWEEP_REL or handle them:\n${sample}`,
    );
  }
}

async function place(from, to, label) {
  if (!existsSync(from)) return false;
  await mkdir(path.dirname(to), { recursive: true });
  await copyFile(from, to);
  console.log(`[branding] ${label}: ${path.basename(to)}`);
  return true;
}

/**
 * @param {string} checkoutDir  the cloned upstream repo root
 * @param {{ kind: 'desktop' | 'web' }} options
 */
export async function copyBrandingIntoCheckout(checkoutDir, { kind }) {
  const icons = await ensureIcons();
  const R = (...p) => path.join(checkoutDir, ...p);

  // --- Application / installer icons -------------------------------------------------
  if (kind === 'desktop') {
    await place(
      path.join(icons, 'linux', 'code.png'),
      R('resources', 'linux', 'code.png'),
      'linux icon',
    );
    await place(
      path.join(icons, 'darwin', 'code.icns'),
      R('resources', 'darwin', 'code.icns'),
      'darwin icon',
    );
    await place(
      path.join(icons, 'win32', 'code.ico'),
      R('resources', 'win32', 'code.ico'),
      'win32 icon',
    );
    await place(
      path.join(icons, 'win32', 'code_70x70.png'),
      R('resources', 'win32', 'code_70x70.png'),
      'win32 tile',
    );
    await place(
      path.join(icons, 'win32', 'code_150x150.png'),
      R('resources', 'win32', 'code_150x150.png'),
      'win32 tile',
    );

    // Empty-editor watermark.
    const lpDir = R('src', 'vs', 'workbench', 'browser', 'parts', 'editor', 'media');
    for (const variant of ['dark', 'light', 'hc']) {
      await place(
        path.join(assetsDir, `letterpress-${variant}.svg`),
        path.join(lpDir, `letterpress-${variant}.svg`),
        'letterpress',
      );
    }
  }

  // Server favicon + PWA icons — both distributions ship the REH server.
  await place(
    path.join(icons, 'server', 'favicon.ico'),
    R('resources', 'server', 'favicon.ico'),
    'server favicon',
  );
  await place(
    path.join(icons, 'server', 'code-192.png'),
    R('resources', 'server', 'code-192.png'),
    'server pwa',
  );
  await place(
    path.join(icons, 'server', 'code-512.png'),
    R('resources', 'server', 'code-512.png'),
    'server pwa',
  );

  // --- Bundled Fira Code -----------------------------------------------------------
  const woff2 = path.join(assetsDir, 'fonts', 'FiraCode-VF.woff2');
  for (const mediaDir of [
    R('src', 'vs', 'workbench', 'browser', 'media'),
    R('src', 'vs', 'code', 'browser', 'workbench'),
  ]) {
    if (existsSync(mediaDir)) {
      await place(woff2, path.join(mediaDir, 'FiraCode-VF.woff2'), 'font');
    }
  }
  await place(
    path.join(assetsDir, 'fonts', 'OFL.txt'),
    R('ThirdPartyNotices-FiraCode.txt'),
    'font license',
  );
  await registerFontFace(checkoutDir);
  await renameWorkspaceConfigFolder(checkoutDir);

  return { icons };
}

/** Overwrite `apps/osiris-desktop/build/` with the electron-builder icon resources. */
export async function copyElectronBuilderIcons(buildDir) {
  const icons = await ensureIcons();
  await mkdir(path.join(buildDir, 'icons'), { recursive: true });
  await cp(path.join(icons, 'electron', 'icons'), path.join(buildDir, 'icons'), {
    recursive: true,
  });
  await copyFile(path.join(icons, 'electron', 'icon.ico'), path.join(buildDir, 'icon.ico'));
  await copyFile(path.join(icons, 'electron', 'icon.icns'), path.join(buildDir, 'icon.icns'));
  console.log('[branding] electron-builder icons → build/{icons,icon.ico,icon.icns}');
}
