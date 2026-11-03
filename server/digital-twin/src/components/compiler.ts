import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ALLOWED_MODULES: Record<string, string> = {
  react: "__sdk.React",
  "@react-three/fiber": "__sdk.Fiber",
  three: "__sdk.THREE",
  "@osiris/twin-sdk": "__sdk.SDK",
};

const FORBIDDEN_GLOBALS = new Set(["eval", "Function", "fetch", "XMLHttpRequest", "WebSocket", "localStorage", "sessionStorage", "indexedDB"]);

/** Content-addressed compiled ES modules (`<sha256> -> js`), served at `/api/components/modules/:sha256.js`. */
const COMPILED_MODULES = new Map<string, string>();

export function getCompiledModule(sha256: string): string | undefined {
  return COMPILED_MODULES.get(sha256);
}

export function registerCompiledModule(sha256: string, js: string): void {
  COMPILED_MODULES.set(sha256, js);
}

export interface CompileResult {
  sha256: string;
  js: string;
  errors: string[];
}

/**
 * Validates and compiles a user-editable React Three Fiber `.tsx` component into a browser ES module that resolves
 * `react`, `@react-three/fiber`, `three` and `@osiris/twin-sdk` from `globalThis.__OSIRIS_TWIN_SDK__`.
 */
export function compileComponent(code: string): CompileResult {
  if (typeof code !== "string" || !code.trim()) return { sha256: "", js: "", errors: ["Component code is empty"] };
  if (code.length > 64_000) return { sha256: "", js: "", errors: ["Component code exceeds 64 kB"] };

  const sf = ts.createSourceFile("component.tsx", code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const errors: string[] = [];

  const diags = (sf as unknown as { parseDiagnostics?: ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
  for (const d of diags) {
    const pos = sf.getLineAndCharacterOfPosition(d.start);
    errors.push(`Line ${pos.line + 1}:${pos.character + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
  }
  if (errors.length) return { sha256: "", js: "", errors };

  let hasDefaultExport = false;
  const replacements: { start: number; end: number; text: string }[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      if (node.importClause?.isTypeOnly) {
        replacements.push({ start: node.getStart(sf), end: node.getEnd(), text: "" });
        return;
      }
      const spec = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : "";
      const target = ALLOWED_MODULES[spec];
      if (!target) {
        const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        errors.push(`Line ${pos.line + 1}: import from "${spec}" is not allowed (allowed: ${Object.keys(ALLOWED_MODULES).join(", ")})`);
        return;
      }
      const clause = node.importClause;
      const lines: string[] = [];
      if (clause?.name) {
        lines.push(`const ${clause.name.text} = ${target};`);
      }
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          lines.push(`const ${clause.namedBindings.name.text} = ${target};`);
        } else if (ts.isNamedImports(clause.namedBindings)) {
          const bindings = clause.namedBindings.elements
            .filter((el) => !el.isTypeOnly)
            .map((el) => (el.propertyName ? `${el.propertyName.text}: ${el.name.text}` : el.name.text));
          if (bindings.length) lines.push(`const { ${bindings.join(", ")} } = ${target};`);
        }
      }
      replacements.push({ start: node.getStart(sf), end: node.getEnd(), text: lines.join(" ") });
      return;
    }
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      hasDefaultExport = true;
    }
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      hasDefaultExport = true;
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      if (node.exportClause.elements.some((e) => e.name.text === "default")) hasDefaultExport = true;
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      errors.push(`Line ${pos.line + 1}: dynamic import() is not allowed`);
    }
    if (ts.isIdentifier(node) && FORBIDDEN_GLOBALS.has(node.text)) {
      const parent = node.parent;
      const isPropName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isPropertySignature(parent) && parent.name === node);
      if (!isPropName) {
        const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        errors.push(`Line ${pos.line + 1}: "${node.text}" is not allowed in a 3D component`);
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sf, visit);

  if (!hasDefaultExport) {
    errors.push("Component must have an `export default` function or component");
  }
  if (errors.length) return { sha256: "", js: "", errors };

  let rewritten = code;
  for (const r of replacements.sort((a, b) => b.start - a.start)) {
    rewritten = rewritten.slice(0, r.start) + r.text + rewritten.slice(r.end);
  }

  const transpiled = ts.transpileModule(rewritten, {
    fileName: "component.tsx",
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.React,
      jsxFactory: "__sdk.React.createElement",
      jsxFragmentFactory: "__sdk.React.Fragment",
      removeComments: false,
    },
    reportDiagnostics: true,
  });

  for (const d of transpiled.diagnostics ?? []) {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    errors.push(msg);
  }
  if (errors.length) return { sha256: "", js: "", errors };

  const js = `const __sdk = globalThis.__OSIRIS_TWIN_SDK__;\n${transpiled.outputText}`;
  const sha256 = createHash("sha256").update(js).digest("hex");
  COMPILED_MODULES.set(sha256, js);
  return { sha256, js, errors: [] };
}

export interface BuiltinComponent {
  name: string;
  code: string;
  sha256: string;
}

const COMPONENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../components");
let cachedBuiltins: Map<string, BuiltinComponent> | undefined;

/** Loads and compiles the default user-editable `.tsx` R3F components from `server/digital-twin/components/`. */
export function builtinComponents(): Map<string, BuiltinComponent> {
  if (cachedBuiltins) return cachedBuiltins;
  const out = new Map<string, BuiltinComponent>();
  if (existsSync(COMPONENTS_DIR)) {
    for (const file of readdirSync(COMPONENTS_DIR).sort()) {
      if (!file.endsWith(".tsx")) continue;
      const name = file.slice(0, -4);
      const code = readFileSync(join(COMPONENTS_DIR, file), "utf8");
      const compiled = compileComponent(code);
      if (!compiled.errors.length) {
        out.set(name, { name, code, sha256: compiled.sha256 });
      }
    }
  }
  cachedBuiltins = out;
  return out;
}

