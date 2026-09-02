import { describe, expect, it } from 'vitest';
import { resolveServerConfig } from '../src/server-config.js';

describe('resolveServerConfig', () => {
  it('returns undefined without a URL', () => {
    expect(resolveServerConfig({ url: '', tokenEnv: 'X', env: {} })).toBeUndefined();
    expect(resolveServerConfig({ url: undefined, tokenEnv: undefined, env: {} })).toBeUndefined();
  });

  it('trims the URL and reads the token from the named env var', () => {
    const cfg = resolveServerConfig({
      url: 'https://osiris.example.com/',
      tokenEnv: 'MY_TOKEN',
      env: { MY_TOKEN: '  secret  ' },
    });
    expect(cfg).toEqual({ baseUrl: 'https://osiris.example.com', token: 'secret' });
  });

  it('defaults the token env var name and tolerates a missing token', () => {
    const cfg = resolveServerConfig({
      url: 'https://osiris.example.com',
      tokenEnv: '',
      env: {},
    });
    expect(cfg).toEqual({ baseUrl: 'https://osiris.example.com', token: '' });
  });
});
