import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import type { SkillSummary } from "@osiris/shared";

/**
 * A skill is a named set of instructions. Only name + description go into the system prompt; the model pulls
 * the instructions in with the `load_skill` tool when a request matches, so many skills cost few prompt tokens.
 *
 * Bundled skills ship with the app as folders `<SKILLS_DIR>/<name>/SKILL.md` (Agent Skills layout: frontmatter
 * with `name` and `description`, then Markdown). Each tenant can add its own in its database, which override
 * a bundled skill of the same name.
 */
export interface Skill {
  name: string;
  description: string;
  instructions: string;
}

export const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Loads all skills from `dir`. A missing dir means no skills; a malformed SKILL.md fails startup loudly. */
export function loadSkills(dir: string): Skill[] {
  if (!existsSync(dir)) return [];
  const skills = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "SKILL.md")))
    .map((e) => {
      const file = join(dir, e.name, "SKILL.md");
      const skill = parseSkill(readFileSync(file, "utf8"), file);
      if (skill.name !== e.name) throw new Error(`${file}: name "${skill.name}" must match its folder "${e.name}"`);
      return skill;
    });
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function parseSkill(source: string, file = "SKILL.md"): Skill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!match) throw new Error(`${file}: missing --- frontmatter ---`);
  const [, head = "", body = ""] = match;

  const meta: Record<string, string> = {};
  for (const line of head.split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]!] = kv[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
  }

  const { name = "", description = "" } = meta;
  if (!SKILL_NAME.test(name)) throw new Error(`${file}: name must be lowercase-kebab-case, got "${name}"`);
  if (!description) throw new Error(`${file}: description is required`);
  const instructions = body.trim();
  if (!instructions) throw new Error(`${file}: instructions are empty`);
  return { name, description, instructions };
}

/** Bundled skills merged with one tenant's own skills (tenant wins on name clash). */
export class SkillStore {
  private readonly bundled: Map<string, Skill>;

  constructor(
    private readonly db: Client,
    bundled: Skill[],
  ) {
    this.bundled = new Map(bundled.map((s) => [s.name, s]));
  }

  async list(): Promise<SkillSummary[]> {
    const { rows } = await this.db.execute("SELECT name, description FROM skills");
    const merged = new Map<string, SkillSummary>();
    for (const s of this.bundled.values()) merged.set(s.name, { name: s.name, description: s.description, source: "bundled" });
    for (const r of rows) merged.set(String(r.name), { name: String(r.name), description: String(r.description), source: "tenant" });
    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(name: string): Promise<(Skill & { source: SkillSummary["source"] }) | undefined> {
    const { rows } = await this.db.execute({ sql: "SELECT * FROM skills WHERE name = ?", args: [name] });
    const r = rows[0];
    if (r) return { name, description: String(r.description), instructions: String(r.instructions), source: "tenant" };
    const bundled = this.bundled.get(name);
    return bundled && { ...bundled, source: "bundled" };
  }

  async put(skill: Skill): Promise<void> {
    if (!SKILL_NAME.test(skill.name)) throw new Error(`Invalid skill name "${skill.name}"`);
    await this.db.execute({
      sql: `INSERT INTO skills (name, description, instructions) VALUES (?, ?, ?)
            ON CONFLICT (name) DO UPDATE SET description = excluded.description,
              instructions = excluded.instructions, updated_at = datetime('now')`,
      args: [skill.name, skill.description, skill.instructions],
    });
  }

  /** Deletes the tenant's own skill; bundled skills can't be deleted (a deleted override reveals the bundled one). */
  async delete(name: string): Promise<boolean> {
    const r = await this.db.execute({ sql: "DELETE FROM skills WHERE name = ?", args: [name] });
    return r.rowsAffected > 0;
  }
}
