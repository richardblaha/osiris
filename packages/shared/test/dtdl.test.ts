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
