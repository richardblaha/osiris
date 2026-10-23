import { lazy, Suspense, type ComponentProps } from "react";
import { t } from "i18next";

const CodeEditor = lazy(() => import("./CodeEditor.tsx"));

/** The Monaco editor, fetched the first time one is shown so the app itself stays small. */
export function LazyCodeEditor(props: ComponentProps<typeof CodeEditor>) {
  return (
    <Suspense fallback={<div className="rounded-md border border-line p-3 text-sm text-fg-muted">{t("loadingEditor")}</div>}>
      <CodeEditor {...props} />
    </Suspense>
  );
}
