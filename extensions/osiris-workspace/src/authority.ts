/**
 * The `osiris-devcontainer` remote authority. A workspace Osiris opens always
 * carries `vscode-remote://osiris-devcontainer+<hash>/workspaces/<name>`, where
 * `<hash>` is the stable per-folder key from `@osiris/container-sync`.
 */
export const OSIRIS_AUTHORITY = 'osiris-devcontainer';

const HASH_RE = /^[0-9a-f]{6,}$/;

/** Is the current window already inside an Osiris DevContainer? */
export function isOsirisRemote(remoteName: string | undefined): boolean {
  return remoteName === OSIRIS_AUTHORITY || (remoteName?.startsWith(`${OSIRIS_AUTHORITY}+`) ?? false);
}

/** `vscode-remote://osiris-devcontainer+<hash>/workspaces/<folderName>` */
export function buildFolderUri(hash: string, folderName: string): string {
  if (!HASH_RE.test(hash)) throw new Error(`invalid devcontainer hash: ${hash}`);
  const safeName = folderName.replace(/^\/+/, '').replace(/\/+$/, '') || 'workspace';
  return `vscode-remote://${OSIRIS_AUTHORITY}+${hash}/workspaces/${safeName}`;
}

/** Extract `<hash>` from an `osiris-devcontainer+<hash>` authority string. */
export function parseAuthorityHash(authority: string): string {
  const plus = authority.indexOf('+');
  if (plus === -1 || authority.slice(0, plus) !== OSIRIS_AUTHORITY) {
    throw new Error(`not an Osiris authority: ${authority}`);
  }
  const hash = authority.slice(plus + 1);
  if (!HASH_RE.test(hash)) throw new Error(`bad hash in authority: ${authority}`);
  return hash;
}
