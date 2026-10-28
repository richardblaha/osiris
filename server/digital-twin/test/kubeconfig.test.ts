import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KubeconfigError, loadKubeconfig } from "../src/kubeconfig.ts";
import { Kube } from "../src/kube.ts";

const CA = `-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n`;
const kubeconfig = (contexts: unknown) => JSON.stringify(contexts); // JSON is valid YAML; enough for the fields used.

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "twin-kubeconfig-"));
});
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 1)); // let the file handles go
});

describe("loadKubeconfig", () => {
  it("resolves the current context's cluster and token user", async () => {
    const path = join(dir, "token.yaml");
    await writeFile(
      path,
      kubeconfig({
        "current-context": "dev",
        contexts: [{ name: "dev", context: { cluster: "dev", user: "dev" } }, { name: "other", context: { cluster: "dev", user: "dev" } }],
        clusters: [{ name: "dev", cluster: { server: "https://127.0.0.1:6443", "certificate-authority-data": Buffer.from(CA).toString("base64") } }],
        users: [{ name: "dev", user: { token: "the-token" } }],
      }),
    );
    const conn = await loadKubeconfig(path);
    expect(conn).toMatchObject({ server: "https://127.0.0.1:6443", token: "the-token", ca: CA, insecureTls: false });
    // A named context over the current one.
    expect((await loadKubeconfig(path, "other")).server).toBe("https://127.0.0.1:6443");
  });

  it("reads a token file and honours insecure-skip-tls-verify", async () => {
    const tokenFile = join(dir, "token");
    await writeFile(tokenFile, "file-token\n");
    const path = join(dir, "tokenfile.yaml");
    await writeFile(
      path,
      kubeconfig({
        "current-context": "dev",
        contexts: [{ name: "dev", context: { cluster: "dev", user: "dev" } }],
        clusters: [{ name: "dev", cluster: { server: "https://dev.internal:6443", "insecure-skip-tls-verify": true } }],
        users: [{ name: "dev", user: { tokenFile } }],
      }),
    );
    expect(await loadKubeconfig(path)).toMatchObject({ server: "https://dev.internal:6443", tokenPath: tokenFile, insecureTls: true });
  });

  it("refuses what the twin can't authenticate with or find", async () => {
    const certUser = join(dir, "cert.yaml");
    await writeFile(
      certUser,
      kubeconfig({
        "current-context": "c",
        contexts: [{ name: "c", context: { cluster: "c", user: "u" } }],
        clusters: [{ name: "c", cluster: { server: "https://c" } }],
        users: [{ name: "u", user: { "client-certificate-data": "x" } }],
      }),
    );
    await expect(loadKubeconfig(certUser)).rejects.toThrowError(KubeconfigError);
    const execUser = join(dir, "exec.yaml");
    await writeFile(
      execUser,
      kubeconfig({
        "current-context": "c",
        contexts: [{ name: "c", context: { cluster: "c", user: "u" } }],
        clusters: [{ name: "c", cluster: { server: "https://c" } }],
        users: [{ name: "u", user: { exec: { command: "aws" } } }],
      }),
    );
    await expect(loadKubeconfig(execUser)).rejects.toThrowError(/token/);
    await expect(loadKubeconfig(join(dir, "missing.yaml"))).rejects.toThrowError(/can't be read/);
  });
});

describe("the twin reads any cluster through its kubeconfig", () => {
  let token = "";
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.statusCode = 401;
      return void res.end("{}");
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ items: [{ metadata: { name: "osiris" }, status: { phase: "Active" } }] }));
  });
  beforeAll(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)));
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("uses the kubeconfig's server and token, not the ServiceAccount's", async () => {
    token = "kubeconfig-token";
    const path = join(dir, "live.yaml");
    await writeFile(
      path,
      kubeconfig({
        "current-context": "c",
        contexts: [{ name: "c", context: { cluster: "c", user: "u" } }],
        clusters: [{ name: "c", cluster: { server: `http://127.0.0.1:${(server.address() as { port: number }).port}` } }],
        users: [{ name: "u", user: { token } }],
      }),
    );
    const conn = await loadKubeconfig(path);
    const kube = new Kube({ apiServer: conn.server, token: conn.token });
    const namespaces = await kube.namespaces();
    expect(namespaces[0]!.metadata.name).toBe("osiris");
  });
});
