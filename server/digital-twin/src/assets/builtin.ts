import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { glbProblems } from "./glb.ts";

/** A built-in 3D asset: the same in every twin, made by `web/scripts/assets.mjs` (no badge or brand). */
export interface BuiltinAsset {
  name: string;
  type: string;
  bytes: Uint8Array;
  sha256: string;
}

const DIR = fileURLToPath(new URL("../../assets/", import.meta.url));

/**
 * The built-in 3D assets every twin has (`server/digital-twin/assets/*.glb`: a mini PC, a router, a switch, a USB
 * disk), which the views' presets place; an instance's own asset of the same name wins. Each is checked like an
 * uploaded one, so a broken file is left out (and logged) rather than served.
 */
export function builtinAssets(dir = DIR): Map<string, BuiltinAsset> {
  const out = new Map<string, BuiltinAsset>();
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".glb"));
  } catch {
    return out;
  }
  for (const name of files.sort()) {
    const bytes = new Uint8Array(readFileSync(dir + name));
    const problems = glbProblems(bytes);
    if (problems.length) {
      console.error(`The built-in asset ${name} is left out: ${problems.join("; ")}`);
      continue;
    }
    out.set(name, { name, type: "model/gltf-binary", bytes, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return out;
}
