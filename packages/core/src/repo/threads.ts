import type { Channel, ThreadSummary } from "@osiris/shared";
import { idName, type Records } from "../projects/records.ts";

// A thread is `private/threads/<id>/thread.json`; threads are scoped to the user (OIDC sub).

interface StoredThread {
  id: string;
  userId: string;
  channel: Channel;
  title: string | null;
  updatedAt: string;
}

const file = (id: string) => `private/threads/${idName(id)}/thread.json`;
const read = (records: Records, id: string) => records.read<StoredThread>(file(id));

// ponytail: lists by reading every thread file; an index per user once projects hold thousands of threads.
export async function listThreads(records: Records, userId: string): Promise<ThreadSummary[]> {
  const threads: StoredThread[] = [];
  for (const dir of await records.list("private/threads")) {
    const t = await records.read<StoredThread>(`private/threads/${dir}/thread.json`);
    if (t?.userId === userId) threads.push(t);
  }
  return threads
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 100)
    .map((t) => ({ id: t.id, title: t.title, channel: t.channel, updatedAt: t.updatedAt }));
}

/** Every thread that exists, by id (to drop leftovers of deleted ones). */
export async function threadIds(records: Records): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const dir of await records.list("private/threads")) {
    const t = await records.read<StoredThread>(`private/threads/${dir}/thread.json`);
    if (t) ids.add(t.id);
  }
  return ids;
}

export async function createThread(records: Records, userId: string, id: string, channel: Channel): Promise<void> {
  await records.lock(file(id), async () => {
    if (await read(records, id)) throw new Error(`Thread ${id} exists`);
    await records.write(file(id), { id, userId, channel, title: null, updatedAt: new Date().toISOString() } satisfies StoredThread);
  });
}

/** Returns true only if the thread exists and belongs to `userId`. */
export async function ownsThread(records: Records, userId: string, id: string): Promise<boolean> {
  return (await read(records, id))?.userId === userId;
}

/** Bumps `updatedAt` and sets the title from the first message if it has none yet. */
export async function touchThread(records: Records, id: string, firstMessage: string): Promise<void> {
  const title = firstMessage.replace(/\s+/g, " ").trim().slice(0, 80);
  await records.lock(file(id), async () => {
    const t = await read(records, id);
    if (t) await records.write(file(id), { ...t, title: t.title ?? (title || null), updatedAt: new Date().toISOString() });
  });
}

/** Deletes the thread with everything in its folder (checkpoints, questions). */
export async function deleteThread(records: Records, id: string): Promise<void> {
  await records.remove(`private/threads/${idName(id)}`);
}
