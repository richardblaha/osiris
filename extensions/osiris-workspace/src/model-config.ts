/**
 * Pure helpers for the per-task-class model configuration (the Osiris Start
 * wizard). Kept free of `vscode` imports so it can be unit-tested; the extension
 * passes a `vscode.WorkspaceConfiguration` (structurally a {@link ModelConfigReader}).
 */
import {
  TASK_CLASSES,
  TASK_CLASS_LABELS,
  DEFAULT_TASK_MODELS,
  type TaskClass,
} from '@osiris/protocol';

/** VS Code settings section the wizard reads and writes. */
export const MODEL_CONFIG_SECTION = 'osiris.models';

/** The model used for any class the user has not set. Ships local so Osiris works offline. */
export const DEFAULT_PROVIDER_FALLBACK = 'ollama/qwen3:4b';

export interface ModelConfigReader {
  get<T>(section: string): T | undefined;
  inspect<T>(
    section: string,
  ): { globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T } | undefined;
}

export interface ProviderInfo {
  id: string;
  label: string;
  /** Suggested model tags for the datalist; empty = free text / filled at runtime. */
  models: string[];
  /** Keychain entry (env-var name) this provider needs, if any. */
  secretEnvKey?: string;
  local?: boolean;
  /** `osiris-ai` (the chat panel) can drive this provider directly. */
  chatCapable?: boolean;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'ollama',
    label: 'Ollama — local model',
    models: ['qwen3:4b', 'qwen3:1.7b', 'qwen3:8b'],
    local: true,
    chatCapable: true,
  },
  {
    id: 'anthropic',
    label: 'Anthropic API',
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    secretEnvKey: 'ANTHROPIC_API_KEY',
    chatCapable: true,
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible endpoint',
    models: [],
    secretEnvKey: 'OSIRIS_AI_API_KEY',
    chatCapable: true,
  },
  { id: 'vscode-lm', label: 'Editor model (Copilot / editor LM)', models: [] },
  {
    id: 'echo',
    label: 'Echo — offline, deterministic',
    models: ['echo'],
    local: true,
    chatCapable: true,
  },
];

export function providerInfo(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

const SPEC_RE = /^([\w-]+)\/([\w.:-]+)$/;

export function parseSpec(spec: string): { provider: string; model: string } | undefined {
  const m = SPEC_RE.exec(spec.trim());
  return m ? { provider: m[1]!, model: m[2]! } : undefined;
}

export function isValidSpec(spec: string): boolean {
  return SPEC_RE.test(spec.trim());
}

export interface TaskClassState {
  id: TaskClass;
  label: string;
  /** Effective spec: the user's value, else the runtime fallback. */
  spec: string;
  /** The user's own value (empty when unset). */
  userSpec: string;
  suggested: string;
  source: 'user' | 'workspace' | 'default';
}

function scopeValue(
  cfg: ModelConfigReader,
  cls: TaskClass,
): { value: string; source: 'user' | 'workspace' } | undefined {
  const i = cfg.inspect<string>(cls);
  const ws = (i?.workspaceFolderValue ?? i?.workspaceValue ?? '').toString().trim();
  if (ws) return { value: ws, source: 'workspace' };
  const user = (i?.globalValue ?? '').toString().trim();
  if (user) return { value: user, source: 'user' };
  return undefined;
}

export function taskClassStates(cfg: ModelConfigReader): TaskClassState[] {
  const fallback = (cfg.get<string>('defaultProvider') ?? '').trim() || DEFAULT_PROVIDER_FALLBACK;
  return TASK_CLASSES.map((id) => {
    const scoped = scopeValue(cfg, id);
    return {
      id,
      label: TASK_CLASS_LABELS[id],
      spec: scoped?.value ?? fallback,
      userSpec: scoped?.value ?? '',
      suggested: DEFAULT_TASK_MODELS[id],
      source: scoped?.source ?? 'default',
    };
  });
}

/** Task classes with no value set at any scope. */
export function unsetTaskClasses(cfg: ModelConfigReader): TaskClass[] {
  return TASK_CLASSES.filter((cls) => !scopeValue(cfg, cls));
}

/** `OSIRIS_MODEL_*` env for the headless crew, from whatever the user configured. */
export function taskModelEnv(cfg: ModelConfigReader): Record<string, string> {
  const env: Record<string, string> = {};
  for (const cls of TASK_CLASSES) {
    const spec = (cfg.get<string>(cls) ?? '').trim();
    if (spec) env[`OSIRIS_MODEL_${cls.toUpperCase()}`] = spec;
  }
  const def = (cfg.get<string>('defaultProvider') ?? '').trim();
  if (def) env.OSIRIS_MODEL_DEFAULT = def;
  return env;
}

/** Keychain keys (env-var names) referenced by the given specs. */
export function secretKeysFor(specs: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const spec of specs) {
    const parsed = parseSpec(spec);
    const key = parsed && providerInfo(parsed.provider)?.secretEnvKey;
    if (key) out.add(key);
  }
  return [...out];
}

export interface ModelExport {
  version: 1;
  defaultProvider?: string;
  models: Partial<Record<TaskClass, string>>;
}

export function buildExport(cfg: ModelConfigReader): ModelExport {
  const models: Partial<Record<TaskClass, string>> = {};
  for (const cls of TASK_CLASSES) {
    const spec = (cfg.get<string>(cls) ?? '').trim();
    if (spec) models[cls] = spec;
  }
  const def = (cfg.get<string>('defaultProvider') ?? '').trim();
  return { version: 1, ...(def ? { defaultProvider: def } : {}), models };
}

/** Validate an imported blob; throws on a bad shape or an invalid spec. */
export function parseImport(json: unknown): ModelExport {
  if (!json || typeof json !== 'object') throw new Error('not an object');
  const obj = json as Record<string, unknown>;
  if (obj.version !== 1) throw new Error('unsupported version (expected 1)');
  const models: Partial<Record<TaskClass, string>> = {};
  const raw = (obj.models ?? {}) as Record<string, unknown>;
  for (const [cls, spec] of Object.entries(raw)) {
    if (!(TASK_CLASSES as readonly string[]).includes(cls))
      throw new Error(`unknown task class "${cls}"`);
    if (typeof spec !== 'string' || !isValidSpec(spec))
      throw new Error(`invalid spec for "${cls}"`);
    models[cls as TaskClass] = spec.trim();
  }
  const def = obj.defaultProvider;
  if (def !== undefined && (typeof def !== 'string' || !isValidSpec(def))) {
    throw new Error('invalid defaultProvider');
  }
  return { version: 1, ...(def ? { defaultProvider: def as string } : {}), models };
}
