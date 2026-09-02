import { describe, expect, it, vi } from 'vitest';
import { parseLabels, findByLabel, wake, type Exec } from '../src/docker-cli.js';
import { resolveDevContainerEndpoint } from '../src/resolver.js';

const ok = (stdout: string) => Promise.resolve({ stdout, stderr: '' });

describe('parseLabels', () => {
  it('parses docker label output', () => {
    expect(parseLabels('com.osiris.devcontainer.hash=abc123,com.osiris.devcontainer.port=8000')).toEqual({
      'com.osiris.devcontainer.hash': 'abc123',
      'com.osiris.devcontainer.port': '8000',
    });
  });
});

describe('findByLabel', () => {
  it('returns the first matching container', async () => {
    const exec: Exec = () => ok('c1\tpaused\tcom.osiris.devcontainer.hash=abc,com.osiris.devcontainer.port=8000\n');
    const found = await findByLabel('com.osiris.devcontainer.hash', 'abc', exec);
    expect(found).toEqual({
      id: 'c1',
      state: 'paused',
      labels: { 'com.osiris.devcontainer.hash': 'abc', 'com.osiris.devcontainer.port': '8000' },
    });
  });

  it('returns undefined when nothing matches', async () => {
    expect(await findByLabel('x', 'y', () => ok(''))).toBeUndefined();
  });
});

describe('wake', () => {
  it('unpauses a paused container and starts a stopped one', async () => {
    const calls: string[][] = [];
    const exec: Exec = (_f, args) => {
      calls.push(args);
      return ok('');
    };
    await wake({ id: 'c1', state: 'paused', labels: {} }, exec);
    await wake({ id: 'c2', state: 'exited', labels: {} }, exec);
    await wake({ id: 'c3', state: 'running', labels: {} }, exec);
    expect(calls).toEqual([
      ['unpause', 'c1'],
      ['start', 'c2'],
    ]);
  });
});

describe('resolveDevContainerEndpoint', () => {
  it('finds, wakes and returns the labelled port', async () => {
    const exec = vi.fn<Exec>((_file, args) => {
      if (args[0] === 'ps') {
        return ok('c1\tpaused\tcom.osiris.devcontainer.hash=abc,com.osiris.devcontainer.port=8123\n');
      }
      return ok('');
    });
    const endpoint = await resolveDevContainerEndpoint('abc', exec);
    expect(endpoint).toEqual({ containerId: 'c1', host: '127.0.0.1', port: 8123 });
    expect(exec).toHaveBeenCalledWith('docker', ['unpause', 'c1']);
    expect(exec).toHaveBeenCalledWith('docker', ['exec', 'c1', 'osiris-web-ide', 'start']);
  });

  it('throws when the container is missing', async () => {
    await expect(resolveDevContainerEndpoint('missing', () => ok(''))).rejects.toThrow(/no Osiris DevContainer/);
  });

  it('throws when the port label is absent', async () => {
    const exec: Exec = () => ok('c1\trunning\tcom.osiris.devcontainer.hash=abc\n');
    await expect(resolveDevContainerEndpoint('abc', exec)).rejects.toThrow(/port/);
  });
});
