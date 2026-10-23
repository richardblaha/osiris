import { deepEqual, equal } from "node:assert/strict";
import { test } from "vitest";
import { fromPath, toPath, SETTINGS_PARTS, type View } from "../src/routes.ts";

test("every view survives a round trip through its URL", () => {
  const views: [View, string | undefined][] = [
    [{ kind: "chat", threadId: null, session: 0 }, "acme"],
    [{ kind: "chat", threadId: "a/b c", session: 0 }, "acme"],
    [{ kind: "list", section: "mcp" }, "acme"],
    [{ kind: "item", section: "knowledge", id: "public/cenik.md" }, "acme"],
    [{ kind: "item", section: "secrets", id: null }, "acme"],
    [{ kind: "files" }, "acme"],
    [{ kind: "users" }, "acme"],
    [{ kind: "profile" }, undefined],
    [{ kind: "tenants", initial: null }, undefined],
    [{ kind: "tenants", initial: "acme" }, undefined],
    [{ kind: "traces", traceId: "abc" }, undefined],
    [{ kind: "settings" }, undefined],
    ...SETTINGS_PARTS.map((part): [View, undefined] => [{ kind: "settings", part }, undefined]),
    [{ kind: "logs", traceId: "abc" }, undefined],
    [{ kind: "metrics" }, undefined],
  ];
  for (const [view, tenant] of views) deepEqual(fromPath(toPath(view, tenant)!), tenant ? { tenant, view } : { view });
});

test("a tenant's view needs a tenant; unknown URLs aren't the workspace's", () => {
  equal(toPath({ kind: "files" }, undefined), undefined);
  for (const p of ["/", "/login", "/c/acme", "/t/acme/nope", "/t/acme/chat", "/system/x", "/system/settings/unknown", "/system/settings/persona/extra", "/t/acme/%E0"]) equal(fromPath(p), undefined);
});
