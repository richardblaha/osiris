import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GeoIp, EMPTY_GEO } from "@osiris/platform/geoip.ts";
import { AuthActivity } from "../src/auth/activity.ts";
import { createTestControl } from "./helpers.ts";

describe("authentication audit metadata", () => {
  it("enriches only the selected user's history and deletes expired data without idle writes", async () => {
    const control = await createTestControl({ users: [{ id: "alice", email: "alice@example.cz" }] });
    const geo = vi.fn(() => ({ country: "CZ", region: "Prague", city: "Prague", asn: "AS123", network: "Example ISP" }));
    const audit = new AuthActivity(control.db, geo);
    await audit.record("alice", true, "pwd", "8.8.8.8", "Mozilla/5.0 (Windows) Chrome/123.0");
    expect(await audit.history("alice")).toEqual([expect.objectContaining({ success: true, ip: "8.8.8.8", country: "CZ", city: "Prague", asn: "AS123", network: "Example ISP", browser: "Chrome", os: "Windows" })]);
    expect(await audit.history("bob")).toEqual([]);
    const stored = await control.db.query<{ location: string }>("SELECT location FROM auth_events");
    expect(stored[0]!.location).not.toContain("Mozilla");
    expect(stored[0]!.location).not.toContain("8.8.8.8");
    const execute = vi.spyOn(control.db, "execute");
    await audit.cleanup();
    expect(execute).not.toHaveBeenCalled();
    await audit.cleanup(Date.now() + 91 * 86_400_000);
    expect(await audit.history("alice")).toEqual([]);
    expect(await control.db.query("SELECT id FROM auth_events")).toEqual([]);
    execute.mockRestore();
  });

  it("handles absent/corrupt GeoIP data and failed updates without blocking the application", async () => {
    const dir = mkdtempSync(join(tmpdir(), "osiris-geo-test-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeFileSync(join(dir, "city.mmdb"), "broken");
      const geo = new GeoIp(dir, dir);
      for (const ip of ["8.8.8.8", "127.0.0.1", "10.1.1.1", "::1", "::ffff:127.0.0.1", "invalid"]) expect(geo.lookup(ip)).toEqual(EMPTY_GEO);
      const fetchFn = vi.fn(async () => new Response(null, { status: 503 }));
      await geo.refresh(fetchFn as typeof fetch);
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(geo.lookup("8.8.8.8")).toEqual(EMPTY_GEO);
      // An unwritable/non-directory cache is optional too.
      const badDir = join(dir, "file");
      writeFileSync(badDir, "x");
      await expect(new GeoIp(badDir, dir).refresh(fetchFn as typeof fetch)).resolves.toBeUndefined();
    } finally { warn.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });
});
