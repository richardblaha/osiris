import { readFile } from 'node:fs/promises';
import {
  listOsirisDir,
  osirisPaths,
  resolveOsirisFile,
  type OsirisPaths,
} from '@osiris/dot-osiris';
import { BacklogRepo } from '@osiris/backlog';
import {
  ChromaMemoryStore,
  DEFAULT_HNSW,
  InMemoryMemoryStore,
  createEmbedding,
  reindex,
  searchMemory,
  type EmbeddingFn,
  type MemoryStore,
} from '@osiris/memory';
import { expandEnv, loadAgentRegistry, loadCrew } from '@osiris/crew';
import type { CrewEvent, CrewRunRequest, CrewRunResult, MemorySearchRequest } from '@osiris/protocol';
import { createLogger } from '@osiris/shared-core';
import type { ConsoleDeps } from './routes/console.js';

const log = createLogger('server:workspace');

interface MemoryJson {
  chroma?: { url?: string; collection?: string };
  index?: { chunkSize?: number; chunkOverlap?: number; hnsw?: Partial<typeof DEFAULT_HNSW> };
  embedding?: { provider?: string; model?: string; endpoint?: string; dimensions?: number };
}

async function loadMemoryConfig(paths: OsirisPaths, env: NodeJS.ProcessEnv): Promise<MemoryJson> {
  const resolved = await resolveOsirisFile(paths, 'memory.json');
  if (!resolved) return {};
  try {
    return JSON.parse(expandEnv(resolved.content, env)) as MemoryJson;
  } catch {
    return {};
  }
}

async function memoryCorpus(paths: OsirisPaths): Promise<{ relPath: string; content: string }[]> {
  const files = await listOsirisDir(paths, 'memory', {
    recursive: true,
    filter: (rel) => rel.endsWith('.md') && rel !== 'README.md',
  });
  const out: { relPath: string; content: string }[] = [];
  for (const file of files) {
    out.push({ relPath: file.relPath, content: await readFile(file.path, 'utf8') });
  }
  return out;
}

/**
 * Wire the console API to a real workspace on disk: the backlog orphan branch,
 * the `.osiris/memory/` corpus (ChromaDB when `OSIRIS_CHROMA_URL` is set, else an
 * in-process store) and the crew from `.osiris/agents/` + `crew.json`.
 * Everything expensive is opened lazily and memoised.
 */
export function createWorkspaceConsoleDeps(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): ConsoleDeps {
  const paths = osirisPaths(workspaceRoot);
  const cachePath = paths.tempFile('memory-index.json');

  let backlogPromise: Promise<BacklogRepo> | undefined;
  const getBacklog = (): Promise<BacklogRepo> => {
    backlogPromise ??= BacklogRepo.open({ repoRoot: workspaceRoot });
    return backlogPromise;
  };

  let memoryPromise:
    | Promise<{ store: MemoryStore; embed: EmbeddingFn; config: MemoryJson }>
    | undefined;
  const getMemory = (): Promise<{ store: MemoryStore; embed: EmbeddingFn; config: MemoryJson }> => {
    memoryPromise ??= (async () => {
      const config = await loadMemoryConfig(paths, env);
      const embed = createEmbedding({
        provider: (config.embedding?.provider as 'hash') ?? 'hash',
        model: config.embedding?.model,
        endpoint: config.embedding?.endpoint,
        dimensions: config.embedding?.dimensions,
      });
      const chromaUrl = env.OSIRIS_CHROMA_URL ?? config.chroma?.url;
      const store: MemoryStore =
        chromaUrl && /^https?:\/\//.test(chromaUrl)
          ? new ChromaMemoryStore({
              url: chromaUrl,
              collection: config.chroma?.collection ?? 'osiris-memory',
            })
          : new InMemoryMemoryStore();
      if (store instanceof InMemoryMemoryStore) {
        log.warn('no ChromaDB URL — using the in-process memory store (not persisted)');
      }
      return { store, embed, config };
    })();
    return memoryPromise;
  };

  const doSearch = async (req: MemorySearchRequest): Promise<
    { id: string; document: string; source: string; headingPath: string; score: number }[]
  > => {
    const { store, embed } = await getMemory();
    const hits = await searchMemory(req.query, {
      store,
      embed,
      k: req.k,
      where: req.source ? { source: req.source } : undefined,
    });
    return hits.map((h) => ({
      id: h.id,
      document: h.document,
      source: String(h.metadata.source ?? ''),
      headingPath: String(h.metadata.headingPath ?? ''),
      score: h.score,
    }));
  };

  return {
    getBacklog,

    async listAgents() {
      return (await loadAgentRegistry(paths)).list();
    },

    async searchMemory(req) {
      return { hits: await doSearch(req) };
    },

    async reindexMemory() {
      const { store, embed, config } = await getMemory();
      const report = await reindex(await memoryCorpus(paths), {
        store,
        embed,
        cachePath,
        hnsw: { ...DEFAULT_HNSW, ...config.index?.hnsw },
        chunkSize: config.index?.chunkSize,
        chunkOverlap: config.index?.chunkOverlap,
      });
      return report;
    },

    async runCrew(req: CrewRunRequest, onEvent: (e: CrewEvent) => void): Promise<CrewRunResult> {
      const repo = await getBacklog();
      const crew = await loadCrew({
        paths,
        root: workspaceRoot,
        env,
        headlessFallback: env.OSIRIS_CREW_PROVIDER
          ? { kind: env.OSIRIS_CREW_PROVIDER as 'echo', apiKeyEnv: 'OSIRIS_AI_API_KEY' }
          : { kind: 'echo' },
        memory: { search: (q, k, source) => doSearch({ query: q, k, source }) },
        backlog: { board: () => repo.board(), task: (id) => repo.get(id) },
      });
      return crew.run(req.task, { lead: req.lead, onEvent });
    },
  };
}

/** Best-effort: the workspace root the server should manage. */
export function resolveWorkspaceRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.OSIRIS_WORKSPACE_ROOT ?? process.cwd();
}
