import { describe, expect, it } from "vitest";
import { applyPatch, parseFilter } from "../src/scim.ts";
import { createTestAuth, createTestDb } from "./helpers.ts";

const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

describe("SCIM", () => {
  it("refuses calls without a service token", async () => {
    const auth = await createTestAuth();
    const res = await auth.app.request("/scim/v2/Users");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "401" });
    expect((await auth.app.request("/scim/v2/Users", { headers: { authorization: "Bearer osiris_scim_nope" } })).status).toBe(401);
  });

  it("creates, finds, patches and deletes users", async () => {
    const auth = await createTestAuth();
    const created = await auth.scim("/Users", {
      method: "POST",
      body: JSON.stringify({ schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: "Jana@Firma.cz", name: { givenName: "Jana", familyName: "Nová" } }),
    });
    expect(created.status).toBe(201);
    const jana = await created.json();
    expect(jana).toMatchObject({ userName: "jana@firma.cz", active: true, emails: [{ value: "jana@firma.cz", primary: true }], name: { givenName: "Jana", familyName: "Nová" } });
    // The same address twice is a conflict.
    expect((await auth.scim("/Users", { method: "POST", body: JSON.stringify({ userName: "jana@firma.cz" }) })).status).toBe(409);

    const found = await (await auth.scim(`/Users?filter=${encodeURIComponent('userName eq "JANA@firma.cz"')}`)).json();
    expect([found.totalResults, found.Resources[0].id]).toEqual([1, jana.id]);
    expect((await (await auth.scim(`/Users?filter=${encodeURIComponent('emails.value eq "x@y.cz"')}`)).json()).totalResults).toBe(0);
    expect((await auth.scim(`/Users?filter=${encodeURIComponent('userName co "jana"')}`)).status).toBe(400);

    const patched = await auth.scim(`/Users/${jana.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        schemas: [PATCH],
        Operations: [
          { op: "replace", path: "phoneNumbers", value: [{ value: "+420600111222", type: "mobile" }] },
          { op: "replace", value: { name: { familyName: "Stará" }, active: false } },
        ],
      }),
    });
    expect(await patched.json()).toMatchObject({ phoneNumbers: [{ value: "+420600111222" }], name: { givenName: "Jana", familyName: "Stará" }, active: false });
    const byPhone = await (await auth.scim(`/Users?filter=${encodeURIComponent('phoneNumbers.value eq "+420600111222"')}`)).json();
    expect(byPhone.totalResults).toBe(1);
    expect((await auth.scim(`/Users/${jana.id}`, { method: "PATCH", body: JSON.stringify({ schemas: [PATCH], Operations: [{ op: "remove", path: "phoneNumbers" }] }) })).status).toBe(200);
    expect((await auth.users.get(jana.id)).phone).toBeNull();

    // Disabled users get no sign-in link.
    expect((await auth.scim(`/Users/${jana.id}/signInLink`, { method: "POST", body: JSON.stringify({ purpose: "invite" }) })).status).toBe(400);
    expect((await auth.scim(`/Users/${jana.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await auth.scim(`/Users/${jana.id}`)).status).toBe(404);
  });

  it("manages group members, which tokens then carry", async () => {
    const auth = await createTestAuth({ users: [{ id: "alice", email: "alice@firma.cz", firstName: "Alice", lastName: "" }, { id: "bob", email: null, firstName: "Bob", lastName: "" }] });
    const created = await auth.scim("/Groups", { method: "POST", body: JSON.stringify({ displayName: "project:acme", members: [{ value: "alice" }] }) });
    expect(created.status).toBe(201);
    expect((await auth.scim("/Groups", { method: "POST", body: JSON.stringify({ displayName: "project:acme" }) })).status).toBe(409);
    expect((await auth.scim("/Groups", { method: "POST", body: JSON.stringify({ displayName: "Bad Name" }) })).status).toBe(400);

    const add = await auth.scim("/Groups/project%3Aacme", { method: "PATCH", body: JSON.stringify({ schemas: [PATCH], Operations: [{ op: "add", path: "members", value: [{ value: "bob" }] }] }) });
    expect((await add.json()).members.map((m: { value: string }) => m.value)).toEqual(["alice", "bob"]);
    expect((await auth.scim("/Groups/project%3Aacme", { method: "PATCH", body: JSON.stringify({ schemas: [PATCH], Operations: [{ op: "add", path: "members", value: [{ value: "nobody" }] }] }) })).status).toBe(400);
    await auth.scim("/Groups/project%3Aacme", { method: "PATCH", body: JSON.stringify({ schemas: [PATCH], Operations: [{ op: "remove", path: 'members[value eq "alice"]' }] }) });
    expect((await auth.users.get("alice")).groups).toEqual([]);
    expect((await (await auth.scim("/Users/bob")).json()).groups).toMatchObject([{ value: "project:acme" }]);
    expect((await (await auth.scim(`/Groups?filter=${encodeURIComponent('displayName eq "project:acme"')}`)).json()).totalResults).toBe(1);
    expect((await auth.scim("/Groups/project%3Aacme", { method: "PATCH", body: JSON.stringify({ schemas: [PATCH], Operations: [{ op: "replace", path: "displayName", value: "x" }] }) })).status).toBe(400);
    expect((await auth.scim("/Groups/project%3Aacme", { method: "DELETE" })).status).toBe(204);
    expect((await auth.users.get("bob")).groups).toEqual([]);
  });

  it("parses only the filters it supports and patches nested and filtered paths", () => {
    expect(parseFilter('userName eq "a@b.cz" and active eq true')).toEqual([{ attr: "username", value: "a@b.cz" }, { attr: "active", value: "true" }]);
    expect(() => parseFilter('userName sw "a"')).toThrow();
    const r = applyPatch({ name: { givenName: "A", familyName: "B" }, members: [{ value: "x" }, { value: "y" }] }, {
      schemas: [PATCH],
      Operations: [{ op: "replace", path: "name.givenName", value: "C" }, { op: "remove", path: 'members[value eq "x"]' }],
    });
    expect(r).toEqual({ name: { givenName: "C", familyName: "B" }, members: [{ value: "y" }] });
    expect(() => applyPatch({}, { Operations: [] })).toThrow();
  });
});
