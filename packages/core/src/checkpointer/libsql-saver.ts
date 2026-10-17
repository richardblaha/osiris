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
import type { Client, InArgs, InStatement, Row } from "@libsql/client";

/**
 * LangGraph checkpointer backed by libSQL / Turso.
 *
 * Follows the layout of the official `PostgresSaver`: the checkpoint row stores everything except
 * `channel_values`, which go to `checkpoint_blobs` keyed by (channel, version). `put` only writes channels
 * listed in `newVersions`, and reads join blobs via the checkpoint's `channel_versions`.
 * Tables are created by `db/migrations/001_init.sql`.
 */
export class LibSQLSaver extends BaseCheckpointSaver {
  constructor(
    private readonly db: Client,
    serde?: SerializerProtocol,
  ) {
    super(serde);
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { thread_id, checkpoint_ns = "", checkpoint_id } = config.configurable ?? {};
    if (!thread_id) return undefined;

    const { rows } = checkpoint_id
      ? await this.db.execute({
          sql: `SELECT * FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`,
          args: [thread_id, checkpoint_ns, checkpoint_id],
        })
      : await this.db.execute({
          sql: `SELECT * FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? ORDER BY checkpoint_id DESC LIMIT 1`,
          args: [thread_id, checkpoint_ns],
        });
    const row = rows[0];
    return row ? this.toTuple(row) : undefined;
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const { limit, before, filter } = options ?? {};
    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns;

    const where: string[] = [];
    const args: InArgs = [];
    if (threadId) {
      where.push("thread_id = ?");
      args.push(threadId);
    }
    if (checkpointNs !== undefined && checkpointNs !== null) {
      where.push("checkpoint_ns = ?");
      args.push(checkpointNs);
    }
    if (before?.configurable?.checkpoint_id !== undefined) {
      where.push("checkpoint_id < ?");
      args.push(before.configurable.checkpoint_id);
    }
    for (const [key, value] of Object.entries(filter ?? {})) {
      if (value === undefined) continue;
      where.push("(CAST(metadata AS TEXT) -> ?) = json(?)");
      args.push(`$.${key}`, JSON.stringify(value));
    }

    let sql = "SELECT * FROM checkpoints";
    if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
    sql += " ORDER BY checkpoint_id DESC";
    if (limit) sql += ` LIMIT ${Number.parseInt(String(limit), 10)}`;

    const { rows } = await this.db.execute({ sql, args });
    for (const row of rows) {
      yield await this.toTuple(row);
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns ?? "";
    const parentCheckpointId = config.configurable?.checkpoint_id ?? null;
    if (!threadId) throw new Error(`Missing "thread_id" field in passed "config.configurable".`);

    const { channel_values: values = {}, ...rest } = checkpoint;
    const [[type1, serializedCheckpoint], [type2, serializedMetadata], blobs] = await Promise.all([
      this.serde.dumpsTyped(rest),
      this.serde.dumpsTyped(metadata),
      Promise.all(
        Object.entries(newVersions).map(async ([channel, version]): Promise<InStatement> => {
          // A channel can get a new version while having no value (e.g. cleared); "empty" records that.
          const [type, blob] = channel in values ? await this.serde.dumpsTyped(values[channel]) : ["empty", null];
          return {
            sql: `INSERT OR IGNORE INTO checkpoint_blobs (thread_id, checkpoint_ns, channel, version, type, blob)
                  VALUES (?, ?, ?, ?, ?, ?)`,
            args: [threadId, checkpointNs, channel, String(version), type, blob],
          };
        }),
      ),
    ]);
    if (type1 !== type2) throw new Error("Failed to serialize checkpoint and metadata to the same type.");

    await this.db.batch(
      [
        ...blobs,
        {
          sql: `INSERT OR REPLACE INTO checkpoints
                  (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [threadId, checkpointNs, checkpoint.id, parentCheckpointId, type1, serializedCheckpoint, serializedMetadata],
        },
      ],
      "write",
    );
    return { configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: checkpoint.id } };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const { thread_id, checkpoint_ns = "", checkpoint_id } = config.configurable ?? {};
    if (!thread_id) throw new Error("Missing thread_id field in config.configurable.");
    if (!checkpoint_id) throw new Error("Missing checkpoint_id field in config.configurable.");

    // Special channels (errors, interrupts, ...) have fixed indexes and are overwritten; regular writes are kept once.
    const allSpecial = writes.every(([channel]) => channel in WRITES_IDX_MAP);
    const statements = await Promise.all(
      writes.map(async ([channel, value], idx): Promise<InStatement> => {
        const [type, serialized] = await this.serde.dumpsTyped(value);
        return {
          sql: `INSERT ${allSpecial ? "OR REPLACE" : "OR IGNORE"} INTO checkpoint_writes
                  (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [thread_id, checkpoint_ns, checkpoint_id, taskId, WRITES_IDX_MAP[channel] ?? idx, channel, type, serialized],
        };
      }),
    );
    if (statements.length) await this.db.batch(statements, "write");
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.db.batch(
      ["checkpoints", "checkpoint_blobs", "checkpoint_writes"].map((table) => ({
        sql: `DELETE FROM ${table} WHERE thread_id = ?`,
        args: [threadId],
      })),
      "write",
    );
  }

  private async toTuple(row: Row): Promise<CheckpointTuple> {
    const threadId = String(row.thread_id);
    const checkpointNs = String(row.checkpoint_ns);
    const checkpointId = String(row.checkpoint_id);
    const parentId = row.parent_checkpoint_id == null ? undefined : String(row.parent_checkpoint_id);
    const type = row.type == null ? "json" : String(row.type);

    const checkpoint: Checkpoint = await this.serde.loadsTyped(type, toBytes(row.checkpoint));
    checkpoint.channel_versions ??= {};
    checkpoint.versions_seen ??= {};

    const [channelValues, pendingWrites] = await Promise.all([
      this.loadChannelValues(threadId, checkpointNs, checkpoint.channel_versions),
      this.loadWrites(threadId, checkpointNs, checkpointId),
    ]);
    checkpoint.channel_values = channelValues;
    if (checkpoint.v < 4 && parentId) await this.migratePendingSends(checkpoint, threadId, checkpointNs, parentId);

    return {
      config: { configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: checkpointId } },
      checkpoint,
      metadata: await this.serde.loadsTyped(type, toBytes(row.metadata)),
      parentConfig: parentId
        ? { configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: parentId } }
        : undefined,
      pendingWrites,
    };
  }

  private async loadChannelValues(threadId: string, checkpointNs: string, versions: ChannelVersions) {
    if (!Object.keys(versions).length) return {};
    const { rows } = await this.db.execute({
      sql: `SELECT b.channel, b.type, b.blob FROM checkpoint_blobs b
            JOIN json_each(?) v ON b.channel = v.key AND b.version = CAST(v.value AS TEXT)
            WHERE b.thread_id = ? AND b.checkpoint_ns = ? AND b.type != 'empty'`,
      args: [JSON.stringify(versions), threadId, checkpointNs],
    });
    const entries = await Promise.all(
      rows.map(async (r) => [String(r.channel), await this.serde.loadsTyped(String(r.type), toBytes(r.blob))] as const),
    );
    return Object.fromEntries(entries);
  }

  private async loadWrites(threadId: string, checkpointNs: string, checkpointId: string): Promise<CheckpointPendingWrite[]> {
    const { rows } = await this.db.execute({
      sql: `SELECT task_id, channel, type, value FROM checkpoint_writes
            WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
            ORDER BY task_id, idx`,
      args: [threadId, checkpointNs, checkpointId],
    });
    return Promise.all(
      rows.map(
        async (w): Promise<CheckpointPendingWrite> => [
          String(w.task_id),
          String(w.channel),
          await this.serde.loadsTyped(w.type == null ? "json" : String(w.type), toBytes(w.value)),
        ],
      ),
    );
  }

  /** Pre-v4 checkpoints kept Send packets as writes on the parent; v4+ expects them in the TASKS channel. */
  private async migratePendingSends(checkpoint: Checkpoint, threadId: string, checkpointNs: string, parentId: string) {
    const { rows } = await this.db.execute({
      sql: `SELECT type, value FROM checkpoint_writes
            WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ? AND channel = ?
            ORDER BY task_id, idx`,
      args: [threadId, checkpointNs, parentId, TASKS],
    });
    checkpoint.channel_values[TASKS] = await Promise.all(
      rows.map((r) => this.serde.loadsTyped(String(r.type), toBytes(r.value))),
    );
    const versions = Object.values(checkpoint.channel_versions);
    checkpoint.channel_versions[TASKS] = versions.length ? maxChannelVersion(...versions) : this.getNextVersion(undefined);
  }
}

function toBytes(value: unknown): Uint8Array | string {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array || typeof value === "string") return value;
  return "";
}
