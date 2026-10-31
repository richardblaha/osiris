import { execFile } from "node:child_process";
import { egressProxy } from "../net/egress.ts";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalizedError } from "@osiris/platform/i18n.ts";
import { assertSafePublicUrl } from "../mcp/url.ts";
import { SecretUseError } from "../vault/template.ts";
import type { SecretVault } from "../vault/vault.ts";

/** The project secret with the repository's access token (a GitHub/Gitea token), used only for the repository's host. */
export const GIT_TOKEN = "GIT_TOKEN";
const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;
/** What the website's build leaves in the project, never committed. */
const IGNORED = [".vitepress/dist/", ".vitepress/cache/", "node_modules/"];

export class GitError extends LocalizedError {}

export interface GitStatus {
  connected: boolean;
  url: string | null;
  branch: string | null;
  /** Changed files not committed yet, as `git status --porcelain` lists them (`M web/index.md`). */
  changes: string[];
  ahead: number;
  behind: number;
}

/**
 * The project folder as a git working tree: connected to one https remote, committed, pulled (fast-forward only) and
 * pushed by its admins. git runs without the user's or system's config, hooks or symlinks, with the token from the
 * project's secrets given through `GIT_ASKPASS` (never in the URL or the repository's config).
 */
export class ProjectGit {
  constructor(
    private readonly root: string,
    private readonly secrets: SecretVault,
    private readonly opts: { allowPrivate?: boolean } = {},
  ) {}

  /** Runs git in the project with the safe settings, and the token when the remote's host may get it. */
  private async git(args: string[], { auth = false }: { auth?: boolean } = {}): Promise<string> {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: tmpdir(),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      // Behind the egress gate (a contained local agent), git reaches the remote only through it.
      ...(egressProxy() ? { https_proxy: egressProxy()!.href } : {}),
    };
    let askpass: string | undefined;
    if (auth) {
      const token = await this.token();
      if (token) {
        askpass = await mkdtemp(join(tmpdir(), "osiris-git-"));
        const script = join(askpass, "askpass.sh");
        await writeFile(script, '#!/bin/sh\ncase "$1" in Username*) echo "x-access-token" ;; *) echo "$OSIRIS_GIT_TOKEN" ;; esac\n', { mode: 0o700 });
        await chmod(script, 0o700);
        Object.assign(env, { GIT_ASKPASS: script, OSIRIS_GIT_TOKEN: token });
      }
    }
    const safe = ["-c", "core.hooksPath=/dev/null", "-c", "core.symlinks=false", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never", "-c", `protocol.https.allow=always`, ...(this.opts.allowPrivate ? ["-c", "protocol.http.allow=always", "-c", "protocol.file.allow=always"] : [])];
    try {
      return await new Promise<string>((resolve, reject) =>
        execFile("git", [...safe, "-C", this.root, ...args], { env, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) =>
          err ? reject(new GitError("errors.git.failed", { detail: (stderr || err.message).trim().slice(-1000) })) : resolve(stdout),
        ),
      );
    } finally {
      if (askpass) await rm(askpass, { recursive: true, force: true });
    }
  }

  /** The token, when the project has one allowed for the remote's host. */
  private async token(): Promise<string | undefined> {
    const url = await this.remote();
    if (!url) return undefined;
    try {
      return (await this.secrets.fill({ t: `{{secret:${GIT_TOKEN}}}` }, { userId: "", host: new URL(url).hostname })).filled.t;
    } catch (err) {
      if (err instanceof SecretUseError) return undefined;
      throw err;
    }
  }

  private async remote(): Promise<string | null> {
    return (await this.git(["config", "--get", "remote.origin.url"]).catch(() => "")).trim() || null;
  }

  private async branch(): Promise<string | null> {
    return (await this.git(["symbolic-ref", "--short", "HEAD"]).catch(() => "")).trim() || null;
  }

  async status(): Promise<GitStatus> {
    const url = await this.remote();
    if (!url) return { connected: false, url: null, branch: null, changes: [], ahead: 0, behind: 0 };
    const branch = await this.branch();
    const changes = (await this.git(["status", "--porcelain"])).split("\n").filter(Boolean);
    const counts = await this.git(["rev-list", "--left-right", "--count", `HEAD...origin/${branch}`]).catch(() => "0\t0");
    const [ahead = 0, behind = 0] = counts.trim().split(/\s+/).map(Number);
    return { connected: true, url, branch, changes, ahead, behind };
  }

  /**
   * Connects the project to a repository: its branch is checked out over the project's files (a file the repository
   * also has is replaced, the others stay), or, for an empty repository, the project's files become its first commit.
   */
  async connect(rawUrl: string, branch: string, author: { name: string; email: string }): Promise<GitStatus> {
    if (!BRANCH.test(branch) || branch.includes("..")) throw new GitError("errors.git.branch");
    // A local repository only in development (tests); otherwise an https URL to a public address.
    const url = this.opts.allowPrivate && rawUrl.startsWith("file://") ? rawUrl : (await assertSafePublicUrl(rawUrl, { allowPrivate: this.opts.allowPrivate })).toString();
    await this.git(["init", "-q", "-b", branch]);
    await this.git(["remote", "remove", "origin"]).catch(() => "");
    await this.git(["remote", "add", "origin", url]);
    await this.ignoreBuilds();
    await this.git(["fetch", "-q", "origin"], { auth: true });
    const exists = (await this.git(["ls-remote", "--heads", "origin", branch], { auth: true })).trim().length > 0;
    if (exists) {
      await this.git(["checkout", "-q", "-f", "-B", branch, `origin/${branch}`]);
      await this.ignoreBuilds();
    } else {
      await this.git(["checkout", "-q", "-B", branch]);
      await this.commit("Osiris: první verze projektu", author);
      await this.push();
    }
    return this.status();
  }

  /** The website's build output stays out of the repository. */
  private async ignoreBuilds() {
    const file = join(this.root, ".gitignore");
    const current = await readFile(file, "utf8").catch(() => "");
    const missing = IGNORED.filter((line) => !current.split(/\r?\n/).includes(line));
    if (missing.length) await writeFile(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
  }

  /** Commits every change; false when there was nothing to commit. */
  async commit(message: string, author: { name: string; email: string }): Promise<boolean> {
    await this.git(["add", "-A"]);
    if (!(await this.git(["status", "--porcelain"])).trim()) return false;
    await this.git(["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "-q", "-m", message]);
    return true;
  }

  /** Takes the remote's new commits when they follow on (fast-forward); otherwise refuses, naming what differs. */
  async pull(): Promise<GitStatus> {
    const branch = await this.branch();
    if (!(await this.remote()) || !branch) throw new GitError("errors.git.notConnected");
    await this.git(["fetch", "-q", "origin"], { auth: true });
    try {
      await this.git(["merge", "--ff-only", "-q", `origin/${branch}`]);
    } catch {
      const files = (await this.git(["diff", "--name-only", `HEAD...origin/${branch}`]).catch(() => "")).split("\n").filter(Boolean);
      throw new GitError("errors.git.diverged", { files: files.slice(0, 20).join(", ") || "?" });
    }
    return this.status();
  }

  async push(): Promise<GitStatus> {
    const branch = await this.branch();
    if (!(await this.remote()) || !branch) throw new GitError("errors.git.notConnected");
    await this.git(["push", "-q", "origin", `${branch}:${branch}`], { auth: true });
    await this.git(["fetch", "-q", "origin"], { auth: true });
    return this.status();
  }
}
