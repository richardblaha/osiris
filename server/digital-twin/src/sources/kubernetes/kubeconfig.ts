import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";

/**
 * A kubeconfig for the twin: the current (or a named) context's cluster and user. The twin reads the cluster, so a
 * token is what it authenticates with — `token`, `tokenFile` (`kubectl create token … --duration 0` for one that
 * doesn't expire) or the ServiceAccount of the pod it runs in. Users that authenticate with client certificates or
 * an exec plugin are refused with a message, instead of silently failing.
 */

interface KubeconfigUser {
  token?: string;
  tokenFile?: string;
  "client-certificate"?: string;
  "client-certificate-data"?: string;
  exec?: unknown;
}

interface Kubeconfig {
  "current-context"?: string;
  contexts?: { name: string; context: { cluster?: string; user?: string } }[];
  clusters?: { name: string; cluster: { server?: string; "certificate-authority"?: string; "certificate-authority-data"?: string; "insecure-skip-tls-verify"?: boolean } }[];
  users?: { name: string; user: KubeconfigUser }[];
}

/** What the kube client connects with, straight from the kubeconfig. */
export interface KubeConnection {
  server: string;
  token?: string;
  tokenPath?: string;
  /** PEM bundle that verifies the server, when the kubeconfig has a certificate authority. */
  ca?: string;
  /** `insecure-skip-tls-verify`: the server's certificate isn't checked (a development cluster's kubeconfig). */
  insecureTls?: boolean;
}

export class KubeconfigError extends Error {}

/** Reads `path` (the first of a `:`-separated KUBECONFIG list that exists) and resolves the context's connection. */
export async function loadKubeconfig(path: string, contextName?: string): Promise<KubeConnection> {
  const file = path.split(":").find(Boolean)!;
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    throw new KubeconfigError(`The kubeconfig can't be read: ${file}: ${(err as Error).message}`);
  }
  return parseKubeconfig(raw, contextName, { files: true });
}

/**
 * Resolves a kubeconfig's context from its text. Without `files` (a kubeconfig pasted into an instance's settings)
 * it may not name files on this server (`tokenFile`, `certificate-authority`): everything must be inline.
 */
export async function parseKubeconfig(raw: string, contextName?: string, options: { files?: boolean } = {}): Promise<KubeConnection> {
  let doc: Kubeconfig;
  try {
    doc = z.object({}).passthrough().parse(parse(raw)) as Kubeconfig;
  } catch (err) {
    throw new KubeconfigError(`The kubeconfig isn't valid YAML: ${(err as Error).message}`);
  }

  const context = doc.contexts?.find((c) => c.name === (contextName || doc["current-context"]));
  if (!context) throw new KubeconfigError(`The kubeconfig has no context ${JSON.stringify(contextName || doc["current-context"] || "")}`);
  const cluster = doc.clusters?.find((c) => c.name === context.context.cluster);
  if (!cluster?.cluster.server) throw new KubeconfigError(`The kubeconfig context ${context.name} has no cluster with a server`);
  const user = doc.users?.find((u) => u.name === context.context.user)?.user ?? {};

  if (user["client-certificate"] || user["client-certificate-data"] || user.exec)
    throw new KubeconfigError(
      `The kubeconfig's user ${JSON.stringify(context.context.user ?? "")} authenticates with a client certificate or an exec plugin; ` +
        "the twin reads the cluster and needs a token (kubectl create token <service-account> --duration 0)",
    );
  // certificate-authority is a PEM file on disk; certificate-authority-data the same PEM inline, base64-encoded.
  const caFile = cluster.cluster["certificate-authority"];
  if (!options.files && (caFile || user.tokenFile))
    throw new KubeconfigError("The kubeconfig names files (tokenFile, certificate-authority); put the token and certificate-authority-data in it instead");
  if (!user.token && !user.tokenFile && !options.files) throw new KubeconfigError(`The kubeconfig's user ${JSON.stringify(context.context.user ?? "")} has no token`);
  const ca = cluster.cluster["certificate-authority-data"]
    ? Buffer.from(cluster.cluster["certificate-authority-data"], "base64").toString("utf8")
    : caFile
      ? await readFile(caFile, "utf8")
      : undefined;
  return {
    server: cluster.cluster.server,
    token: user.token,
    tokenPath: user.tokenFile,
    ca,
    insecureTls: cluster.cluster["insecure-skip-tls-verify"] === true,
  };
}
