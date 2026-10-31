import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { userDir, type Records } from "../projects/records.ts";
import { FEATURES, type Feature, type Scope, type SkillSummary } from "@osiris/shared";

/**
 * A skill is a named set of instructions. Only name + description go into the system prompt; the model pulls
 * the instructions in with the `load_skill` tool when a request matches, so many skills cost few prompt tokens.
 *
 * Bundled skills ship with the app as folders `<SKILLS_DIR>/<name>/SKILL.md` (Agent Skills layout: frontmatter
 * with `name` and `description`, then Markdown). The project adds its own in the same layout under `.osiris/skills/`,
 * which override a bundled skill of the same name; a bundled skill is never copied, so it can't be deleted.
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

/** Where skills live: `.osiris/skills/<name>/SKILL.md`, a user's in their private folder. */
export const SKILLS_DIR = "skills";

const dirOf = (scope: Scope, userId: string) => (scope === "project" ? SKILLS_DIR : `${userDir(userId)}/${SKILLS_DIR}`);

/** A skill as its SKILL.md: frontmatter with name and description, then the instructions. */
export const formatSkill = (s: Skill) =>
  `---\nname: ${s.name}\ndescription: ${s.description.replace(/\s+/g, " ").trim()}\n${s.public ? "public: true\n" : ""}${s.requires ? `requires: ${s.requires}\n` : ""}---\n\n${s.instructions.trim()}\n`;

/**
 * The bundled skills (the app's, always there while the project has skills), the project's (`.osiris/skills/`) and
 * each user's (in their private folder): personal wins over project, which wins over bundled. Deleting a project's or
 * user's copy brings back the layer below it. The files are read on every call, so a skill edited (in Osiris or in the
 * repository) applies from the next step; a malformed one is skipped.
 */
export class SkillStore {
  private readonly bundled: Map<string, Skill>;

  constructor(
    private readonly records: Records,
    bundled: Skill[],
  ) {
    this.bundled = new Map(bundled.map((s) => [s.name, s]));
  }

  /** The valid skills in one scope's skills/ folder, by name. */
  private async read(scope: Scope, userId: string): Promise<Map<string, Skill>> {
    const dir = dirOf(scope, userId);
    const skills = new Map<string, Skill>();
    for (const name of await this.records.list(dir)) {
      const text = await this.records.readText(`${dir}/${name}/SKILL.md`).catch(() => undefined);
      if (text === undefined) continue;
      try {
        const skill = parseSkill(text, `${dir}/${name}/SKILL.md`);
        if (skill.name !== name) throw new Error(`${dir}/${name}/SKILL.md: name "${skill.name}" must match its folder "${name}"`);
        skills.set(skill.name, skill);
      } catch (err) {
        console.warn(`Skipping skill ${dir}/${name}: ${(err as Error).message}`);
      }
    }
    return skills;
  }

  /**
   * Every layer's skills `userId` sees: bundled, the project's and their own. For one name, personal wins over project,
   * which wins over bundled; the ones that lose are listed `overridden`.
   */
  async list(userId = ""): Promise<SkillSummary[]> {
    const summary = (s: Skill, source: SkillSummary["source"]): SkillSummary => ({ name: s.name, description: s.description, source, ...(s.requires ? { requires: s.requires } : {}) });
    const [project, personal] = await Promise.all([this.read("project", ""), userId ? this.read("personal", userId) : new Map<string, Skill>()]);
    const layers: [Iterable<Skill>, SkillSummary["source"]][] = [[personal.values(), "personal"], [project.values(), "project"], [this.bundled.values(), "bundled"]];
    const won = new Set<string>();
    const out: SkillSummary[] = [];
    for (const [skills, source] of layers) {
      for (const s of skills) out.push(won.has(s.name) ? { ...summary(s, source), overridden: true } : summary(s, source));
      for (const s of out) won.add(s.name);
    }
    const rank = { personal: 0, project: 1, bundled: 2 };
    return out.sort((a, b) => a.name.localeCompare(b.name) || rank[a.source] - rank[b.source]);
  }

  /** The project's own skills (not the bundled ones), for public assistants. */
  async projectSkills(): Promise<Skill[]> {
    return [...(await this.read("project", "")).values()];
  }

  /** The skill `userId` gets for `name` (their own, else the project's, else the bundled one), or one layer's (`source`). */
  async get(name: string, userId = "", source?: SkillSummary["source"]): Promise<(Skill & { source: SkillSummary["source"] }) | undefined> {
    if (!SKILL_NAME.test(name)) return undefined;
    if (userId && (!source || source === "personal")) {
      const personal = (await this.read("personal", userId)).get(name);
      if (personal || source) return personal && { ...personal, source: "personal" };
    }
    if (!source || source === "project") {
      const project = (await this.read("project", "")).get(name);
      if (project || source) return project && { ...project, source: "project" };
    }
    const bundled = this.bundled.get(name);
    return bundled && { ...bundled, source: "bundled" };
  }

  async put(skill: Skill, scope: Scope = "project", userId = ""): Promise<void> {
    if (!SKILL_NAME.test(skill.name)) throw new Error(`Invalid skill name "${skill.name}"`);
    await this.records.writeText(`${dirOf(scope, userId)}/${skill.name}/SKILL.md`, formatSkill(skill));
  }

  /** Deletes a project or personal skill (deleting a replacement reveals the skill it hid: the project's or the bundled one). */
  async delete(name: string, scope: Scope = "project", userId = ""): Promise<boolean> {
    return SKILL_NAME.test(name) && this.records.remove(`${dirOf(scope, userId)}/${name}`);
  }
}
