import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const bin = join(import.meta.dirname, "../bin/osiris.mjs");
/** The osiris command over a folder, without model keys (it fails at the models, after the lock). */
const osiris = (folder: string) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [bin, folder, "--port", "0"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: mkdtempSync(join(tmpdir(), "osiris-home-")), OSIRIS_CONTAINER: "0" }, timeout: 60_000 }) };
  } catch (err) {
    return { code: (err as { status: number }).status, out: String((err as { stdout: string }).stdout) };
  }
};

describe("the osiris command", () => {
  it("leaves a folder to the agent starting there, and takes over a lock left by a crash", () => {
    const folder = mkdtempSync(join(tmpdir(), "osiris-lock-"));
    const lock = join(folder, ".osiris/private/agent.lock");
    mkdirSync(join(folder, ".osiris/private"), { recursive: true });
    writeFileSync(lock, String(process.pid));
    expect(osiris(folder)).toMatchObject({ code: 0, out: expect.stringContaining("starting over") });
    expect(existsSync(lock)).toBe(true);

    // Older than any start: left from a crash.
    utimesSync(lock, new Date(Date.now() - 600_000), new Date(Date.now() - 600_000));
    expect(osiris(folder).code).toBe(1);
    expect(readFileSync(join(folder, ".osiris/private/agent-error"), "utf8")).toMatch(/API key/);
    expect(existsSync(lock)).toBe(false);
  }, 120_000);
});
