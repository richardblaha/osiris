import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";
import { useEffect, useState } from "react";

// Monaco from this app's own build (no CDN, which the CSP would refuse), with its language workers.
self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};
loader.config({ monaco });

const LANGUAGES: Record<string, string> = {
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
  css: "css",
  js: "javascript",
  json: "json",
  csv: "plaintext",
  sql: "sql",
  txt: "plaintext",
  xml: "xml",
  svg: "xml",
  yaml: "yaml",
  yml: "yaml",
};

export const languageOf = (path: string) => LANGUAGES[path.split(".").at(-1)?.toLowerCase() ?? ""] ?? "plaintext";

const dark = () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;

/** OSIRIS themes for Monaco, from richardblaha/osiris-theme (assets/tokens.json, the VS Code themes' values). */
const PALETTES = {
  "osiris-dark": {
    base: "vs-dark",
    bg: "#0d1117", widget: "#161b22", hover: "#21262d", selection: "#21262d", border: "#30363d", subtle: "#21262d",
    fg: "#e6edf3", secondary: "#8b949e", muted: "#565f6d", accent: "#00f2fe", accentSoft: "#00f2fe24", scrollbar: "#30363d",
    syntax: { comment: "565f6d", string: "a5d6ff", keyword: "ff2a85", function: "00f2fe", type: "79c0ff", number: "d29922", punctuation: "8b949e", variable: "e6edf3", property: "ffa198" },
  },
  "osiris-light": {
    base: "vs",
    bg: "#ffffff", widget: "#f6f8fa", hover: "#eaeef2", selection: "#dde7f3", border: "#d0d7de", subtle: "#eaeef2",
    fg: "#1f2328", secondary: "#57606a", muted: "#8c959f", accent: "#0969da", accentSoft: "#0969da1a", scrollbar: "#d0d7de",
    syntax: { comment: "8c959f", string: "0a3069", keyword: "e01a76", function: "0969da", type: "953800", number: "0550ae", punctuation: "57606a", variable: "1f2328", property: "cf222e" },
  },
} as const;

let defined = false;
function defineThemes(m: typeof monaco) {
  if (defined) return;
  defined = true;
  for (const [name, p] of Object.entries(PALETTES)) {
    const s = p.syntax;
    m.editor.defineTheme(name, {
      base: p.base,
      inherit: true,
      rules: [
        { token: "", foreground: s.variable },
        { token: "comment", foreground: s.comment, fontStyle: "italic" },
        { token: "string", foreground: s.string },
        { token: "attribute.value", foreground: s.string },
        { token: "keyword", foreground: s.keyword },
        { token: "tag", foreground: s.keyword },
        { token: "metatag", foreground: s.keyword },
        { token: "number", foreground: s.number },
        { token: "type", foreground: s.type },
        { token: "attribute.name", foreground: s.property },
        { token: "string.key.json", foreground: s.property },
        { token: "key", foreground: s.property },
        { token: "delimiter", foreground: s.punctuation },
        { token: "identifier", foreground: s.variable },
        { token: "predefined", foreground: s.function },
        { token: "variable", foreground: s.variable },
        // Markdown: headings, emphasis, links, code.
        { token: "keyword.md", foreground: s.keyword, fontStyle: "bold" },
        { token: "strong", fontStyle: "bold" },
        { token: "emphasis", fontStyle: "italic" },
        { token: "string.link", foreground: s.function, fontStyle: "underline" },
        { token: "variable.source", foreground: s.string },
      ],
      colors: {
        "editor.background": p.bg,
        "editor.foreground": p.fg,
        "editorGutter.background": p.bg,
        "editorLineNumber.foreground": p.muted,
        "editorLineNumber.activeForeground": p.secondary,
        "editorCursor.foreground": p.accent,
        "editor.selectionBackground": p.selection,
        "editor.inactiveSelectionBackground": p.hover,
        "editor.lineHighlightBackground": p.widget,
        "editor.lineHighlightBorder": "#00000000",
        "editor.findMatchBackground": p.accentSoft,
        "editor.findMatchHighlightBackground": p.accentSoft,
        "editorBracketMatch.background": p.accentSoft,
        "editorBracketMatch.border": p.accent,
        "editorIndentGuide.background1": p.subtle,
        "editorIndentGuide.activeBackground1": p.border,
        "editorWhitespace.foreground": p.subtle,
        "editorWidget.background": p.widget,
        "editorWidget.border": p.border,
        "editorSuggestWidget.background": p.widget,
        "editorSuggestWidget.border": p.border,
        "editorSuggestWidget.selectedBackground": p.hover,
        "editorHoverWidget.background": p.widget,
        "editorHoverWidget.border": p.border,
        "input.background": p.bg,
        "input.border": p.border,
        "focusBorder": p.accent,
        "list.hoverBackground": p.hover,
        "scrollbar.shadow": "#00000000",
        "scrollbarSlider.background": `${p.scrollbar}99`,
        "scrollbarSlider.hoverBackground": p.scrollbar,
        "scrollbarSlider.activeBackground": p.accent,
        "editorOverviewRuler.border": "#00000000",
      },
    });
  }
}

const themeName = (isDark: boolean) => (isDark ? "osiris-dark" : "osiris-light");

/** Monaco for a text file's content; loaded on demand (see LazyCodeEditor), as it's large. */
export default function CodeEditor({
  value,
  onChange,
  path,
  readOnly = false,
  height = "60vh",
}: {
  value: string;
  onChange?: (value: string) => void;
  /** Picks the language by its extension. */
  path: string;
  readOnly?: boolean;
  /** The editor's height; `100%` fills a parent with a height of its own. */
  height?: string;
}) {
  const [theme, setTheme] = useState(() => themeName(dark()));
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    const follow = () => setTheme(themeName(query.matches));
    query?.addEventListener("change", follow);
    // Monaco measures the font once: load Fira Code (a font is only fetched once something uses it) and measure again,
    // or the cursor and the ligatures drift.
    void document.fonts?.load('13px "Fira Code"').then(() => monaco.editor.remeasureFonts(), () => {});
    return () => query?.removeEventListener("change", follow);
  }, []);
  // The frame has the height, Monaco fills it (a percentage of a frame without one was 0).
  return (
    <div className="overflow-hidden rounded-md border border-line" style={{ height }}>
      <Editor
        height="100%"
        language={languageOf(path)}
        value={value}
        theme={theme}
        beforeMount={defineThemes}
        onChange={(v) => onChange?.(v ?? "")}
        options={{
          readOnly,
          minimap: { enabled: false },
          wordWrap: "on",
          fontFamily: '"Fira Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontLigatures: true,
          fontSize: 13,
          lineHeight: 20,
          padding: { top: 8 },
          renderLineHighlight: "all",
          cursorBlinking: "smooth",
          scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
          overviewRulerBorder: false,
          scrollBeyondLastLine: false,
          automaticLayout: true,
          unicodeHighlight: { ambiguousCharacters: false },
        }}
      />
    </div>
  );
}
