import { readFile } from "node:fs/promises";

/**
 * How a project runtime proves to control which project it is. In the cluster it sends its projected ServiceAccount
 * token (audience `osiris-control`), and control asks the Kubernetes API (TokenReview) whose it is: the project comes
 * from the namespace `osiris-p-<slug>`, never from the request. Locally a fixed development token stands in.
 */
export interface RuntimeIdentityVerifier {
  verify(token: string): Promise<{ project: string }>;
}

export class RuntimeIdentityError extends Error {}

export const RUNTIME_AUDIENCE = "osiris-control";
export const PROJECT_NAMESPACE_PREFIX = "osiris-p-";
const SA_PATTERN = new RegExp(`^system:serviceaccount:${PROJECT_NAMESPACE_PREFIX}([a-z0-9]+(?:-[a-z0-9]+)*):runtime$`);
const CACHE_MS = 60_000;

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

/**
 * TokenReview against the in-cluster API server, authenticated with control's own ServiceAccount token. The API
 * server certificate is trusted through NODE_EXTRA_CA_CERTS (the ServiceAccount's ca.crt).
 */
export function tokenReviewVerifier({
  apiServer = "https://kubernetes.default.svc",
  ownTokenPath = `${SA_DIR}/token`,
  fetchFn = fetch,
}: { apiServer?: string; ownTokenPath?: string; fetchFn?: typeof fetch } = {}): RuntimeIdentityVerifier {
  const cache = new Map<string, { project: string; expires: number }>();
  return {
    async verify(token) {
      const now = Date.now();
      const hit = cache.get(token);
      if (hit && hit.expires > now) return { project: hit.project };
      const own = (await readFile(ownTokenPath, "utf8")).trim();
      const res = await fetchFn(`${apiServer}/apis/authentication.k8s.io/v1/tokenreviews`, {
        method: "POST",
        headers: { authorization: `Bearer ${own}`, "content-type": "application/json" },
        body: JSON.stringify({
          apiVersion: "authentication.k8s.io/v1",
          kind: "TokenReview",
          spec: { token, audiences: [RUNTIME_AUDIENCE] },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`TokenReview failed: ${res.status}`);
      const review = (await res.json()) as {
        status?: { authenticated?: boolean; audiences?: string[]; user?: { username?: string } };
      };
      const project = review.status?.authenticated && review.status.audiences?.includes(RUNTIME_AUDIENCE)
        ? SA_PATTERN.exec(review.status.user?.username ?? "")?.[1]
        : undefined;
      if (!project) throw new RuntimeIdentityError("Not a project runtime");
      if (cache.size > 1000) cache.clear();
      cache.set(token, { project, expires: now + CACHE_MS });
      return { project };
    },
  };
}

/** Development only (refused in production by config): the token is `dev-runtime:<project>`. */
export function devRuntimeVerifier(): RuntimeIdentityVerifier {
  return {
    async verify(token) {
      const project = /^dev-runtime:([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(token)?.[1];
      if (!project) throw new RuntimeIdentityError("Not a project runtime");
      return { project };
    },
  };
}

/** The runtime's side: its projected token, re-read on every call because the kubelet rotates it. */
export function runtimeToken(source: { tokenPath?: string; devProject?: string }): () => Promise<string> {
  if (source.devProject) return async () => `dev-runtime:${source.devProject}`;
  const path = source.tokenPath ?? "/var/run/secrets/osiris/token";
  return async () => (await readFile(path, "utf8")).trim();
}
