import { describe, expect, it } from "vitest";
import {
  BUILTIN_LOOKS,
  DTDL_CONTEXT,
  PRESENTATION_CONTEXT,
  interfaceErrors,
  presentationErrors,
  presentationOf,
  resolveContents,
  type DtdlInterface,
} from "../src/dtdl.ts";
import { TWIN_ENTITY_MODEL } from "../src/index.ts";

const entity: DtdlInterface = {
  "@context": DTDL_CONTEXT,
  "@id": TWIN_ENTITY_MODEL,
  "@type": "Interface",
  contents: [{ "@type": "Property", name: "name", schema: "string" }],
};

const pod: DtdlInterface = {
  "@context": [DTDL_CONTEXT, PRESENTATION_CONTEXT],
  "@id": "dtmi:osiris:k8s:Pod;3",
  "@type": "Interface",
  extends: TWIN_ENTITY_MODEL,
  contents: [{ "@type": "Property", name: "phase", schema: "string" }],
  presentation: { look: "pod", label: "name", layer: "base", color: "#00c8ff" },
};

const models = () => new Map<string, DtdlInterface>([[entity["@id"], entity], [pod["@id"], pod]]);

describe("DTDL presentation", () => {
  it("accepts a presentation with its context, and resolves it over extends", () => {
    expect(interfaceErrors(pod)).toEqual([]);
    expect(presentationOf(pod["@id"], models())).toEqual({ look: "pod", label: "name", layer: "base", color: "#00c8ff" });
    // Without a presentation of its own, the model gets the parent's (merged), else none.
    const plain: DtdlInterface = { ...pod, "@id": "dtmi:osiris:k8s:Job;1", presentation: undefined };
    expect(presentationOf(plain["@id"], new Map([...models(), [plain["@id"], plain]]))).toEqual({});
    expect(presentationErrors(pod["@id"], models())).toEqual([]);
  });

  it("refuses a presentation without its context, with a bad look, color, layer or label", () => {
    expect(interfaceErrors({ ...pod, "@context": DTDL_CONTEXT }).join()).toContain(PRESENTATION_CONTEXT);
    expect(interfaceErrors({ ...pod, presentation: { look: "star" } }).join()).toContain("look");
    expect(interfaceErrors({ ...pod, presentation: { color: "red" } }).join()).toContain("color");
    expect(interfaceErrors({ ...pod, presentation: { layer: "side" } }).join()).toContain("layer");
    expect(presentationErrors(pod["@id"], models()).length).toBe(0);
    const badLabel: DtdlInterface = { ...pod, presentation: { label: "nope" } };
    const withBad = new Map<string, DtdlInterface>([[entity["@id"], entity], [badLabel["@id"], badLabel]]);
    expect(presentationErrors(badLabel["@id"], withBad).join()).toContain("nope");
  });

  it("keeps the built-in looks for models without a presentation", () => {
    expect(BUILTIN_LOOKS["dtmi:osiris:k8s:Pod"]).toBe("pod");
    expect(BUILTIN_LOOKS["dtmi:osiris:net:Interface"]).toBe("port");
    expect(presentationOf("dtmi:unknown;1", models())).toEqual({});
    expect(resolveContents(pod["@id"], models()).map((c) => c.name).sort()).toEqual(["name", "phase"]);
  });
});

describe("a model's own drawing (presentation.visual)", () => {
  const model = (visual: unknown) => ({ "@context": [DTDL_CONTEXT, PRESENTATION_CONTEXT], "@id": "dtmi:x:Rack;1", "@type": "Interface", presentation: { visual } }) as never;
  it("takes parts with values to follow", () => {
    const visual = {
      mode: "replace",
      parts: [
        { shape: "box", at: [0, -0.4, 0], size: [1, 0.2, 1], color: "neutral", outline: true },
        { shape: "box", size: [0.2, 0.8, 0.8], color: "level", fill: { value: "used/size", axis: "y" } },
        { shape: "cylinder", size: [0.05, 0.6, 0.05], at: [-0.4, 0.8, -0.4], repeat: { count: 4, axis: "x", step: 0.25 } },
        { shape: "plane", size: [0.05, 0.05, 1], color: "#22cc66", blink: "network", when: "status=ok" },
        { shape: "sphere", spin: 0.5, repeat: { count: "readyEndpoints", step: 0.1 } },
        { shape: "gltf", asset: "elitedesk-800-g5.glb", size: [1, 1, 1] },
      ],
    };
    expect(interfaceErrors(model(visual))).toEqual([]);
  });
  it("refuses what isn't a drawing: unknown keys, code, bad numbers, too many parts", () => {
    const errors = (visual: unknown) => interfaceErrors(model(visual)).join("\n");
    expect(errors({ parts: [{ shape: "mesh" }] })).toMatch(/shape is not one of/);
    expect(errors({ parts: [{ shape: "box", onFrame: "alert(1)" }] })).toMatch(/unknown key onFrame/);
    expect(errors({ parts: [{ shape: "box", blink: "a; b" }] })).toMatch(/blink must be/);
    expect(errors({ parts: [{ shape: "box", size: [1, 0, 1] }] })).toMatch(/size must be/);
    expect(errors({ parts: [{ shape: "box", color: "red" }] })).toMatch(/color must be/);
    expect(errors({ parts: [{ shape: "box", repeat: { count: 1000, step: 1 } }] })).toMatch(/repeat must be/);
    expect(errors({ parts: Array.from({ length: 65 }, () => ({ shape: "box" })) })).toMatch(/more than 64/);
    expect(errors({ mode: "eval", parts: [] })).toMatch(/mode must be/);
    expect(errors({ parts: [{ shape: "gltf", asset: "https://evil.example/x.glb" }] })).toMatch(/asset must name/);
    expect(errors({ parts: [{ shape: "box", asset: "a" }] })).toMatch(/gltf part only/);
  });
});
