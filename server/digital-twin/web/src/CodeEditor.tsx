import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import { useEffect, useState } from "react";
import { LOOKS, PRESENTATION_LAYERS } from "@osiris/shared/dtdl.ts";

// Monaco from this app's own build (no CDN, which the CSP would refuse), with the JSON worker for DTDL.
self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    return label === "json" ? new JsonWorker() : new EditorWorker();
  },
};
loader.config({ monaco });

/** The model the DTDL documents open as: the JSON schema below checks them while typing. */
export const DTDL_PATH = "model.dtdl.json";

/** The part of DTDL v3 the twin takes, with the presentation section, as a JSON schema (a hint while typing; the
 * server validates for real). */
const DTDL_SCHEMA = {
  type: "object",
  required: ["@context", "@id", "@type"],
  properties: {
    "@context": { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
    "@id": { type: "string", pattern: "^dtmi:[A-Za-z][A-Za-z0-9_:]*(;[1-9][0-9]*)?$" },
    "@type": { const: "Interface" },
    displayName: { anyOf: [{ type: "string" }, { type: "object", additionalProperties: { type: "string" } }] },
    description: { anyOf: [{ type: "string" }, { type: "object", additionalProperties: { type: "string" } }] },
    extends: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
    contents: {
      type: "array",
      items: {
        type: "object",
        required: ["@type", "name"],
        properties: {
          "@type": { enum: ["Property", "Telemetry", "Relationship", "Command"] },
          name: { type: "string", pattern: "^[A-Za-z](?:[A-Za-z0-9_]*[A-Za-z0-9])?$" },
          schema: {},
          target: { type: "string" },
          writable: { type: "boolean" },
        },
      },
    },
    presentation: {
      type: "object",
      additionalProperties: false,
      properties: {
        look: { enum: [...LOOKS] },
        color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
        icon: { type: "string", maxLength: 60 },
        label: { type: "string" },
        layer: { enum: [...PRESENTATION_LAYERS] },
        visible: { type: "boolean" },
      },
    },
  },
};
monaco.json.jsonDefaults.setDiagnosticsOptions({ validate: true, allowComments: false, schemas: [{ uri: "https://twin.k6labs.cz/schemas/dtdl.json", fileMatch: [DTDL_PATH], schema: DTDL_SCHEMA }] });

/** A CSS colour as Monaco wants it: #rrggbb (or #rrggbbaa), from the page's variable. */
function cssColor(name: string, alpha?: number): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  document.body.append(probe);
  const rgb = getComputedStyle(probe).color.match(/[\d.]+/g)?.map(Number) ?? [128, 128, 128];
  probe.remove();
  const hex = (n: number) => Math.round(n).toString(16).padStart(2, "0");
  const a = alpha ?? (rgb[3] !== undefined ? rgb[3] : 1);
  return `#${hex(rgb[0]!)}${hex(rgb[1]!)}${hex(rgb[2]!)}${a < 1 ? hex(a * 255) : ""}`;
}
const bare = (hex: string) => hex.slice(1, 7);

/**
 * The twin's own Monaco theme, from its OSIRIS theme's variables (light or dark as the page is): its backgrounds and
 * borders, keys in cyan, strings in the text colour, numbers and keywords in magenta, the cursor and matches in the
 * bright cyan of the selection.
 */
function defineTheme(): string {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const name = dark ? "osiris-twin-dark" : "osiris-twin-light";
  const c = {
    bg: cssColor("--bg-editor"),
    widget: cssColor("--bg-sidebar"),
    hover: cssColor("--bg-hover"),
    selection: cssColor("--bg-selection"),
    border: cssColor("--border-strong"),
    subtle: cssColor("--border-subtle"),
    fg: cssColor("--text-primary"),
    secondary: cssColor("--text-secondary"),
    muted: cssColor("--text-muted"),
    accent: cssColor("--accent-primary"),
    active: cssColor("--accent-active"),
    magenta: cssColor("--accent-secondary"),
    warning: cssColor("--state-warning"),
    scrollbar: cssColor("--scrollbar"),
  };
  const soft = (hex: string, a: string) => `${hex.slice(0, 7)}${a}`;
  monaco.editor.defineTheme(name, {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [
      { token: "", foreground: bare(c.fg) },
      { token: "string.key.json", foreground: bare(c.accent) },
      { token: "string.value.json", foreground: bare(c.fg) },
      { token: "number", foreground: bare(c.magenta) },
      { token: "keyword", foreground: bare(c.magenta) },
      { token: "keyword.json", foreground: bare(c.magenta) },
      { token: "delimiter", foreground: bare(c.secondary) },
      { token: "comment", foreground: bare(c.muted), fontStyle: "italic" },
    ],
    colors: {
      "editor.background": c.bg,
      "editor.foreground": c.fg,
      "editorGutter.background": c.bg,
      "editorLineNumber.foreground": c.muted,
      "editorLineNumber.activeForeground": c.accent,
      "editorCursor.foreground": c.active,
      "editor.selectionBackground": c.selection,
      "editor.inactiveSelectionBackground": c.hover,
      "editor.lineHighlightBackground": c.widget,
      "editor.lineHighlightBorder": "#00000000",
      "editor.findMatchBackground": soft(c.active, "40"),
      "editor.findMatchHighlightBackground": soft(c.active, "24"),
      "editorBracketMatch.background": soft(c.accent, "24"),
      "editorBracketMatch.border": c.accent,
      "editorIndentGuide.background1": c.subtle,
      "editorIndentGuide.activeBackground1": c.border,
      "editorWhitespace.foreground": c.subtle,
      "editorError.foreground": c.magenta,
      "editorWarning.foreground": c.warning,
      "editorWidget.background": c.widget,
      "editorWidget.border": c.border,
      "editorSuggestWidget.background": c.widget,
      "editorSuggestWidget.border": c.border,
      "editorSuggestWidget.selectedBackground": c.hover,
      "editorSuggestWidget.highlightForeground": c.accent,
      "editorHoverWidget.background": c.widget,
      "editorHoverWidget.border": c.border,
      "input.background": c.bg,
      "input.border": c.border,
      focusBorder: c.accent,
      "list.hoverBackground": c.hover,
      "list.activeSelectionBackground": c.selection,
      "scrollbar.shadow": "#00000000",
      "scrollbarSlider.background": soft(c.scrollbar, "99"),
      "scrollbarSlider.hoverBackground": c.scrollbar,
      "scrollbarSlider.activeBackground": c.accent,
      "editorOverviewRuler.border": "#00000000",
    },
  });
  return name;
}

/** Monaco over a DTDL document (JSON, checked against the schema above); loaded on demand, as it's large. */
export default function CodeEditor({ value, onChange, height = "60vh" }: { value: string; onChange?: (value: string) => void; height?: string }) {
  const [theme, setTheme] = useState(defineTheme);
  useEffect(() => {
    const query = matchMedia("(prefers-color-scheme: dark)");
    const follow = () => setTheme(defineTheme());
    query.addEventListener("change", follow);
    // Monaco measures the font once: load Fira Code and measure again, or the cursor drifts.
    void document.fonts?.load('13px "Fira Code"').then(() => monaco.editor.remeasureFonts(), () => {});
    return () => query.removeEventListener("change", follow);
  }, []);
  return (
    <div className="overflow-hidden rounded-md border border-line" style={{ height }}>
      <Editor
        height="100%"
        language="json"
        path={DTDL_PATH}
        value={value}
        theme={theme}
        onChange={(v) => onChange?.(v ?? "")}
        options={{
          minimap: { enabled: false },
          fontFamily: '"Fira Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontLigatures: true,
          fontSize: 13,
          lineHeight: 20,
          padding: { top: 8 },
          tabSize: 2,
          renderLineHighlight: "all",
          cursorBlinking: "smooth",
          scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
          overviewRulerBorder: false,
          scrollBeyondLastLine: false,
          automaticLayout: true,
          formatOnPaste: true,
          unicodeHighlight: { ambiguousCharacters: false },
        }}
      />
    </div>
  );
}
