import { GUARD_NAME, type Guard } from "@osiris/shared";
import { userDir, type Records } from "../projects/records.ts";

export type GuardOwner = { level: "project" } | { level: "user"; userId: string } | { level: "assistant"; assistant: string };

/** Where guards live: `.osiris/guards/`, a user's in their private folder, a public assistant's in its folder. */
const dirOf = (o: GuardOwner) => (o.level === "project" ? "guards" : o.level === "user" ? `${userDir(o.userId)}/guards` : `assistants/${o.assistant}/guards`);
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

/** The project's, its users' and its public assistants' guards, one `<name>.md` each, read on every call. */
export class GuardStore {
  constructor(private readonly records: Records) {}

  async list(owner: GuardOwner): Promise<Guard[]> {
    const guards: Guard[] = [];
    for (const file of await this.records.list(dirOf(owner))) {
      const name = file.replace(/\.md$/, "");
      if (!file.endsWith(".md") || !GUARD_NAME.test(name)) continue;
      const text = await this.records.readText(`${dirOf(owner)}/${file}`).catch(() => undefined);
      if (text !== undefined) guards.push(parseGuard(name, text));
    }
    return guards.sort((a, b) => a.name.localeCompare(b.name));
  }

  async put(owner: GuardOwner, guard: Guard): Promise<void> {
    if (!GUARD_NAME.test(guard.name)) throw new Error(`Invalid guard name "${guard.name}"`);
    await this.records.writeText(`${dirOf(owner)}/${guard.name}.md`, formatGuard(guard));
  }

  async delete(owner: GuardOwner, name: string): Promise<boolean> {
    return GUARD_NAME.test(name) && this.records.remove(`${dirOf(owner)}/${name}.md`);
  }

  /** A public assistant's guards go with it. */
  async deleteAll(owner: GuardOwner): Promise<void> {
    await this.records.remove(dirOf(owner));
  }
}
