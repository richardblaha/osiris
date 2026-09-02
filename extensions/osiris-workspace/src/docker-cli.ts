/**
 * A minimal `docker` CLI wrapper — the extension host only needs to find a
 * DevContainer by label and wake it. Heavier Docker work (freeze/thaw, images,
 * volumes) lives in `@osiris/container-sync`, used by the desktop orchestrator.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type Exec = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: Exec = (file, args) => execFileAsync(file, args);

export interface DockerContainer {
  id: string;
  /** `running`, `paused`, `exited`, … */
  state: string;
  labels: Record<string, string>;
}

/** Parse `docker`'s `{{json .Labels}}` form: `key=value,key2=value2`. */
export function parseLabels(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return out;
}

export async function findByLabel(
  label: string,
  value: string,
  exec: Exec = defaultExec,
): Promise<DockerContainer | undefined> {
  const { stdout } = await exec('docker', [
    'ps',
    '--all',
    '--filter',
    `label=${label}=${value}`,
    '--format',
    '{{.ID}}\t{{.State}}\t{{.Labels}}',
  ]);
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return undefined;
  const [id = '', state = '', labels = ''] = line.split('\t');
  return { id, state, labels: parseLabels(labels) };
}

export async function wake(container: DockerContainer, exec: Exec = defaultExec): Promise<void> {
  if (container.state === 'paused') {
    await exec('docker', ['unpause', container.id]);
  } else if (container.state !== 'running') {
    await exec('docker', ['start', container.id]);
  }
}

/** Start (or no-op if already running) the openvscode-server inside the container. */
export async function startWebIde(containerId: string, exec: Exec = defaultExec): Promise<void> {
  await exec('docker', ['exec', containerId, 'osiris-web-ide', 'start']);
}
