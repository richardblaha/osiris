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
 * Bundled skills merged with the tenant's (`skills/` in the tenant's files) and each user's (`skills/` in theirs):
 * personal wins over tenant, which wins over bundled. The files are read on every call, so a
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

  /**
   * Every layer's skills `userId` sees: bundled, the tenant's and their own. For one name, personal wins over tenant,
   * which wins over bundled; the ones that lose are listed `overridden`.
   */
  async list(userId = ""): Promise<SkillSummary[]> {
    const summary = (s: Skill, source: SkillSummary["source"]): SkillSummary => ({ name: s.name, description: s.description, source, ...(s.requires ? { requires: s.requires } : {}) });
    const [tenant, personal] = await Promise.all([this.read("tenant", ""), userId ? this.read("personal", userId) : new Map<string, Skill>()]);
    const layers: [Iterable<Skill>, SkillSummary["source"]][] = [[personal.values(), "personal"], [tenant.values(), "tenant"], [this.bundled.values(), "bundled"]];
    const won = new Set<string>();
    const out: SkillSummary[] = [];
    for (const [skills, source] of layers) {
      for (const s of skills) out.push(won.has(s.name) ? { ...summary(s, source), overridden: true } : summary(s, source));
      for (const s of out) won.add(s.name);
    }
    const rank = { personal: 0, tenant: 1, bundled: 2 };
    return out.sort((a, b) => a.name.localeCompare(b.name) || rank[a.source] - rank[b.source]);
  }

  /** The tenant's own skills (not the bundled ones), for public assistants. */
  async tenantSkills(): Promise<Skill[]> {
    return [...(await this.read("tenant", "")).values()];
  }

  /** The skill `userId` gets for `name` (their own, else the tenant's, else the bundled one), or one layer's (`source`). */
  async get(name: string, userId = "", source?: SkillSummary["source"]): Promise<(Skill & { source: SkillSummary["source"] }) | undefined> {
    if (!SKILL_NAME.test(name)) return undefined;
    if (userId && (!source || source === "personal")) {
      const personal = (await this.read("personal", userId)).get(name);
      if (personal || source) return personal && { ...personal, source: "personal" };
    }
    if (!source || source === "tenant") {
      const tenant = (await this.read("tenant", "")).get(name);
      if (tenant || source) return tenant && { ...tenant, source: "tenant" };
    }
    const bundled = this.bundled.get(name);
    return bundled && { ...bundled, source: "bundled" };
  }

  async put(skill: Skill, scope: Scope = "tenant", userId = ""): Promise<void> {
    if (!SKILL_NAME.test(skill.name)) throw new Error(`Invalid skill name "${skill.name}"`);
    await this.files.write(locationOf(scope, userId), `${SKILLS_DIR}/${skill.name}/SKILL.md`, Buffer.from(formatSkill(skill)));
  }

  /** Deletes a tenant or personal skill (bundled ones can't be deleted; deleting a replacement reveals what it hid). */
  async delete(name: string, scope: Scope = "tenant", userId = ""): Promise<boolean> {
    if (!SKILL_NAME.test(name)) return false;
    return this.files.delete(locationOf(scope, userId), `${SKILLS_DIR}/${name}`).then(
      () => true,
      (err) => {
        if (err instanceof FileError && err.code === "not_found") return false;
        throw err;
      },
    );
  }
}
