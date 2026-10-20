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
  txt: "plaintext",
  xml: "xml",
  svg: "xml",
  yaml: "yaml",
  yml: "yaml",
};

export const languageOf = (path: string) => LANGUAGES[path.split(".").at(-1)?.toLowerCase() ?? ""] ?? "plaintext";

const dark = () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;

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
  height?: string;
}) {
  const [theme, setTheme] = useState(() => (dark() ? "vs-dark" : "vs"));
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    const follow = () => setTheme(query.matches ? "vs-dark" : "vs");
    query?.addEventListener("change", follow);
    return () => query?.removeEventListener("change", follow);
  }, []);
  return (
    <div className="overflow-hidden rounded-md border border-line">
      <Editor
        height={height}
        language={languageOf(path)}
        value={value}
        theme={theme}
        onChange={(v) => onChange?.(v ?? "")}
        options={{
          readOnly,
          minimap: { enabled: false },
          wordWrap: "on",
          fontSize: 13,
          scrollBeyondLastLine: false,
          automaticLayout: true,
          unicodeHighlight: { ambiguousCharacters: false },
        }}
      />
    </div>
  );
}
