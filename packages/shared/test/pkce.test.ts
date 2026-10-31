import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { newState, pkcePair } from "../src/pkce.ts";

describe("pkcePair", () => {
  it("returns a verifier whose S256 challenge is the sha256 of it, fresh every time", () => {
    const a = pkcePair();
    const b = pkcePair();
    expect(a.challenge).toBe(createHash("sha256").update(a.verifier).digest("base64url"));
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe("newState", () => {
  it("returns distinct url-safe values", () => {
    expect(newState()).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newState()).not.toBe(newState());
  });
});
