import { describe, expect, it } from "vitest";
import {
  closePanel,
  defaultLayout,
  detach,
  mergeInto,
  normalizeLayout,
  PANELS,
  placeGroup,
  showPanel,
  snapAt,
  snapGroup,
  snapRect,
  visibleGroups,
  type WindowLayout,
} from "../web/src/windowLayout.ts";

/** Every panel in exactly one group, every rectangle inside the area. */
const sound = (l: WindowLayout) => {
  const tabs = l.groups.flatMap((g) => g.tabs);
  expect([...tabs].sort()).toEqual([...PANELS].sort().filter((p) => tabs.includes(p)));
  expect(new Set(tabs).size).toBe(tabs.length);
  for (const g of l.groups) {
    expect(g.tabs).toContain(g.active);
    expect(g.rect.x).toBeGreaterThanOrEqual(0);
    expect(g.rect.y).toBeGreaterThanOrEqual(0);
    expect(g.rect.x + g.rect.w).toBeLessThanOrEqual(1 + 1e-9);
    expect(g.rect.y + g.rect.h).toBeLessThanOrEqual(1 + 1e-9);
  }
};

describe("the windows' layout", () => {
  it("starts with each panel in a window of its own, the selection's around the edges", () => {
    const l = defaultLayout();
    sound(l);
    expect(l.groups.map((g) => g.tabs)).toEqual(PANELS.map((p) => [p]));
  });

  it("joins windows into tabs, and takes a tab out into a window of its own", () => {
    let l = mergeInto(defaultLayout(), "logs", "traces");
    sound(l);
    expect(l.groups.find((g) => g.id === "logs")).toMatchObject({ tabs: ["logs", "traces"], active: "traces" });
    expect(l.groups.some((g) => g.id === "traces")).toBe(false);
    // One tab of a window joins another: the rest stay.
    l = mergeInto(l, "properties", "logs", "logs");
    expect(l.groups.find((g) => g.id === "properties")?.tabs).toEqual(["properties", "logs"]);
    expect(l.groups.find((g) => g.id === "logs")).toMatchObject({ tabs: ["traces"], active: "traces" });
    const out = detach(l, "logs", { x: 0.3, y: 0.3, w: 0.3, h: 0.3 });
    sound(out.layout);
    expect(out.layout.groups.find((g) => g.id === out.id)).toMatchObject({ tabs: ["logs"], rect: { x: 0.3, y: 0.3, w: 0.3, h: 0.3 } });
    expect(out.layout.groups.find((g) => g.id === "properties")?.tabs).toEqual(["properties"]);
    // The new window is in front.
    expect(out.layout.groups.find((g) => g.id === out.id)!.z).toBe(Math.max(...out.layout.groups.map((g) => g.z)));
  });

  it("snaps to halves, quarters and the whole area by where the pointer is let go", () => {
    expect(snapAt(500, 5, 1000, 600)).toBe("max");
    expect(snapAt(5, 300, 1000, 600)).toBe("left");
    expect(snapAt(995, 300, 1000, 600)).toBe("right");
    expect(snapAt(500, 595, 1000, 600)).toBe("bottom");
    expect(snapAt(5, 5, 1000, 600)).toBe("tl");
    expect(snapAt(60, 5, 1000, 600)).toBe("tl");
    expect(snapAt(995, 595, 1000, 600)).toBe("br");
    expect(snapAt(500, 300, 1000, 600)).toBeUndefined();
    let l = snapGroup(defaultLayout(), "chat", "right");
    expect(l.groups.find((g) => g.id === "chat")?.rect).toEqual(snapRect("right"));
    // Maximized keeps where it goes back to.
    l = snapGroup(l, "chat", "max");
    expect(l.groups.find((g) => g.id === "chat")).toMatchObject({ maximized: true, rect: snapRect("right") });
    // Moving it lets go of the maximized state, and stays inside the area.
    l = placeGroup(l, "chat", { x: 0.9, y: -0.2, w: 0.4, h: 0.4 });
    expect(l.groups.find((g) => g.id === "chat")).toMatchObject({ maximized: false, rect: { x: 0.6, y: 0, w: 0.4, h: 0.4 } });
  });

  it("closes a panel until it is shown again, at its default place", () => {
    let l = closePanel(defaultLayout(), "metrics");
    expect(l.hidden).toEqual(["metrics"]);
    expect(visibleGroups(l, new Set(PANELS)).some((g) => g.tabs.includes("metrics"))).toBe(false);
    l = showPanel(l, "metrics");
    expect(l.hidden).toEqual([]);
    expect(l.groups.find((g) => g.tabs.includes("metrics"))?.rect).toEqual(defaultLayout().groups.find((g) => g.id === "metrics")!.rect);
  });

  it("shows only the panels there are now, a window's active tab among them", () => {
    const l = mergeInto(defaultLayout(), "chat", "logs");
    // Nothing selected: the conversation alone, though its window holds the logs too.
    const shown = visibleGroups(l, new Set(["chat"]));
    expect(shown).toEqual([expect.objectContaining({ id: "chat", tabs: ["chat"], active: "chat" })]);
  });

  it("makes a stored layout safe: unknown panels, duplicates and broken windows dropped, missing panels back", () => {
    const l = normalizeLayout({
      version: 1,
      groups: [
        { id: "a", tabs: ["logs", "nope", "logs", "chat"], active: "nope", rect: { x: 2, y: 0, w: 0.5, h: 0.5 }, z: 7 },
        { id: "b", tabs: ["chat"], active: "chat", rect: { x: 0, y: 0, w: 1, h: 1 }, z: 3 },
        { id: "c", tabs: ["metrics"], rect: "x" },
      ],
      hidden: ["traces", "bogus"],
    });
    sound(l);
    expect(l.groups[0]).toMatchObject({ id: "a", tabs: ["logs", "chat"], active: "logs", rect: { x: 0.5, y: 0, w: 0.5, h: 0.5 } });
    expect(l.groups.some((g) => g.id === "b")).toBe(false);
    for (const p of PANELS) expect(l.groups.some((g) => g.tabs.includes(p)), p).toBe(true);
    expect(l.hidden).toEqual(["traces"]);
    expect(normalizeLayout("garbage")).toEqual(defaultLayout());
  });
});
