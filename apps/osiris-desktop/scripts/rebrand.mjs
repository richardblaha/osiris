/**
 * Pure transforms for rebranding a VSCodium prebuilt into Osiris IDE.
 *
 * We overlay the Osiris product identity onto the shipped `product.json` but
 * deliberately keep a few upstream-owned keys: `builtInExtensions` (their
 * bundled set + download hashes), `checksums` / `commit` / `date` / `version`
 * (VSCode's own integrity metadata) and the `extensionsGallery` template
 * (VSCodium already points it at Open VSX with a working resource template).
 */

/** Keys we never take from the overlay when rebranding a prebuilt. */
export const PREBUILT_PROTECTED_KEYS = [
  'builtInExtensions',
  'checksums',
  'commit',
  'date',
  'version',
  'release',
  'extensionsGallery',
  'webviewContentExternalBaseUrlTemplate',
];

/** Drop the keys that must stay upstream-owned; returns a new object. */
export function curateOverlayForPrebuilt(overlay) {
  const out = {};
  for (const [key, value] of Object.entries(overlay)) {
    if (PREBUILT_PROTECTED_KEYS.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * @param {object} upstreamProduct  the shipped product.json (parsed)
 * @param {object} overlay          the Osiris overlay (parsed)
 * @param {(t: object, s: object) => object} mergeDeep
 */
export function brandProductJson(upstreamProduct, overlay, mergeDeep) {
  return mergeDeep(upstreamProduct, curateOverlayForPrebuilt(overlay));
}

/**
 * The upstream ⇄ Osiris executable/basename renames for one platform. VSCodium
 * ships everything as `codium`; Osiris wants `osiris`. Returns `[from, to]`
 * pairs relative to the app directory.
 *
 * @param {'linux-x64'|'darwin-x64'|'darwin-arm64'|'win32-x64'} platformKey
 */
export function binaryRenames(platformKey) {
  if (platformKey.startsWith('linux')) {
    return [
      ['codium', 'osiris'],
      ['bin/codium', 'bin/osiris'],
      ['resources/completions/bash/codium', 'resources/completions/bash/osiris'],
      ['resources/completions/zsh/_codium', 'resources/completions/zsh/_osiris'],
    ];
  }
  if (platformKey.startsWith('win32')) {
    return [
      ['VSCodium.exe', 'Osiris.exe'],
      ['bin/codium', 'bin/osiris'],
      ['bin/codium.cmd', 'bin/osiris.cmd'],
    ];
  }
  // macOS: leave the signed .app bundle structure intact for the alpha.
  return [];
}

/** The small `bin/` launcher scripts that hard-code the upstream binary name. */
export function launcherScripts(platformKey) {
  if (platformKey.startsWith('linux')) return ['bin/osiris'];
  if (platformKey.startsWith('win32')) return ['bin/osiris', 'bin/osiris.cmd'];
  return [];
}

/**
 * Rewrite an upstream `codium` launcher script to point at the renamed `osiris`
 * binary. Order matters: `VSCodium` before `vscodium` before `codium` so the
 * `.vscodium-server` data-folder token resolves to `.osiris-server` cleanly.
 */
export function patchLauncherScript(source) {
  return source
    .replaceAll('VSCodium', 'Osiris')
    .replaceAll('vscodium', 'osiris')
    .replaceAll('codium', 'osiris');
}

/** Final artifact basename for a platform, e.g. `Osiris-linux-x64`. */
export function artifactName(platformKey, release) {
  return `Osiris-${platformKey}-${release}`;
}
