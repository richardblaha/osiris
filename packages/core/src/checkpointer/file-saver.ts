import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  TASKS,
  WRITES_IDX_MAP,
  maxChannelVersion,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol,
} from "@langchain/langgraph-checkpoint";
import { fromIdName, idName, type Records } from "../projects/records.ts";

/** Serialized bytes in a JSON record. */
type Stored = { type: string; data: string };
type StoredCheckpoint = { parent: string | null; checkpoint: Stored; metadata: Stored };
type StoredWrite = { task: string; idx: number; channel: string; value: Stored };

const THREADS = "private/threads";
const threadDir = (thread: string) => `${THREADS}/${idName(thread)}/checkpoints`;
// The default namespace is "", which can't be a folder name.
const nsDir = (thread: string, ns: string) => `${threadDir(thread)}/ns-${idName(ns)}`;
const nsOf = (dir: string) => fromIdName(dir.slice(3));

const encode = ([type, bytes]: [string, Uint8Array | string]): Stored => ({ type, data: Buffer.from(bytes).toString("base64") });
const decode = (s: Stored) => new Uint8Array(Buffer.from(s.data, "base64"));

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * LangGraph checkpointer over files: `private/threads/<thread>/checkpoints/ns-<ns>/` holds `cp/<id>.json` (the
 * checkpoint without channel values, and its metadata), `blobs/<channel>/<version>.json` (each channel value once per
 * version, as `PostgresSaver` keeps them) and `writes/<id>/<task>.<idx>.json` (pending writes).
 */
export class FileSaver extends BaseCheckpointSaver {
  constructor(
    private readonly records: Records,
    serde?: SerializerProtocol,
  ) {
    super(serde);
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { thread_id, checkpoint_ns = "", checkpoint_id } = config.configurable ?? {};
    if (!thread_id) return undefined;
    const id = checkpoint_id ?? (await this.ids(thread_id, checkpoint_ns))[0];
    return id ? this.tuple(thread_id, checkpoint_ns, id) : undefined;
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const { limit, before, filter } = options ?? {};
    const threadId: string | undefined = config.configurable?.thread_id;
    const ns: string | undefined = config.configurable?.checkpoint_ns ?? undefined;
    const found: { thread: string; ns: string; id: string }[] = [];
    const threads = threadId ? [threadId] : (await this.records.list(THREADS)).map(fromIdName);
    for (const thread of threads) {
      const spaces = ns !== undefined ? [ns] : (await this.records.list(threadDir(thread))).filter((d) => d.startsWith("ns-")).map(nsOf);
      for (const space of spaces) for (const id of await this.ids(thread, space)) found.push({ thread, ns: space, id });
    }
    const beforeId = before?.configurable?.checkpoint_id;
    let left = limit ? Number.parseInt(String(limit), 10) : Infinity;
    for (const c of found.filter((c) => beforeId === undefined || c.id < beforeId).sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))) {
      if (left <= 0) return;
      const tuple = await this.tuple(c.thread, c.ns, c.id);
      if (!tuple) continue;
      if (Object.entries(filter ?? {}).some(([k, v]) => v !== undefined && !equal((tuple.metadata as Record<string, unknown>)?.[k], v))) continue;
      left--;
      yield tuple;
    }
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata, newVersions: ChannelVersions): Promise<RunnableConfig> {
    const threadId = config.configurable?.thread_id;
    const ns = config.configurable?.checkpoint_ns ?? "";
    const parent = config.configurable?.checkpoint_id ?? null;
    if (!threadId) throw new Error(`Missing "thread_id" field in passed "config.configurable".`);
    const dir = nsDir(threadId, ns);

    const { channel_values: values = {}, ...rest } = checkpoint;
    const [cp, meta] = await Promise.all([this.serde.dumpsTyped(rest), this.serde.dumpsTyped(metadata)]);
    if (cp[0] !== meta[0]) throw new Error("Failed to serialize checkpoint and metadata to the same type.");
    for (const [channel, version] of Object.entries(newVersions)) {
      const file = `${dir}/blobs/${idName(channel)}/${idName(String(version))}.json`;
      if (await this.records.modified(file)) continue;
      // A channel can get a new version while having no value (e.g. cleared); "empty" records that.
      const value: Stored = channel in values ? encode(await this.serde.dumpsTyped(values[channel])) : { type: "empty", data: "" };
      await this.records.write(file, value);
    }
    await this.records.write(`${dir}/cp/${idName(checkpoint.id)}.json`, { parent, checkpoint: encode(cp), metadata: encode(meta) } satisfies StoredCheckpoint);
    return { configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: checkpoint.id } };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const { thread_id, checkpoint_ns = "", checkpoint_id } = config.configurable ?? {};
    if (!thread_id) throw new Error("Missing thread_id field in config.configurable.");
    if (!checkpoint_id) throw new Error("Missing checkpoint_id field in config.configurable.");
    // Special channels (errors, interrupts, ...) have fixed indexes and are overwritten; regular writes are kept once.
    const allSpecial = writes.every(([channel]) => channel in WRITES_IDX_MAP);
    const dir = `${nsDir(thread_id, checkpoint_ns)}/writes/${idName(checkpoint_id)}`;
    for (const [i, [channel, value]] of writes.entries()) {
      const idx = WRITES_IDX_MAP[channel] ?? i;
      const file = `${dir}/${idName(taskId)}.${idx < 0 ? `m${-idx}` : idx}.json`;
      if (!allSpecial && (await this.records.modified(file))) continue;
      await this.records.write(file, { task: taskId, idx, channel, value: encode(await this.serde.dumpsTyped(value)) } satisfies StoredWrite);
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.records.remove(threadDir(threadId));
  }

  /** Threads derived from one (a workflow's `<id>:workflow` and its steps' `<id>:workflow:<step>`), removed with it. */
  async deleteDerivedThreads(threadId: string): Promise<void> {
    for (const dir of await this.records.list(THREADS)) {
      if (fromIdName(dir).startsWith(`${threadId}:`)) await this.records.remove(`${THREADS}/${dir}`);
    }
  }

  /** A namespace's checkpoint ids, newest first. */
  private async ids(thread: string, ns: string): Promise<string[]> {
    return (await this.records.list(`${nsDir(thread, ns)}/cp`))
      .filter((n) => n.endsWith(".json"))
      .map((n) => fromIdName(n.slice(0, -5)))
      .sort()
      .reverse();
  }

  private async tuple(threadId: string, ns: string, id: string): Promise<CheckpointTuple | undefined> {
    const dir = nsDir(threadId, ns);
    const stored = await this.records.read<StoredCheckpoint>(`${dir}/cp/${idName(id)}.json`);
    if (!stored) return undefined;
    const checkpoint: Checkpoint = await this.serde.loadsTyped(stored.checkpoint.type, decode(stored.checkpoint));
    checkpoint.channel_versions ??= {};
    checkpoint.versions_seen ??= {};
    const [values, pendingWrites] = await Promise.all([this.values(dir, checkpoint.channel_versions), this.writes(dir, id)]);
    checkpoint.channel_values = values;
    if (checkpoint.v < 4 && stored.parent) await this.migratePendingSends(checkpoint, dir, stored.parent);
    const at = (checkpoint_id: string) => ({ configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id } });
    return {
      config: at(id),
      checkpoint,
      metadata: await this.serde.loadsTyped(stored.metadata.type, decode(stored.metadata)),
      parentConfig: stored.parent ? at(stored.parent) : undefined,
      pendingWrites,
    };
  }

  private async values(dir: string, versions: ChannelVersions) {
    const out: Record<string, unknown> = {};
    for (const [channel, version] of Object.entries(versions)) {
      const blob = await this.records.read<Stored>(`${dir}/blobs/${idName(channel)}/${idName(String(version))}.json`);
      if (blob && blob.type !== "empty") out[channel] = await this.serde.loadsTyped(blob.type, decode(blob));
    }
    return out;
  }

  private async storedWrites(dir: string, id: string): Promise<StoredWrite[]> {
    const all = (await this.records.all<StoredWrite>(`${dir}/writes/${idName(id)}`)).map((r) => r.value);
    return all.sort((a, b) => (a.task < b.task ? -1 : a.task > b.task ? 1 : a.idx - b.idx));
  }

  private async writes(dir: string, id: string): Promise<CheckpointPendingWrite[]> {
    return Promise.all((await this.storedWrites(dir, id)).map(async (w): Promise<CheckpointPendingWrite> => [w.task, w.channel, await this.serde.loadsTyped(w.value.type, decode(w.value))]));
  }

  /** Pre-v4 checkpoints kept Send packets as writes on the parent; v4+ expects them in the TASKS channel. */
  private async migratePendingSends(checkpoint: Checkpoint, dir: string, parentId: string) {
    const sends = (await this.storedWrites(dir, parentId)).filter((w) => w.channel === TASKS);
    checkpoint.channel_values[TASKS] = await Promise.all(sends.map((w) => this.serde.loadsTyped(w.value.type, decode(w.value))));
    const versions = Object.values(checkpoint.channel_versions);
    checkpoint.channel_versions[TASKS] = versions.length ? maxChannelVersion(...versions) : this.getNextVersion(undefined);
  }
}
