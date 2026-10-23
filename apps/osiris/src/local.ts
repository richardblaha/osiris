import { execFileSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { userInfo } from "node:os";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { FEATURES, NO_QUOTAS, type Feature, type MeResponse, type ProjectFeatures, type ProjectInfo } from "@osiris/shared";
import type { FeatureSource } from "@osiris/core/projects/features.ts";
import type { Project } from "@osiris/core/projects/project.ts";
import type { InternalUser } from "@osiris/platform/internal-auth.ts";
import type { AuthEnv } from "./auth.ts";

/** What needs a running server: WhatsApp, scheduled tasks and the public assistants' pages. */
const SERVER_FEATURES: Feature[] = ["whatsapp", "scheduler", "public"];

/** A local agent's features: everything but what needs a server, no quotas, no system rules. */
export class LocalFeatures implements FeatureSource {
  private readonly on = Object.fromEntries(FEATURES.map((f) => [f, !SERVER_FEATURES.includes(f)])) as ProjectFeatures;
  async get() {
    return this.on;
  }
  async enabled(feature: Feature) {
    return this.on[feature];
  }
  async disabledTools() {
    return [];
  }
  async quotas() {
    return NO_QUOTAS;
  }
  async systemGuards() {
    return [];
  }
}

/** Who uses a local agent: the computer's user, named as in their git config when there is one. */
export function localUser(): InternalUser {
  const git = (key: string) => {
    try {
      return execFileSync("git", ["config", "--get", key], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
    } catch {
      return null;
    }
  };
  const login = userInfo().username;
  return { sub: `local:${login}`, name: git("user.name") ?? login, email: git("user.email"), phone: null, picture: null };
}

export interface LocalAccess {
  /** The token in `.osiris/private/local-token`: whoever can read the project folder may use its agent. */
  token: string;
  user: InternalUser;
  /** The project's name to show (the folder's). */
  name: string;
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Local calls: the agent's own token makes the caller the project's admin, on the web channel. */
export function localAuth(project: Project, local: LocalAccess) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const token = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    if (!token || !same(token, local.token)) throw new HTTPException(401, { message: "Unauthorized" });
    c.set("ctx", { project, user: local.user, role: "admin", channel: "web" });
    await next();
  });
}

/** What the server's control answers for clients (who am I, which project), answered by the local agent itself. */
export function localRoutes(project: Project, local: LocalAccess) {
  return new Hono<AuthEnv>()
    .use(localAuth(project, local))
    .get("/me", (c) =>
      c.json<MeResponse>({
        user: { id: local.user.sub, email: local.user.email, name: local.user.name, phone: null, picture: null },
        systemAdmin: false,
        projects: [{ id: project.id, name: local.name, role: "admin", logo: null }],
        mode: "local",
      }),
    )
    .get("/project", async (c) => c.json<ProjectInfo>({ id: project.id, name: local.name, role: "admin", features: await project.features.get(), logo: null }));
}
