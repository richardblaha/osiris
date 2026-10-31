import { createHash, randomBytes } from "node:crypto";

// Node-only (uses node:crypto), so it is not re-exported from index.ts, which the web app bundles.

/** A PKCE pair (RFC 7636): the verifier stays with the client, its S256 challenge goes to the authorization server. */
export const pkcePair = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

/** A random state value tying a redirect back to the request that started it. */
export const newState = (bytes = 16) => randomBytes(bytes).toString("base64url");
