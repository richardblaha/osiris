import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FileError, type FileLocation, type FileStore } from "../files/store.ts";
import { FEATURES, type Feature, type Scope, type SkillSummary } from "@osiris/shared";

/**
 * A skill is a named set of instructions. Only name + description go into the system prompt; the model pulls
 * the instructions in with the `load_skill` tool when a request matches, so many skills cost few prompt tokens.
 *
 * Bundled skills ship with the app as folders `<SKILLS_DIR>/<name>/SKILL.md` (Agent Skills layout: frontmatter
 * with `name` and `description`, then Markdown). The tenant adds its own in the same layout under `skills/` in its
 * files, which override a bundled skill of the same name.
 */
export interface Skill {
  name: string;
  description: string;
  instructions: string;
  /** Frontmatter `public: true`: the old single public assistant's skills, moved to its skill list (`migrateLegacy`). */
  public?: boolean;
  /** Frontmatter `requires: <feature>`: the skill needs that feature's tools, so it's offered only while it's on. */
  requires?: Feature;
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

  const { name = "", description = "", public: open = "", requires = "" } = meta;
  if (requires && !(FEATURES as readonly string[]).includes(requires)) throw new Error(`${file}: requires must be a feature, got "${requires}"`);
  if (!SKILL_NAME.test(name)) throw new Error(`${file}: name must be lowercase-kebab-case, got "${name}"`);
  if (!description) throw new Error(`${file}: description is required`);
  const instructions = body.trim();
  if (!instructions) throw new Error(`${file}: instructions are empty`);
  return { name, description, instructions, ...(open === "true" ? { public: true } : {}), ...(requires ? { requires: requires as Feature } : {}) };
}

/** Where skills live in the tenant's and each user's files: `skills/<name>/SKILL.md`. */
export const SKILLS_DIR = "skills";

const locationOf = (scope: Scope, userId: string): FileLocation => (scope === "tenant" ? { scope: "tenant" } : { scope: "personal", userId });

/** A skill as its SKILL.md: frontmatter with name and description, then the instructions. */
export const formatSkill = (s: Skill) =>
  `---\nname: ${s.name}\ndescription: ${s.description.replace(/\s+/g, " ").trim()}\n${s.public ? "public: true\n" : ""}${s.requires ? `requires: ${s.requires}\n` : ""}---\n\n${s.instructions.trim()}\n`;

/**
 * Bundled skills merged with the tenant's (`skills/` in the tenant's files); the tenant's win over bundled ones of
 * the same name. The files are read on every call, so a
 * skill edited or added in Soubory (or by the agent) applies from the next step; a malformed one is skipped.
 */
export class SkillStore {
  private readonly bundled: Map<string, Skill>;

  constructor(
    private readonly files: FileStore,
    bundled: Skill[],
  ) {
    this.bundled = new Map(bundled.map((s) => [s.name, s]));
  }

  /** The valid skills in one scope's skills/ folder, by name. */
  private async read(scope: Scope, userId: string): Promise<Map<string, Skill>> {
    const loc = locationOf(scope, userId);
    const dirs = await this.files.list(loc, SKILLS_DIR).catch((err: FileError) => {
      if (err instanceof FileError && err.code === "not_found") return [];
      throw err;
    });
    const skills = new Map<string, Skill>();
    for (const d of dirs) {
      if (d.type !== "dir") continue;
      try {
        const { data } = await this.files.read(loc, `${d.path}/SKILL.md`);
        const skill = parseSkill(data.toString("utf8"), `${d.path}/SKILL.md`);
        if (skill.name !== d.name) throw new Error(`${d.path}/SKILL.md: name "${skill.name}" must match its folder "${d.name}"`);
        skills.set(skill.name, skill);
      } catch (err) {
        if (!(err instanceof FileError && err.code === "not_found")) console.warn(`Skipping skill ${d.path}: ${(err as Error).message}`);
      }
    }
    return skills;
  }

  /** The tenant's skills and the bundled ones it doesn't replace, one per name. */
  async list(): Promise<SkillSummary[]> {
    const merged = new Map<string, SkillSummary>();
    const summary = (s: Skill, source: SkillSummary["source"]): SkillSummary => ({ name: s.name, description: s.description, source, ...(s.requires ? { requires: s.requires } : {}) });
    for (const s of this.bundled.values()) merged.set(s.name, summary(s, "bundled"));
    for (const s of (await this.read("tenant", "")).values()) merged.set(s.name, summary(s, "tenant"));
    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The tenant's own skills (not the bundled ones), for public assistants. */
  async tenantSkills(): Promise<Skill[]> {
    return [...(await this.read("tenant", "")).values()];
  }

  /** The skill of that name: the tenant's, else the bundled one. */
  async get(name: string): Promise<(Skill & { source: SkillSummary["source"] }) | undefined> {
    if (!SKILL_NAME.test(name)) return undefined;
    const tenant = (await this.read("tenant", "")).get(name);
    if (tenant) return { ...tenant, source: "tenant" };
    const bundled = this.bundled.get(name);
    return bundled && { ...bundled, source: "bundled" };
  }

  async put(skill: Skill): Promise<void> {
    if (!SKILL_NAME.test(skill.name)) throw new Error(`Invalid skill name "${skill.name}"`);
    await this.files.write({ scope: "tenant" }, `${SKILLS_DIR}/${skill.name}/SKILL.md`, Buffer.from(formatSkill(skill)));
  }

  /** Deletes the tenant's skill (bundled ones can't be deleted; deleting a replacement reveals the bundled one). */
  async delete(name: string): Promise<boolean> {
    if (!SKILL_NAME.test(name)) return false;
    return this.files.delete({ scope: "tenant" }, `${SKILLS_DIR}/${name}`).then(
      () => true,
      (err) => {
        if (err instanceof FileError && err.code === "not_found") return false;
        throw err;
      },
    );
  }
}
