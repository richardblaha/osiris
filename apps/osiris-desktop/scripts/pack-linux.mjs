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
    command: ${APP_PREFIX}/bin/osiris
    environment:
      DISABLE_WAYLAND: '1'
`;
}
