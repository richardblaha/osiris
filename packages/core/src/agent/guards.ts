import type { Client } from "@libsql/client";
import { GUARD_NAME, type Guard } from "@osiris/shared";
import { FileError, type FileStore } from "../files/store.ts";

/** Where the project's guards live in its files; `users/` and `assistants/` hold the users' and public assistants'. */
export const GUARDS_DIR = "guards";

/** Guards are the admins' (and each user's own); the agent's file tools never write there, so no prompt can lift them. */
export const isGuardPath = (path: string) => path.split("/").filter(Boolean)[0] === GUARDS_DIR;

export type GuardOwner = { level: "project" } | { level: "user"; userId: string } | { level: "assistant"; assistant: string };

const dirOf = (o: GuardOwner) =>
  o.level === "project"
    ? GUARDS_DIR
    : o.level === "user"
      ? `${GUARDS_DIR}/users/${Buffer.from(o.userId).toString("base64url")}`
      : `${GUARDS_DIR}/assistants/${o.assistant}`;

/** A guard's file: optional frontmatter (description), then the rule. The name is the file's. */
export function parseGuard(name: string, source: string): Guard {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  const description = match ? (/^description:\s*(.*)$/m.exec(match[1]!)?.[1] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2") : "";
  return { name, description, rule: (match ? match[2]! : source).trim() };
}

export const formatGuard = (g: Guard) => `---\nname: ${g.name}\ndescription: ${g.description.replace(/\s+/g, " ").trim()}\n---\n\n${g.rule.trim()}\n`;

/** One level's guards as the text the prompt and the checks get. */
export const guardsText = (guards: Guard[]) =>
  guards
    .map((g) => g.rule.trim())
    .filter(Boolean)
    .join("\n");

const project = { scope: "project" } as const;

/** The project's, its users' and its public assistants' guards, one `<name>.md` each, read on every call. */
export class GuardStore {
  constructor(private readonly files: FileStore) {}

  async list(owner: GuardOwner): Promise<Guard[]> {
    const entries = await this.files.list(project, dirOf(owner)).catch((err) => {
      if (err instanceof FileError && err.code === "not_found") return [];
      throw err;
    });
    const guards: Guard[] = [];
    for (const e of entries) {
      const name = e.name.replace(/\.md$/, "");
      if (e.type !== "file" || !e.name.endsWith(".md") || !GUARD_NAME.test(name)) continue;
      guards.push(parseGuard(name, (await this.files.read(project, e.path)).data.toString("utf8")));
    }
    return guards.sort((a, b) => a.name.localeCompare(b.name));
  }

  async put(owner: GuardOwner, guard: Guard): Promise<void> {
    await this.files.write(project, `${dirOf(owner)}/${guard.name}.md`, Buffer.from(formatGuard(guard)), { overwrite: true });
  }

  async delete(owner: GuardOwner, name: string): Promise<boolean> {
    try {
      await this.files.delete(project, `${dirOf(owner)}/${name}.md`);
      return true;
    } catch (err) {
      if (err instanceof FileError && err.code === "not_found") return false;
      throw err;
    }
  }

  /** A public assistant's guards go with it. */
  async deleteAll(owner: GuardOwner): Promise<void> {
    await this.files.delete(project, dirOf(owner)).catch((err) => {
      if (!(err instanceof FileError && err.code === "not_found")) throw err;
    });
  }

  /** Moves the rules once written in `assistant_profiles.guards` (one per line) to guard files, once. */
  async migrateProfiles(db: Client): Promise<void> {
    const { rows } = await db.execute("SELECT owner, guards FROM assistant_profiles WHERE guards <> ''");
    for (const r of rows) {
      const owner = String(r.owner);
      const to: GuardOwner | null =
        owner === "" ? { level: "project" } : owner.startsWith("@public:") ? { level: "assistant", assistant: owner.slice(8) } : owner.startsWith("@") ? null : { level: "user", userId: owner };
      if (to) await importLines(this, to, String(r.guards));
      await db.execute({ sql: "UPDATE assistant_profiles SET guards = '' WHERE owner = ?", args: [owner] });
    }
  }
}

/** Rules written one per line become a guard each (`pravidlo-1`, …), the line as its description too. */
export async function importLines(store: { put: (o: GuardOwner, g: Guard) => Promise<void> }, owner: GuardOwner, text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const [i, rule] of lines.entries()) await store.put(owner, { name: `pravidlo-${i + 1}`, description: rule.slice(0, 120), rule });
}
