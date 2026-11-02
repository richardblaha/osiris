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
  /** A built-in drawing (`VISUAL_PRESETS`) drawn first, under the model's own parts. */
  preset?: string;
  parts?: VisualPart[];
}

export type VisualShape = "box" | "cylinder" | "sphere" | "plane" | "gltf";
export const VISUAL_SHAPES: readonly VisualShape[] = ["box", "cylinder", "sphere", "plane", "gltf"];
/** A 3D asset's name (the instance's assets: binary glTF uploaded by admins). */
export const VISUAL_ASSET = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export type VisualAxis = "x" | "y" | "z";
export const VISUAL_AXES: readonly VisualAxis[] = ["x", "y", "z"];

/**
 * A value of the twin a part follows, by name: one of the view's readings — `fill` (how full storage is), `network`
 * (bytes/s), `load`, `io`, `cpu`, `memory`, `used`, `size` — else a property of the twin. `a/b` is one over the other
 * (`used/size`); in `when`, `name=value` compares (`status=error`).
 */
export type VisualValue = string;

/** The theme's colours a part may wear by name; else `#rrggbb`. `level` is its value's band (well, warning, error),
 * `body` the colour (and, without `opacity`, the opacity) the view gives the solid's body as it stands. */
export const VISUAL_COLORS = ["status", "accent", "active", "neutral", "warn", "error", "level", "body"] as const;
export type VisualColor = (typeof VISUAL_COLORS)[number] | `#${string}`;

export interface VisualPart {
  shape: VisualShape;
  /** A `gltf` part's asset, by name: fitted into the part's size keeping its proportions, in its own materials
   * (tinted with `color` when given). */
  asset?: string;
  /** How a `gltf` part's asset fills its size: keeping its proportions (`contain`, the default) or stretched to it. */
  fit?: "contain" | "stretch";
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
  /** Shown only while the value is there and not 0, false or empty (or equals, with `name=value`); `!` turns it round. */
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
const CONDITION = /^!?[A-Za-z][A-Za-z0-9_]{0,63}(\/[A-Za-z][A-Za-z0-9_]{0,63})?(=[^\s=]{1,64})?$/;
const AXES = ["x", "y", "z"];
const PART_KEYS = new Set(["asset", "fit", "shape", "at", "size", "rotate", "color", "opacity", "outline", "when", "fill", "blink", "spin", "repeat"]);

const vec = (v: unknown, min: number, max: number) => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x) && x >= min && x <= max);

/** What's wrong with a `presentation.visual` (empty: nothing). */
export function visualErrors(id: string, v: unknown): string[] {
  const at = `${id}: presentation.visual`;
  if (!v || typeof v !== "object" || Array.isArray(v)) return [`${at} must be an object`];
  const o = v as Record<string, unknown>;
  const errors: string[] = [];
  for (const k of Object.keys(o)) if (k !== "mode" && k !== "parts" && k !== "preset") errors.push(`${at} has an unknown key ${k}`);
  if (o.mode !== undefined && o.mode !== "add" && o.mode !== "replace") errors.push(`${at}.mode must be add or replace`);
  if (o.preset !== undefined && !(typeof o.preset === "string" && o.preset in VISUAL_PRESETS)) errors.push(`${at}.preset is not one of ${Object.keys(VISUAL_PRESETS).join(", ")}`);
  if (o.parts === undefined && o.preset !== undefined) return errors;
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
    if (x.fit !== undefined && (x.shape !== "gltf" || (x.fit !== "contain" && x.fit !== "stretch"))) errors.push(`${p}.fit must be contain or stretch, on a gltf part`);
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

/** A drawing's parts: its preset's, then its own. */
export const visualParts = (v: DtdlVisual): VisualPart[] => [...(v.preset ? (VISUAL_PRESETS[v.preset]?.parts ?? []) : []), ...(v.parts ?? [])];

/** A part's level growing with its load, paler while only estimated (a core without its own metric). */
const level = (axis: VisualAxis): VisualPart[] => [
  { shape: "box", size: [0.84, 0.84, 0.84], color: "level", opacity: 0.45, fill: { value: "load", axis }, when: "!estimated" },
  { shape: "box", size: [0.84, 0.84, 0.84], color: "level", opacity: 0.25, fill: { value: "load", axis }, when: "estimated" },
];
/** A row of a vent grille's slits across a front, at height `y`. */
const slits = (y: number): VisualPart => ({ shape: "plane", at: [-0.46, y, 0.503], size: [0.012, 0.012, 1], color: "neutral", opacity: 0.35, repeat: { count: 28, axis: "x", step: 0.024 } });

/**
 * The built-in drawings, each also how the view draws the look of that name: a model takes one with `preset` (and
 * adds its own parts), or copies its parts to change them. They are drawn over the look's body and outline.
 */
export const VISUAL_PRESETS: Record<string, DtdlVisual> = {
  /** A part's load: its level from the floor up (a core). */
  "level-y": { parts: level("y") },
  /** A part's load along its length (memory, a disk). */
  "level-x": { parts: level("x") },
  /** A disk: its level, and its activity light on its front, blinking with its I/O. */
  drive: { parts: [...level("x"), { shape: "box", at: [0.44, 0, 0.51], size: [0.06, 0.4, 0.02], color: "active", opacity: 0.95, blink: "io" }] },
  /** A mini PC (the built-in asset `mini-pc.glb`, stretched to the machine's solid, see-through so what runs on it
   * shows): graphite chassis, a vent grille, the power button and front ports; its power light the machine's status. */
  "mini-pc": {
    parts: [
      { shape: "gltf", asset: "mini-pc.glb", fit: "stretch", opacity: 0.3 },
      { shape: "box", at: [0.42, 0.05, 0.506], size: [0.02, 0.03, 0.004], color: "status", opacity: 0.95 },
    ],
  },
  /** A mini PC's front drawn with shapes only (no asset): a panel, a vent grille, a round power button and its light. */
  "mini-pc-shapes": {
    parts: [
      { shape: "plane", at: [0, 0, 0.501], size: [0.98, 0.96, 1], color: "neutral", opacity: 0.07 },
      ...[-0.3, -0.15, 0, 0.15, 0.3].map(slits),
      { shape: "cylinder", at: [0.46, 0.2, 0.503], rotate: [90, 0, 0], size: [0.014, 0.002, 0.048], color: "status", opacity: 0.9 },
      { shape: "box", at: [0.46, 0.05, 0.503], size: [0.012, 0.012, 0.002], color: "status", opacity: 0.9 },
    ],
  },
  /** A desktop switch (the built-in asset `switch.glb`, stretched to its solid, cyan and see-through) and its light
   * blinking with traffic. */
  switch: {
    parts: [
      { shape: "gltf", asset: "switch.glb", fit: "stretch", color: "neutral", opacity: 0.45 },
      { shape: "plane", at: [-0.4, 0.512, 0.35], rotate: [-90, 0, 0], size: [0.03, 0.08, 1], color: "status", opacity: 0.95, blink: "traffic" },
    ],
  },
  /** A home router (the built-in asset `router.glb`: its body the solid, its four antennas above it) and its lights
   * blinking with traffic; no badge. */
  router: {
    parts: [
      { shape: "gltf", asset: "router.glb", at: [0, 2.11, 0], size: [1, 5.36, 1.01], color: "neutral", opacity: 0.45 },
      { shape: "plane", at: [-0.12, 0.515, 0.43], rotate: [-90, 0, 0], size: [0.022, 0.06, 1], color: "status", opacity: 0.95, blink: "traffic", repeat: { count: 7, axis: "x", step: 0.052 } },
    ],
  },
  /** A 2.5" USB disk lying flat (the built-in asset `usb-disk.glb`, stretched to its solid, cyan and see-through):
   * its fill level along its length, its activity light, and the USB connector at its back (a physical disk only). */
  "usb-disk": {
    parts: [
      { shape: "gltf", asset: "usb-disk.glb", fit: "stretch", color: "neutral", opacity: 0.55 },
      { shape: "box", size: [0.9, 0.9, 0.9], color: "level", opacity: 0.4, fill: { value: "fill", axis: "x" }, when: "fill" },
      { shape: "box", at: [0.38, 0, 0.51], size: [0.05, 0.08, 0.01], color: "active", opacity: 0.95, blink: "io" },
      { shape: "box", at: [0, -0.1, -0.51], size: [0.24, 0.12, 0.03], color: "neutral", opacity: 0.9, when: "bus=usb" },
    ],
  },
  /** A disk standing on its edge in the Ceph array (the asset turned upright by the stretch): its fill level up its
   * face, the activity light, and the USB connector at its back (a physical disk only — a pool has no cable). */
  "usb-disk-up": {
    parts: [
      { shape: "gltf", asset: "usb-disk.glb", fit: "stretch", color: "neutral", opacity: 0.55 },
      { shape: "box", size: [0.9, 0.9, 0.9], color: "level", opacity: 0.4, fill: { value: "fill", axis: "y" }, when: "fill" },
      { shape: "box", at: [0.38, 0, 0.51], size: [0.05, 0.08, 0.01], color: "active", opacity: 0.95, blink: "io" },
      { shape: "box", at: [0, -0.1, -0.51], size: [0.24, 0.12, 0.03], color: "neutral", opacity: 0.9, when: "bus=usb" },
    ],
  },
};
