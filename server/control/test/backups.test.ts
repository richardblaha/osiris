import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readAll } from "@osiris/platform/objects.ts";
import { createTestControl } from "./helpers.ts";

async function setup() {
  const control = await createTestControl();
  await control.directory.create("acme", "ACME");
  return control;
}

describe("backups", () => {
  it("keeps the newest backups and prunes old ones beyond the minimum", async () => {
    const { backups } = await setup();
    const day = 24 * 60 * 60_000;
    for (let i = 0; i < 5; i++) await backups.store("acme", Readable.from([Buffer.from(`b${i}`)]), "daily", Date.now() - (60 - i) * day);
    expect((await readAll((await backups.latest("acme"))!.body)).toString()).toBe("b4");
    await backups.prune();
    expect((await backups.list("acme")).map((b) => b.bytes)).toHaveLength(3);
    await expect(backups.store("acme", Readable.from([]), "../x")).rejects.toThrow("Invalid backup reason");
  });
});
