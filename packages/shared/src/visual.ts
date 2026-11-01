/**
 * A model's own drawing (`presentation.visual`): parts drawn in each twin's solid, as data the views interpret —
 * never code, so a model anyone may edit can't run anything in a viewer's browser. Every part is a primitive (a box,
 * a cylinder, a sphere, a plate) placed in the solid's own frame: positions and sizes are fractions of the solid's
 * size (`[-0.5, 0.5]` spans it), so a drawing fits however big the layout makes the solid. Parts follow the twin:
 * a level that grows with a value (`fill`), a light blinking with traffic (`blink`), a part turning (`spin`), copies
 * of a part (`repeat`) and parts shown only while a value says so (`when`). With `mode: "add"` (the default) the parts
 * are drawn over the model's look; with `"replace"` instead of it (the solid keeps its outline and stays pickable).
 */
export interface DtdlVisual {
  mode?: "add" | "replace";
  parts: VisualPart[];
}

export type VisualShape = "box" | "cylinder" | "sphere" | "plane" | "gltf";
export const VISUAL_SHAPES: readonly VisualShape[] = ["box", "cylinder", "sphere", "plane", "gltf"];
/** A 3D asset's name (the instance's assets: binary glTF uploaded by admins). */
export const VISUAL_ASSET = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export type VisualAxis = "x" | "y" | "z";

/**
 * A value of the twin a part follows, by name: one of the view's readings — `fill` (how full storage is), `network`
 * (bytes/s), `load`, `io`, `cpu`, `memory`, `used`, `size` — else a property of the twin. `a/b` is one over the other
 * (`used/size`); in `when`, `name=value` compares (`status=error`).
 */
export type VisualValue = string;

/** The theme's colours a part may wear by name; else `#rrggbb`. `level` is its value's band (well, warning, error). */
export const VISUAL_COLORS = ["status", "accent", "active", "neutral", "warn", "error", "level"] as const;
export type VisualColor = (typeof VISUAL_COLORS)[number] | `#${string}`;

export interface VisualPart {
  shape: VisualShape;
  /** A `gltf` part's asset, by name: fitted into the part's size keeping its proportions, in its own materials
   * (tinted with `color` when given). */
  asset?: string;
  /** Its center as fractions of the solid's size; default the solid's center. */
  at?: [number, number, number];
  /** Its size as fractions of the solid's size (a cylinder's and a sphere's x and z their diameter); default 1. */
  size?: [number, number, number];
  /** Degrees about x, y and z. */
  rotate?: [number, number, number];
  color?: VisualColor;
  /** 0–1; default 0.8. */
  opacity?: number;
  /** Its edges drawn in its colour. */
  outline?: boolean;
  /** Shown only while the value is there and not 0, false or empty (or equals, with `name=value`). */
  when?: VisualValue;
  /** Grows from its start along `axis` (default y) as far as the value (0–1) says. */
  fill?: { value: VisualValue; axis?: VisualAxis };
  /** Blinks with the value as bytes per second: dark while idle, faster the more. */
  blink?: VisualValue;
  /** Turns about y: turns per second, or a value's (0–1) share of a turn per second. */
  spin?: number | VisualValue;
  /** `count` copies (a number or a value, at most 64), each `step` (a fraction of the solid's size) further along `axis`. */
  repeat?: { count: number | VisualValue; axis?: VisualAxis; step: number };
}

const MAX_PARTS = 64;
const VALUE = /^[A-Za-z][A-Za-z0-9_]{0,63}(\/[A-Za-z][A-Za-z0-9_]{0,63})?$/;
const CONDITION = /^[A-Za-z][A-Za-z0-9_]{0,63}(\/[A-Za-z][A-Za-z0-9_]{0,63})?(=[^\s=]{1,64})?$/;
const AXES = ["x", "y", "z"];
const PART_KEYS = new Set(["asset", "shape", "at", "size", "rotate", "color", "opacity", "outline", "when", "fill", "blink", "spin", "repeat"]);

const vec = (v: unknown, min: number, max: number) => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x) && x >= min && x <= max);

/** What's wrong with a `presentation.visual` (empty: nothing). */
export function visualErrors(id: string, v: unknown): string[] {
  const at = `${id}: presentation.visual`;
  if (!v || typeof v !== "object" || Array.isArray(v)) return [`${at} must be an object`];
  const o = v as Record<string, unknown>;
  const errors: string[] = [];
  for (const k of Object.keys(o)) if (k !== "mode" && k !== "parts") errors.push(`${at} has an unknown key ${k}`);
  if (o.mode !== undefined && o.mode !== "add" && o.mode !== "replace") errors.push(`${at}.mode must be add or replace`);
  if (!Array.isArray(o.parts)) return [...errors, `${at}.parts must be a list`];
  if (o.parts.length > MAX_PARTS) errors.push(`${at}.parts has more than ${MAX_PARTS} parts`);
  o.parts.slice(0, MAX_PARTS).forEach((part, i) => {
    const p = `${at}.parts[${i}]`;
    if (!part || typeof part !== "object" || Array.isArray(part)) return void errors.push(`${p} must be an object`);
    const x = part as Record<string, unknown>;
    for (const k of Object.keys(x)) if (!PART_KEYS.has(k)) errors.push(`${p} has an unknown key ${k}`);
    if (!VISUAL_SHAPES.includes(x.shape as VisualShape)) errors.push(`${p}.shape is not one of ${VISUAL_SHAPES.join(", ")}`);
    if (x.shape === "gltf" && !(typeof x.asset === "string" && VISUAL_ASSET.test(x.asset))) errors.push(`${p}.asset must name a 3D asset (a-z, 0-9, . _ -)`);
    if (x.shape !== "gltf" && x.asset !== undefined) errors.push(`${p}.asset belongs to a gltf part only`);
    if (x.at !== undefined && !vec(x.at, -10, 10)) errors.push(`${p}.at must be three numbers from -10 to 10`);
    if (x.size !== undefined && (!vec(x.size, 0, 10) || (x.size as number[]).some((n) => n <= 0))) errors.push(`${p}.size must be three numbers above 0, at most 10`);
    if (x.rotate !== undefined && !vec(x.rotate, -360, 360)) errors.push(`${p}.rotate must be three angles in degrees`);
    if (x.color !== undefined && !(typeof x.color === "string" && ((VISUAL_COLORS as readonly string[]).includes(x.color) || /^#[0-9a-fA-F]{6}$/.test(x.color))))
      errors.push(`${p}.color must be #rrggbb or one of ${VISUAL_COLORS.join(", ")}`);
    if (x.opacity !== undefined && !(typeof x.opacity === "number" && x.opacity >= 0 && x.opacity <= 1)) errors.push(`${p}.opacity must be from 0 to 1`);
    if (x.outline !== undefined && typeof x.outline !== "boolean") errors.push(`${p}.outline must be a boolean`);
    if (x.when !== undefined && !(typeof x.when === "string" && CONDITION.test(x.when))) errors.push(`${p}.when must be a value's name (or name=value)`);
    if (x.blink !== undefined && !(typeof x.blink === "string" && VALUE.test(x.blink))) errors.push(`${p}.blink must be a value's name`);
    if (x.spin !== undefined && !(typeof x.spin === "string" ? VALUE.test(x.spin) : typeof x.spin === "number" && Number.isFinite(x.spin) && Math.abs(x.spin) <= 10))
      errors.push(`${p}.spin must be turns per second (at most 10) or a value's name`);
    if (x.fill !== undefined) {
      const f = x.fill as Record<string, unknown>;
      if (!f || typeof f !== "object" || typeof f.value !== "string" || !VALUE.test(f.value) || (f.axis !== undefined && !AXES.includes(f.axis as string)) || Object.keys(f).some((k) => k !== "value" && k !== "axis"))
        errors.push(`${p}.fill must be { value, axis? }`);
    }
    if (x.repeat !== undefined) {
      const r = x.repeat as Record<string, unknown>;
      const count = r?.count;
      const okCount = typeof count === "string" ? VALUE.test(count) : Number.isInteger(count) && (count as number) >= 0 && (count as number) <= MAX_PARTS;
      if (!r || typeof r !== "object" || !okCount || typeof r.step !== "number" || !Number.isFinite(r.step) || Math.abs(r.step) > 10 || (r.axis !== undefined && !AXES.includes(r.axis as string)) || Object.keys(r).some((k) => !["count", "axis", "step"].includes(k)))
        errors.push(`${p}.repeat must be { count (0–${MAX_PARTS} or a value), axis?, step }`);
    }
  });
  return errors;
}
