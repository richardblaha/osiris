import type { DocumentSummary } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { LazyCodeEditor } from "./LazyCodeEditor.tsx";
import { attempt, DetailHeader, ErrorNotice, Field, type DetailProps } from "./Scope.tsx";

export const documentKey = (d: DocumentSummary) => d.id;

const INTRO = "Poznámky ke klientům, ceníky a postupy, ve kterých asistent vyhledává. Jsou to soubory ve složce knowledge/.";

/** A document of the knowledge base: a file in knowledge/, edited here (or in Soubory) and indexed as it's saved. */
export function KnowledgeDetail({ item, scope, isAdmin, onSaved, onDeleted }: DetailProps<DocumentSummary>) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [saved, setSaved] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const path = item && `knowledge/${item.id}`;

  useEffect(() => {
    if (!item || !path) return;
    api.downloadFile({ scope: item.scope, path }).then(
      (blob) => blob.text().then((text) => (setContent(text), setSaved(text))),
      (e: Error) => setError(e.message),
    );
  }, []);

  if (item && path) {
    const editable = true;
    const save = () =>
      attempt(setBusy, setError, async () => {
        await api.uploadFile({ scope: item.scope, path }, new Blob([content], { type: "text/markdown" }), true);
        setSaved(content);
        onSaved(item.id);
      });
    return (
      <div className="detail max-w-4xl">
        <DetailHeader title={item.title} scope={item.scope} canEdit={editable}>
          {INTRO}
        </DetailHeader>
        <p className="mt-2 text-xs text-fg-muted">
          <code>{path}</code> · {item.chunks} {item.chunks === 1 ? "část" : item.chunks < 5 ? "části" : "částí"} v indexu · změněno{" "}
          {new Date(item.createdAt).toLocaleString("cs-CZ")}
        </p>
        <div className="mt-4">
          {saved === undefined ? (
            <p className="text-sm text-fg-muted">Načítám…</p>
          ) : (
            <LazyCodeEditor path={path} value={content} readOnly={!editable} onChange={setContent} />
          )}
        </div>
        {editable && (
          <div className="mt-4 flex items-center gap-4">
            <button disabled={busy || saved === undefined || content === saved} onClick={() => void save()} className="btn-primary">
              {busy ? "Ukládám…" : "Uložit"}
            </button>
            {saved !== undefined && content !== saved && <span className="text-xs text-warning">neuloženo</span>}
            <button
              disabled={busy}
              onClick={() => attempt(setBusy, setError, async () => (await api.deleteDocument(item.id, item.scope), onDeleted()))}
              className="btn-danger text-sm"
            >
              Smazat dokument
            </button>
          </div>
        )}
        <ErrorNotice error={error} />
      </div>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return setError("Napiš text dokumentu.");
    void attempt(setBusy, setError, async () => onSaved(documentKey(await api.addDocument(title, content, scope))));
  };

  return (
    <div className="detail max-w-4xl">
      <DetailHeader title="Nový dokument" scope={scope} canEdit>
        {INTRO}
      </DetailHeader>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <Field label="Název">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="např. Ceník 2026" required className="field" />
        </Field>
        <div className="space-y-1">
          <span className="section-header block">Text (Markdown)</span>
          <LazyCodeEditor path="novy.md" value={content} onChange={setContent} height="50vh" />
        </div>
        <button disabled={busy} className="btn-primary">
          {busy ? "Ukládám…" : "Přidat"}
        </button>
      </form>
      <ErrorNotice error={error} />
    </div>
  );
}
