import { readFile } from "node:fs/promises";
import { timingSafeEqual, createHash } from "node:crypto";

/** Who may ask the alerts service: the digital twin's API, by its ServiceAccount's projected token. */
export interface CallerVerifier {
  verify(token: string): Promise<void>;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * TokenReview against the in-cluster API server: the token must be for `audience` and belong to `username`
 * (`system:serviceaccount:osiris:digital-twin`). Answers are kept a minute.
 */
export function tokenReviewCaller({
  username,
  audience,
  apiServer = "https://kubernetes.default.svc",
  ownTokenPath = "/var/run/secrets/kubernetes.io/serviceaccount/token",
  fetchFn = fetch,
}: {
  username: string;
  audience: string;
  apiServer?: string;
  ownTokenPath?: string;
  fetchFn?: typeof fetch;
}): CallerVerifier {
  const ok = new Map<string, number>();
  return {
    async verify(token) {
      const now = Date.now();
      if ((ok.get(token) ?? 0) > now) return;
      const own = (await readFile(ownTokenPath, "utf8")).trim();
      const res = await fetchFn(`${apiServer}/apis/authentication.k8s.io/v1/tokenreviews`, {
        method: "POST",
        headers: { authorization: `Bearer ${own}`, "content-type": "application/json" },
        body: JSON.stringify({ apiVersion: "authentication.k8s.io/v1", kind: "TokenReview", spec: { token, audiences: [audience] } }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`TokenReview failed: ${res.status}`);
      const review = (await res.json()) as { status?: { authenticated?: boolean; audiences?: string[]; user?: { username?: string } } };
      if (!review.status?.authenticated || !review.status.audiences?.includes(audience) || review.status.user?.username !== username) throw new Error("Not the digital twin");
      if (ok.size > 100) ok.clear();
      ok.set(token, now + 60_000);
    },
  };
}

/** Development: one fixed token (ALERTS_DEV_TOKEN), compared in constant time. */
export function devCaller(token: string): CallerVerifier {
  return {
    async verify(given) {
      if (!timingSafeEqual(digest(given), digest(token))) throw new Error("Wrong token");
    },
  };
}
