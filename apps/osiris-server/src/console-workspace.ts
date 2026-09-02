import { readFile } from 'node:fs/promises';
import {
  listOsirisDir,
  osirisPaths,
  resolveOsirisFile,
  type OsirisPaths,
} from '@osiris/dot-osiris';
import { BacklogRepo } from '@osiris/backlog';
import {
  buildEmbedding,
  buildMemoryStore,
  parseMemoryConfig,
  reindex,
  searchMemory,
  type MemoryConfig,
  type MemoryStore,
} from '@osiris/memory';
import { loadAgentRegistry, loadCrewSession } from '@osiris/crew';
import type {
  CrewEvent,
  CrewRunRequest,
  CrewRunResult,
  MemorySearchRequest,
} from '@osiris/protocol';
import { createLogger } from '@osiris/shared-core';
import type { ConsoleDeps } from './routes/console.js';

const log = createLogger('server:workspace');

async function memoryCorpus(paths: OsirisPaths): Promise<{ relPath: string; content: string }[]> {
  const files = await listOsirisDir(paths, 'memory', {
    recursive: true,
    filter: (rel) => rel.endsWith('.md') && rel !== 'README.md',
  });
  return Promise.all(
    files.map(async (f) => ({ relPath: f.relPath, content: await readFile(f.path, 'utf8') })),
  );
}

/**
 * Wire the console API to a real workspace on disk: the backlog orphan branch,
 * the `.osiris/memory/` corpus (ChromaDB when a URL is configured, else a
 * file-backed store under `.osiris/temp/`) and the crew from `.osiris/agents/` +
 * `crew.json`. Everything expensive is opened lazily and memoised.
 */
export function createWorkspaceConsoleDeps(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): ConsoleDeps {
  const paths = osirisPaths(workspaceRoot);

  let backlogPromise: Promise<BacklogRepo> | undefined;
  const getBacklog = (): Promise<BacklogRepo> => {
    backlogPromise ??= BacklogRepo.open({
      repoRoot: workspaceRoot,
      remote: env.OSIRIS_BACKLOG_REMOTE,
      autoPush: env.OSIRIS_BACKLOG_AUTOPUSH === '1',
    });
    return backlogPromise;
  };

  let memoryPromise: Promise<{ config: MemoryConfig; store: MemoryStore }> | undefined;
  const getMemory = (): Promise<{ config: MemoryConfig; store: MemoryStore }> => {
    memoryPromise ??= (async () => {
      const raw = (await resolveOsirisFile(paths, 'memory.json'))?.content;
      const config = parseMemoryConfig(raw, env);
      const store = await buildMemoryStore(config, {
        env,
        filePath: paths.tempFile('memory-store.json'),
      });
      if (store.constructor.name !== 'ChromaMemoryStore') {
        log.warn('no ChromaDB URL configured — using a local file-backed memory store');
      }
      return { config, store };
    })();
    return memoryPromise;
  };

  const doSearch = async (
    req: MemorySearchRequest,
  ): Promise<
    { id: string; document: string; source: string; headingPath: string; score: number }[]
  > => {
    const { config, store } = await getMemory();
    const hits = await searchMemory(req.query, {
      store,
      embed: buildEmbedding(config),
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
      const { config, store } = await getMemory();
      return reindex(await memoryCorpus(paths), {
        store,
        embed: buildEmbedding(config),
        cachePath: paths.tempFile('memory-index.json'),
        hnsw: config.index.hnsw,
        chunkSize: config.index.chunkSize,
        chunkOverlap: config.index.chunkOverlap,
      });
    },

    async runCrew(req: CrewRunRequest, onEvent: (e: CrewEvent) => void): Promise<CrewRunResult> {
      const repo = await getBacklog();
      const session = await loadCrewSession({
        paths,
        root: workspaceRoot,
        env,
        mcp: env.OSIRIS_MCP === '1',
        headlessFallback: env.OSIRIS_CREW_PROVIDER
          ? { kind: env.OSIRIS_CREW_PROVIDER as 'echo', apiKeyEnv: 'OSIRIS_AI_API_KEY' }
          : { kind: 'echo' },
        memory: { search: (q, k, source) => doSearch({ query: q, k, source }) },
        backlog: { board: () => repo.board(), task: (id) => repo.get(id) },
      });
      try {
        return await session.crew.run(req.task, { lead: req.lead, onEvent });
      } finally {
        await session.close();
      }
    },
  };
}

/** Best-effort: the workspace root the server should manage. */
export function resolveWorkspaceRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.OSIRIS_WORKSPACE_ROOT ?? process.cwd();
}
