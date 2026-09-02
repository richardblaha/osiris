import { readFile } from 'node:fs/promises';
import { listOsirisDir, osirisPaths, resolveOsirisFile, type OsirisPaths } from '@osiris/dot-osiris';
import { BacklogRepo } from '@osiris/backlog';
import {
  buildEmbedding,
  buildMemoryStore,
  parseMemoryConfig,
  reindex,
  searchMemory,
  type MemoryConfig,
  type ReindexReport,
  type SearchResult,
} from '@osiris/memory';
import { loadAgentRegistry, loadCrew } from '@osiris/crew';
import type { AgentDefinition, CrewEvent, CrewRunResult } from '@osiris/protocol';

/** Everything the CLI needs from one workspace, opened lazily. */
export class WorkspaceServices {
  readonly paths: OsirisPaths;
  private backlog?: Promise<BacklogRepo>;
  private memory?: Promise<{ config: MemoryConfig; store: Awaited<ReturnType<typeof buildMemoryStore>> }>;

  constructor(
    readonly root: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.paths = osirisPaths(root);
  }

  openBacklog(): Promise<BacklogRepo> {
    this.backlog ??= BacklogRepo.open({ repoRoot: this.root });
    return this.backlog;
  }

  private async openMemory(): Promise<{
    config: MemoryConfig;
    store: Awaited<ReturnType<typeof buildMemoryStore>>;
  }> {
    this.memory ??= (async () => {
      const raw = (await resolveOsirisFile(this.paths, 'memory.json'))?.content;
      const config = parseMemoryConfig(raw, this.env);
      const store = await buildMemoryStore(config, {
        env: this.env,
        filePath: this.paths.tempFile('memory-store.json'),
      });
      return { config, store };
    })();
    return this.memory;
  }

  async corpus(): Promise<{ relPath: string; content: string }[]> {
    const files = await listOsirisDir(this.paths, 'memory', {
      recursive: true,
      filter: (rel) => rel.endsWith('.md') && rel !== 'README.md',
    });
    return Promise.all(
      files.map(async (f) => ({ relPath: f.relPath, content: await readFile(f.path, 'utf8') })),
    );
  }

  async reindexMemory(): Promise<ReindexReport> {
    const { config, store } = await this.openMemory();
    return reindex(await this.corpus(), {
      store,
      embed: buildEmbedding(config),
      cachePath: this.paths.tempFile('memory-index.json'),
      hnsw: config.index.hnsw,
      chunkSize: config.index.chunkSize,
      chunkOverlap: config.index.chunkOverlap,
    });
  }

  async searchMemory(query: string, k: number): Promise<SearchResult[]> {
    const { config, store } = await this.openMemory();
    return searchMemory(query, { store, embed: buildEmbedding(config), k });
  }

  async listAgents(): Promise<AgentDefinition[]> {
    return (await loadAgentRegistry(this.paths)).list();
  }

  async runCrew(
    task: string,
    lead: string | undefined,
    onEvent: (e: CrewEvent) => void,
  ): Promise<CrewRunResult> {
    const repo = await this.openBacklog();
    const crew = await loadCrew({
      paths: this.paths,
      root: this.root,
      env: this.env,
      headlessFallback: this.env.OSIRIS_CREW_PROVIDER
        ? { kind: this.env.OSIRIS_CREW_PROVIDER as 'echo', apiKeyEnv: 'OSIRIS_AI_API_KEY' }
        : { kind: 'echo' },
      memory: {
        search: async (q, k) =>
          (await this.searchMemory(q, k)).map((h) => ({
            document: h.document,
            source: String(h.metadata.source ?? ''),
            headingPath: String(h.metadata.headingPath ?? ''),
            score: h.score,
          })),
      },
      backlog: { board: () => repo.board(), task: (id) => repo.get(id) },
    });
    return crew.run(task, { lead, onEvent });
  }
}
