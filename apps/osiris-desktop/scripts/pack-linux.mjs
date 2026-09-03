/**
 * Pure text transforms for the two extra Linux desktop packages we build on top
 * of the branded VSCodium prebuilt:
 *
 *   - an **AppImage** (portable, double-click / `chmod +x && ./run`)
 *   - a **snap**      (`snap install --dangerous --classic Osiris-*.snap`)
 *
 * Both wrap the exact same branded tree that `package.mjs` tars up; the layout
 * inside the wrapper is:
 *
 *   <root>/usr/share/osiris/osiris          the Electron binary (renamed)
 *   <root>/usr/share/osiris/bin/osiris      the CLI launcher shim
 *   <root>/usr/share/osiris/chrome-sandbox  the SUID sandbox helper
 *
 * The functions here only produce file *contents* — the filesystem work and the
 * `mksquashfs` / `appimagetool` calls live in `pack-appimage.mjs` / `pack-snap.mjs`.
 */

/** Where the branded app tree is placed inside every wrapper. */
export const APP_PREFIX = 'usr/share/osiris';

/**
 * A freedesktop `.desktop` entry for Osiris IDE.
 *
 * @param {object} [opts]
 * @param {string} [opts.exec]  the `Exec=` command (AppImage: `osiris`, snap: `osiris`)
 */
export function desktopEntry({ exec = 'osiris' } = {}) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Osiris IDE',
    'GenericName=Text Editor',
    'Comment=Osiris IDE — a rebranded VSCodium build',
    `Exec=${exec} %F`,
    'Icon=osiris',
    'Terminal=false',
    'StartupNotify=true',
    'StartupWMClass=Osiris',
    'Categories=Development;IDE;TextEditor;',
    'Keywords=osiris;vscode;vscodium;editor;',
    'MimeType=x-scheme-handler/osiris;text/plain;inode/directory;',
    'Actions=new-empty-window;',
    '',
    '[Desktop Action new-empty-window]',
    'Name=New Empty Window',
    `Exec=${exec} --new-window %F`,
    'Icon=osiris',
    '',
  ].join('\n');
}

/**
 * `sh` that drops the VS Code / Electron environment a *parent* editor leaks into
 * a child process — most often when the user runs the launcher from another
 * VS Code's integrated terminal. Left in place, `VSCODE_NLS_CONFIG`,
 * `VSCODE_CODE_CACHE_PATH`, `VSCODE_IPC_HOOK`, `ELECTRON_RUN_AS_NODE`, … point
 * the fresh Osiris process at the parent's install and caches.
 *
 * Only the top-level GUI launcher scrubs — Osiris sets these vars for its own
 * child processes afterwards, and the `bin/osiris` CLI keeps `VSCODE_IPC_HOOK_CLI`
 * so `osiris <file>` still opens in a running window.
 */
export function envScrubPreamble() {
  return `# Drop inherited VS Code / Electron env (e.g. launched from another editor's terminal)
for _v in $(env | sed -n 's/^\\(VSCODE_[A-Za-z0-9_]*\\)=.*/\\1/p'); do unset "$_v"; done
unset ELECTRON_RUN_AS_NODE ELECTRON_NO_ATTACH_CONSOLE VSCODE_PORTABLE
`;
}

/**
 * The AppImage `AppRun` entrypoint.
 *
 * Electron's SUID sandbox helper can't be `chmod 4755 root` inside a read-only
 * squashfs, so on a host where unprivileged user namespaces are also locked down
 * (`kernel.unprivileged_userns_clone=0`, or AppArmor's
 * `kernel.apparmor_restrict_unprivileged_userns=1` on Ubuntu 24.04+) Chromium
 * would abort with `FATAL:setuid_sandbox_host.cc`. Detect that and fall back to
 * `--no-sandbox` rather than failing to launch. `OSIRIS_SANDBOX=1` forces the
 * sandbox on; `OSIRIS_SANDBOX=0` forces it off.
 */
export function appRunScript() {
  return `#!/bin/sh
# Osiris IDE — AppImage entrypoint
HERE="$(dirname "$(readlink -f "$0")")"
APP="$HERE/${APP_PREFIX}"
export PATH="$APP/bin:$PATH"

${envScrubPreamble()}
userns_ok() {
  [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)" != "0" ] || return 1
  [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" != "1" ] || return 1
  return 0
}

SANDBOX_FLAG=""
case "\${OSIRIS_SANDBOX:-auto}" in
  0) SANDBOX_FLAG="--no-sandbox" ;;
  1) SANDBOX_FLAG="" ;;
  *) [ -u "$APP/chrome-sandbox" ] || userns_ok || SANDBOX_FLAG="--no-sandbox" ;;
esac

exec "$APP/osiris" $SANDBOX_FLAG "$@"
`;
}

/**
 * `meta/snap.yaml` for a classic-confinement dump snap. Classic confinement runs
 * in the host namespace (needed: Osiris shells out to host toolchains and the
 * bundled Electron isn't relocatable), so the snap installs with
 * `--dangerous --classic` and is not intended for Store upload as-is.
 *
 * @param {string} version  the upstream release string, e.g. `1.94.2.24286`
 * @param {string} [grade]  `stable` (default) or `devel`
 */
export function snapMeta(version, grade = 'stable') {
  return `name: osiris
version: '${version}'
summary: Osiris IDE — a rebranded VSCodium build
description: |
  Osiris IDE is a rebrand of the VSCodium prebuilt: the same editor, with the
  Osiris product identity, icons and Open VSX gallery.

  Installed with classic confinement — it has full access to the host, exactly
  like the VSCodium snap.
base: core22
confinement: classic
grade: ${grade}
apps:
  osiris:
    command: bin/osiris-launch
    environment:
      DISABLE_WAYLAND: '1'
`;
}

/** Snap `command` wrapper: scrub inherited editor env, then exec the CLI shim. */
export function snapLauncher() {
  return `#!/bin/sh
${envScrubPreamble()}exec "$SNAP/${APP_PREFIX}/bin/osiris" "$@"
`;
}
