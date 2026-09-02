import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseUpResult, upDevContainer, type Exec } from '../src/devcontainer-cli.js';

const ok = (stdout: string) => Promise.resolve({ stdout, stderr: '' });

describe('parseUpResult', () => {
  it('reads the trailing JSON line', () => {
    const stdout = ['[1s] Building…', JSON.stringify({ outcome: 'success', containerId: 'abc' })].join(
      '\n',
    );
    expect(parseUpResult(stdout)).toEqual({
      containerId: 'abc',
      remoteWorkspaceFolder: '/workspaces',
    });
  });

  it('throws without a containerId', () => {
    expect(() => parseUpResult('{"outcome":"error"}')).toThrow(/containerId/);
  });
});

describe('upDevContainer', () => {
  it('writes the fallback config, labels the container and starts the server', async () => {
    const hostPath = mkdtempSync(join(tmpdir(), 'osiris-up-'));
    const calls: string[][] = [];
    const exec = vi.fn<Exec>((_file, args) => {
      calls.push(args);
      if (args[0] === 'up') return ok(JSON.stringify({ containerId: 'c99' }));
      return ok('');
    });

    const result = await upDevContainer({ hostPath, hash: 'deadbeef0000', serverPort: 8000, exec });

    expect(result.containerId).toBe('c99');
    expect(readFileSync(join(hostPath, '.devcontainer', 'devcontainer.json'), 'utf8')).toContain(
      'Osiris Workspace',
    );
    expect(calls[0]).toContain('--id-label');
    expect(calls[0]).toContain('com.osiris.devcontainer.hash=deadbeef0000');
    // Fallback config already carries the feature — no --additional-features.
    expect(calls[0]).not.toContain('--additional-features');
    expect(calls.at(-1)).toEqual([
      'exec',
      '--workspace-folder',
      hostPath,
      'osiris-web-ide',
      'start',
    ]);
  });

  it('injects remote-env for agent secrets and the feature for BYO configs', async () => {
    const hostPath = mkdtempSync(join(tmpdir(), 'osiris-up-'));
    // Pre-existing config → Osiris must inject the feature.
    mkdirSync(join(hostPath, '.devcontainer'));
    writeFileSync(join(hostPath, '.devcontainer', 'devcontainer.json'), '{ "image": "x" }');

    const calls: string[][] = [];
    const exec = vi.fn<Exec>((_file, args) => {
      calls.push(args);
      return args[0] === 'up' ? ok(JSON.stringify({ containerId: 'c1' })) : ok('');
    });

    await upDevContainer({
      hostPath,
      hash: 'abc123abc123',
      serverPort: 8000,
      remoteEnv: { OSIRIS_AI_API_KEY: 'sk-test' },
      exec,
    });

    const up = calls.find((a) => a[0] === 'up')!;
    expect(up).toContain('--additional-features');
    expect(up.join(' ')).toContain('--remote-env OSIRIS_AI_API_KEY=sk-test');
  });
});
