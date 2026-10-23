import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { build, type BuildFile, type BuildResult } from "./build.ts";

const MAX_BODY_BYTES = 100 * 1024 * 1024;

/**
 * POST /build: the site's source files as multipart form fields named by their paths; answers the built files the
 * same way, or 422 with the build's log. Reachable only from tenant runtimes, with no network of its own.
 */
export function createVitepressApp(run: (files: BuildFile[]) => Promise<BuildResult> = build) {
  // One build at a time: a build may leave nothing behind for the next tenant's.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => {});
    return next;
  };

  return new Hono()
    .get("/health", (c) => c.json({ ok: true }))
    .post("/build", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: "The site source is too large" }, 413) }), async (c) => {
      const form = await c.req.formData();
      const files: BuildFile[] = [];
      for (const [path, value] of form.entries()) {
        if (typeof value !== "string") files.push({ path, data: new Uint8Array(await value.arrayBuffer()) });
      }
      const result = await serial(() => run(files));
      if (!result.ok) return c.json({ error: result.log }, 422);
      const out = new FormData();
      for (const f of result.files) out.append(f.path, new Blob([new Uint8Array(f.data)]), "file");
      return new Response(out);
    });
}
