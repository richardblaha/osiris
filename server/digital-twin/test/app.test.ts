import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ServiceError } from "@osiris/platform/http.ts";
import { createApp } from "../src/app.ts";
import { noCache } from "../src/cache.ts";
import { loadConfig } from "../src/config.ts";
import { Kube } from "../src/kube.ts";
import { ClickHouse, Telemetry } from "../src/telemetry.ts";
import { devVerifier } from "../src/auth.ts";
import type { TokenVerifier } from "../src/auth.ts";
import type { Cache } from "../src/cache.ts";
import type { TwinNode } from "@osiris/shared";

const config = loadConfig({ NODE_ENV: "test", AUTH_URL: "http://localhost:3003", CLICKHOUSE_URL: "http://ch", CLICKHOUSE_PASSWORD: "pw" });

/** A Kubernetes API that answers the twin's five questions from one pod and one namespace. */
const kubeFetch = vi.fn(async (url: string | URL | Request): Promise<Response> => {
  const path = new URL(String(url)).pathname;
  const items = (items: unknown[]) => Response.json({ items });
  if (path === "/api/v1/namespaces") return items([{ metadata: { name: "osiris" }, status: { phase: "Active" } }]);
  if (path === "/api/v1/pods")
    return items([
      {
        metadata: { name: "gateway-abc", namespace: "osiris", ownerReferences: [{ kind: "ReplicaSet", name: "gateway-rs", apiVersion: "apps/v1" }] },
        spec: { nodeName: "node1" },
        status: { phase: "Running", podIP: "10.0.0.1", containerStatuses: [{ name: "app", ready: true, restartCount: 0, image: "osiris:main" }] },
      },
    ]);
  if (path === "/api/v1/nodes") return items([{ metadata: { name: "node1" }, status: { nodeInfo: { kubeletVersion: "v1.33.0" } } }]);
  if (path === "/apis/apps/v1/replicasets")
    return items([{ metadata: { name: "gateway-rs", namespace: "osiris", ownerReferences: [{ kind: "Deployment", name: "gateway" }] } }]);
  if (path === "/version") return Response.json({ gitVersion: "v1.33.0" });
  return Response.json({}, { status: 404 });
});

/** ClickHouse answering one log record, whatever the SQL asks. */
const chFetch = vi.fn(async (): Promise<Response> =>
  Response.json({
    data: [
      {
        ts: "1730000000000",
        severity: "ERROR",
        severityNumber: "17",
        service: "gateway",
        namespace: "osiris",
        pod: "gateway-abc",
        body: "boom",
        traceId: "0123456789abcdef0123456789abcdef",
        spanId: "0123456789abcdef",
        attributes: { k: "v" },
        resource: { "k8s.pod.name": "gateway-abc" },
      },
    ],
  }),
);

/** A cache that counts loads and misses on demand. */
function countingCache() {
  const loads: string[] = [];
  const store = new Map<string, unknown>();
  const cache: Cache = {
    async get<T>(key: string): Promise<T | undefined> {
      return store.get(key) as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      store.set(key, value);
      loads.push(key);
    },
  };
  return { loads, cache };
}

const app = (over: { verifier?: TokenVerifier; cache?: Cache; telemetry?: Telemetry } = {}) =>
  createApp(config, {
    kube: new Kube({ apiServer: "https://kube", token: "t", fetchFn: kubeFetch }),
    telemetry: over.telemetry ?? new Telemetry(new ClickHouse("http://ch", "osiris", "pw", chFetch as unknown as typeof fetch)),
    verifier: over.verifier ?? devVerifier(),
    cache: over.cache ?? noCache,
  });

/** Finds a node by a path of names (or kinds), for walking into the twin's tree. */
const node = (n: TwinNode, ...path: string[]): TwinNode | undefined => {
  if (!path.length) return n;
  const [head, ...rest] = path;
  const child = n.children.find((c) => c.name === head || c.kind === head);
  return child ? node(child, ...rest) : undefined;
};

describe("the twin API", () => {
  it("serves the cluster's tree, built from the Kubernetes API, with DTDL ids", async () => {
    const res = await app().request("/api/twin");
    expect(res.status).toBe(200);
    const twin = (await res.json()) as { cluster: TwinNode };
    expect(twin.cluster.name).toBe("k8s");
    expect(twin.cluster.properties.version).toBe("v1.33.0");
    const pod = node(twin.cluster, "osiris", "gateway", "gateway-abc")!;
    expect(pod).toMatchObject({ kind: "pod", model: "dtmi:osiris:k8s:Pod;1" });
    expect(pod.properties.node).toBe("node1");
    expect(pod.children[0]!.kind).toBe("container");
  });

  it("serves the DTDL documents that define the tree's interfaces", async () => {
    const res = await app().request("/api/twin/model");
    expect(res.status).toBe(200);
    const docs = (await res.json()) as { "@id": string; "@type": string }[];
    expect(docs).toHaveLength(5);
    expect(docs[0]!["@id"]).toBe("dtmi:osiris:k8s:Cluster;1");
  });

  it("caches the tree: the second answer doesn't ask the Kubernetes API again", async () => {
    const { cache, loads } = countingCache();
    const instance = app({ cache });
    await instance.request("/api/twin");
    const calls = kubeFetch.mock.calls.length;
    await instance.request("/api/twin");
    expect(kubeFetch.mock.calls.length).toBe(calls);
    expect(loads).toContain("twin:tree");
  });

  it("answers the logs page's query and caches it", async () => {
    const { cache, loads } = countingCache();
    const instance = app({ cache });
    const res = await instance.request("/api/logs?namespace=osiris&pod=gateway-abc&severity=error");
    expect(res.status).toBe(200);
    const logs = (await res.json()) as { body: string; ts: number; severityNumber: number }[];
    expect(logs[0]).toMatchObject({ body: "boom", ts: 1730000000000, severityNumber: 17 });
    const calls = chFetch.mock.calls.length;
    await instance.request("/api/logs?namespace=osiris&pod=gateway-abc&severity=error");
    expect(chFetch.mock.calls.length).toBe(calls);
    expect(loads.some((k) => k.startsWith("twin:logs:"))).toBe(true);
  });

  it("refuses a bad query", async () => {
    const res = await app().request("/api/logs?limit=9999");
    expect(res.status).toBe(400);
  });
});

describe("the PWA's static files", () => {
  const dir = join(tmpdir(), "twin-static");
  beforeAll(async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "index.html"), "<html><body>twin index</body></html>");
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(join(dir, "assets", "app.js"), "console.log('twin')");
  });
  afterAll(() => void rm(dir, { recursive: true, force: true }));

  it("serves the app's files, and the index.html for every other path", async () => {
    const instance = createApp(config, {
      kube: new Kube({ apiServer: "https://kube", token: "t", fetchFn: kubeFetch }),
      verifier: devVerifier(),
      cache: noCache,
      staticDir: dir,
    });
    const asset = await instance.request("/assets/app.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(await asset.text()).toContain("console.log");
    for (const path of ["/", "/logs", "/callback"]) {
      const page = await instance.request(path);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("twin index"); // the fallback, not a missing file
    }
    const svg = await instance.request("/favicon.svg");
    expect(await svg.text()).toContain("twin index"); // a missing file is also the index.html
  });
});

describe("sign-in", () => {
  const refuse: TokenVerifier = {
    async identify() {
      throw new Error("no");
    },
  };
  const allow: TokenVerifier = {
    async identify(token: string) {
      if (token !== "good") throw new ServiceError("bad token", 401);
      return { sub: "u", name: "User", email: null, groups: ["admin"] };
    },
  };

  it("answers only with a bearer token when a verifier is set", async () => {
    const instance = app({ verifier: allow });
    expect((await instance.request("/api/twin")).status).toBe(401);
    expect((await instance.request("/api/twin", { headers: { authorization: "Bearer bad" } })).status).toBe(401);
    expect((await instance.request("/api/twin", { headers: { authorization: "Bearer good" } })).status).toBe(200);
    expect((await instance.request("/api/me", { headers: { authorization: "Bearer good" } })).status).toBe(200);
  });

  it("the public auth config is readable without signing in, the API is not", async () => {
    const instance = app({ verifier: refuse });
    expect((await instance.request("/auth-config.json")).status).toBe(200);
    expect((await instance.request("/api/twin")).status).toBe(401);
  });

  it("tells the PWA where osiris-auth is", async () => {
    const res = await app().request("/auth-config.json");
    expect(await res.json()).toEqual({ issuer: "http://localhost:3003", clientId: "digital-twin" });
  });
});
