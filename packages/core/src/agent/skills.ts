import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import type { Scope, SkillSummary } from "@osiris/shared";

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

/** Row owner: '' for tenant-wide rows, the user's sub for personal ones. */
const ownerOf = (scope: Scope, userId: string) => (scope === "tenant" ? "" : userId);

/**
 * Bundled skills merged with one tenant's skills and the user's personal ones.
 * For a given name, personal wins over tenant, which wins over bundled.
 */
export class SkillStore {
  private readonly bundled: Map<string, Skill>;

  constructor(
    private readonly db: Client,
    bundled: Skill[],
  ) {
    this.bundled = new Map(bundled.map((s) => [s.name, s]));
  }

  /** Skills visible to `userId`, one per name. */
  async list(userId: string): Promise<SkillSummary[]> {
    const { rows } = await this.db.execute({
      // Tenant rows ('') first, so personal rows overwrite them in the map below.
      sql: "SELECT owner, name, description FROM skills WHERE owner IN ('', ?) ORDER BY owner = '' DESC",
      args: [userId],
    });
    const merged = new Map<string, SkillSummary>();
    for (const s of this.bundled.values()) merged.set(s.name, { name: s.name, description: s.description, source: "bundled" });
    for (const r of rows) {
      merged.set(String(r.name), { name: String(r.name), description: String(r.description), source: r.owner === "" ? "tenant" : "personal" });
    }
    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The skill `userId` gets for `name`, following the precedence. */
  async get(name: string, userId: string): Promise<(Skill & { source: SkillSummary["source"] }) | undefined> {
    const { rows } = await this.db.execute({
      sql: "SELECT * FROM skills WHERE name = ? AND owner IN ('', ?) ORDER BY owner = '' LIMIT 1",
      args: [name, userId],
    });
    const r = rows[0];
    if (r) {
      return { name, description: String(r.description), instructions: String(r.instructions), source: r.owner === "" ? "tenant" : "personal" };
    }
    const bundled = this.bundled.get(name);
    return bundled && { ...bundled, source: "bundled" };
  }

  async put(skill: Skill, scope: Scope, userId: string): Promise<void> {
    if (!SKILL_NAME.test(skill.name)) throw new Error(`Invalid skill name "${skill.name}"`);
    await this.db.execute({
      sql: `INSERT INTO skills (owner, name, description, instructions) VALUES (?, ?, ?, ?)
            ON CONFLICT (owner, name) DO UPDATE SET description = excluded.description,
              instructions = excluded.instructions, updated_at = datetime('now')`,
      args: [ownerOf(scope, userId), skill.name, skill.description, skill.instructions],
    });
  }

  /** Deletes a tenant or personal skill (bundled ones can't be deleted; deleting an override reveals what it hid). */
  async delete(name: string, scope: Scope, userId: string): Promise<boolean> {
    const r = await this.db.execute({ sql: "DELETE FROM skills WHERE owner = ? AND name = ?", args: [ownerOf(scope, userId), name] });
    return r.rowsAffected > 0;
  }
}
