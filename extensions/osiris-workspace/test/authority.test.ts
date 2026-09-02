import { describe, expect, it } from 'vitest';
import {
  OSIRIS_AUTHORITY,
  buildFolderUri,
  isOsirisRemote,
  parseAuthorityHash,
} from '../src/authority.js';

describe('isOsirisRemote', () => {
  it('matches the bare authority and the +hash form', () => {
    expect(isOsirisRemote(OSIRIS_AUTHORITY)).toBe(true);
    expect(isOsirisRemote(`${OSIRIS_AUTHORITY}+deadbeef0000`)).toBe(true);
  });
  it('rejects other remotes and undefined', () => {
    expect(isOsirisRemote('dev-container+abc')).toBe(false);
    expect(isOsirisRemote('ssh-remote')).toBe(false);
    expect(isOsirisRemote(undefined)).toBe(false);
  });
});

describe('buildFolderUri / parseAuthorityHash', () => {
  it('round-trips the hash', () => {
    const uri = buildFolderUri('a1b2c3d4e5f6', 'my-project');
    expect(uri).toBe('vscode-remote://osiris-devcontainer+a1b2c3d4e5f6/workspaces/my-project');
    const authority = uri.slice('vscode-remote://'.length, uri.indexOf('/', 'vscode-remote://'.length));
    expect(parseAuthorityHash(authority)).toBe('a1b2c3d4e5f6');
  });

  it('rejects a bad hash', () => {
    expect(() => buildFolderUri('nope', 'x')).toThrow();
    expect(() => parseAuthorityHash('osiris-devcontainer+zzz')).toThrow();
    expect(() => parseAuthorityHash('dev-container+a1b2c3d4e5f6')).toThrow(/not an Osiris/);
  });
});
