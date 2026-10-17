import { describe, expect, it } from "vitest";
import { PocketIdClient, type PocketIdGroup, type PocketIdUser } from "../src/pocketid.ts";
import { pocketIdTenants, TenantExistsError } from "../src/tenants/directory.ts";

/** Just enough of PocketID's admin API: groups with members, and users. */
function fakePocketId(users: PocketIdUser[], groups: (PocketIdGroup & { userIds?: string[] })[] = []) {
  let next = 1;
  const page = <T>(data: T[]) => Response.json({ data, pagination: { totalPages: 1 } });
  const view = (g: (typeof groups)[number]) => ({ id: g.id, name: g.name, friendlyName: g.friendlyName, userCount: g.userIds?.length ?? 0 });
  const fetchFn = (async (url: URL, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const [, , resource, id, sub] = url.pathname.split("/");
    if (resource === "users" && method === "GET") return page(users);
    if (resource !== "user-groups") return new Response(null, { status: 404 });
    const group = groups.find((g) => g.id === id);
    if (!id && method === "GET") return page(groups.map(view));
    if (!id && method === "POST") {
      if (groups.some((g) => g.name === body.name)) return new Response(null, { status: 409 });
      const g = { id: `g${next++}`, ...body, userIds: [] };
      groups.push(g);
      return Response.json(view(g), { status: 201 });
    }
    if (!group) return new Response(null, { status: 404 });
    if (sub === "users" && method === "PUT") group.userIds = body.userIds;
    else if (method === "PUT") Object.assign(group, body);
    else if (method === "DELETE") groups.splice(groups.indexOf(group), 1);
    else return Response.json({ ...view(group), users: users.filter((u) => group.userIds?.includes(u.id)) });
    return Response.json(view(group));
  }) as unknown as typeof fetch;
  return { groups, directory: pocketIdTenants(new PocketIdClient("https://auth.example.cz", "key", fetchFn)) };
}

describe("tenants as PocketID groups", () => {
  const users = [
    { id: "u1", firstName: "Bob", lastName: "Novák", email: "bob@example.cz" },
    { id: "u2", displayName: "Eva", email: null },
    { id: "u3", username: "off", disabled: true },
  ];

  it("lists tenants from osiris-tenant groups, including admin-only ones made by hand", async () => {
    const { directory } = fakePocketId(users, [
      { id: "a", name: "osiris-tenant-k6labs-admin", friendlyName: "Osiris: K6 Labs (správci)", userIds: ["u1"] },
      { id: "b", name: "osiris-admin", friendlyName: "Osiris admins" },
      { id: "c", name: "tenant-old", friendlyName: "old" },
    ]);
    expect(await directory.list()).toEqual([{ id: "k6labs", name: "K6 Labs", members: 1 }]);
    expect(await directory.members("k6labs")).toEqual([{ userId: "u1", name: "Bob Novák", email: "bob@example.cz", role: "admin" }]);
    expect(await directory.users()).toEqual([
      { id: "u1", name: "Bob Novák", email: "bob@example.cz" },
      { id: "u2", name: "Eva", email: null },
    ]);
  });

  it("creates, renames, assigns roles and removes", async () => {
    const { directory, groups } = fakePocketId(users);
    await directory.create("acme", "ACME");
    await expect(directory.create("acme", "Again")).rejects.toBeInstanceOf(TenantExistsError);
    expect(groups.map((g) => [g.name, g.friendlyName])).toEqual([
      ["osiris-tenant-acme-user", "Osiris: ACME"],
      ["osiris-tenant-acme-admin", "Osiris: ACME (správci)"],
    ]);

    await directory.setRole("acme", "u1", "member");
    await directory.setRole("acme", "u2", "admin");
    await directory.setRole("acme", "u1", "admin");
    expect(groups.map((g) => g.userIds)).toEqual([[], ["u2", "u1"]]);
    await directory.setRole("acme", "u2", null);
    expect((await directory.members("acme")).map((m) => [m.userId, m.role])).toEqual([["u1", "admin"]]);

    await directory.rename("acme", "ACME a.s.");
    expect(await directory.list()).toEqual([{ id: "acme", name: "ACME a.s.", members: 1 }]);
    await directory.remove("acme");
    expect(groups).toEqual([]);
    expect(await directory.list()).toEqual([]);
  });
});
