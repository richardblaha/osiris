import { describe, expect, it, vi } from "vitest";

// The extension's host code needs `vscode`; its pure parts are tested with a stand-in.
vi.mock("vscode", () => ({}));

describe("the VS Code extension", () => {
  it("runs the agent from the setting: a command on PATH, or a bin/osiris.mjs with Node", async () => {
    const { agentCommand } = await import("../src/extension.ts");
    expect(agentCommand("osiris")).toEqual(["osiris"]);
    expect(agentCommand("")).toEqual(["osiris"]);
    expect(agentCommand("/repo/apps/osiris/bin/osiris.mjs")).toEqual(["node", "/repo/apps/osiris/bin/osiris.mjs"]);
  });

  it("speaks Czech for Czech and Slovak, else English", async () => {
    const { texts } = await import("../webview/texts.ts");
    expect(texts("cs").send).toBe("Odeslat");
    expect(texts("sk").send).toBe("Odeslat");
    expect(texts("en-US").send).toBe("Send");
  });
});
