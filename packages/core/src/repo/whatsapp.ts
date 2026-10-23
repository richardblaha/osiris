import { userDir, type Records } from "../projects/records.ts";

// WhatsApp state of one user in one project: `private/users/<sub>/whatsapp.json`.

export interface WhatsAppSession {
  threadId: string | null;
  /** When the user last picked this project with `/project` (epoch ms), or null if never. */
  selectedAt: number | null;
}

const file = (userId: string) => `${userDir(userId)}/whatsapp.json`;

export async function getSession(records: Records, userId: string): Promise<WhatsAppSession | null> {
  return (await records.read<WhatsAppSession>(file(userId))) ?? null;
}

const patch = (records: Records, userId: string, change: Partial<WhatsAppSession>) =>
  records.update<WhatsAppSession>(file(userId), (s) => ({ threadId: null, selectedAt: null, ...s, ...change }));

export async function selectProject(records: Records, userId: string, at: number): Promise<void> {
  await patch(records, userId, { selectedAt: at });
}

/** Sets the thread WhatsApp messages go to; null makes the next message start a new one. */
export async function setThread(records: Records, userId: string, threadId: string | null): Promise<void> {
  await patch(records, userId, { threadId });
}
