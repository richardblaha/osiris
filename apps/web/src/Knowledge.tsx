import type { DocumentSummary } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { LazyCodeEditor } from "./LazyCodeEditor.tsx";
import { attempt, DetailHeader, ErrorNotice, Field, type DetailProps, Pending } from "./Scope.tsx";

export const documentKey = (d: DocumentSummary) => d.id;

const INTRO = "Poznámky ke klientům, ceníky a postupy, ve kterých asistent vyhledává podle významu i slov.";

/** A document of the knowledge base: kept in the tenant's database and indexed as it's saved. */
export function KnowledgeDetail({ item, scope, onSaved, onDeleted }: DetailProps<DocumentSummary>) {
  const [title, setTitle] = useState(item?.title ?? "");
  const [folder, setFolder] = useState("");
  const [content, setContent] = useState(item ? undefined : "");
  const [saved, setSaved] = useState<{ title: string; content: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!item) return;
    api.document(item.id).then(
      (d) => (setTitle(d.title), setContent(d.content), setSaved({ title: d.title, content: d.content })),
      (e: Error) => setError(e.message),
    );
  }, []);

  if (item) {
    const dirty = !!saved && (title !== saved.title || content !== saved.content);
    const save = () =>
      attempt(setBusy, setError, async () => {
        await api.saveDocument(item.id, title, content ?? "");
        setSaved({ title, content: content ?? "" });
        onSaved(item.id);
      });
    return (
      <div className="detail max-w-4xl">
        <DetailHeader title={item.title} scope={item.scope} canEdit>
          {INTRO}
        </DetailHeader>
        <p className="mt-2 text-xs text-fg-muted">
          <code>{item.id}</code> · {item.chunks} {item.chunks === 1 ? "část" : item.chunks < 5 ? "části" : "částí"} v indexu · změněno{" "}
          {new Date(item.createdAt).toLocaleString("cs-CZ")}
        </p>
        <Field label="Název">
          <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} className="field mt-1" />
        </Field>
        <div className="mt-4">
          {content === undefined ? (
            <Pending error={error} className="relative h-[60vh] rounded-md border border-line" />
          ) : (
            <LazyCodeEditor path={item.id.endsWith(".md") ? item.id : `${item.id}.md`} value={content} onChange={setContent} />
          )}
        </div>
        <div className="mt-4 flex items-center gap-4">
          <button disabled={busy || !dirty || !title.trim() || !content?.trim()} onClick={() => void save()} className="btn-primary">
            {busy ? "Ukládám…" : "Uložit"}
          </button>
          {dirty && <span className="text-xs text-warning">neuloženo</span>}
          <span className="flex-1" />
          <button
            disabled={busy}
            onClick={() => window.confirm(`Smazat dokument ${item.title}?`) && void attempt(setBusy, setError, async () => (await api.deleteDocument(item.id), onDeleted()))}
            className="btn-danger text-sm"
          >
            Smazat dokument
          </button>
        </div>
        <ErrorNotice error={error} />
      </div>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!content?.trim()) return setError("Napiš text dokumentu.");
    void attempt(setBusy, setError, async () => onSaved(documentKey(await api.addDocument(title, content, folder.trim() || undefined))));
  };

  return (
    <div className="detail max-w-4xl">
      <DetailHeader title="Nový dokument" scope={scope} canEdit>
        {INTRO}
      </DetailHeader>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
          <Field label="Název">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="např. Ceník 2026" required className="field" />
          </Field>
          <Field label="Složka (nepovinná, např. public)">
            <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="public" className="field" />
          </Field>
        </div>
        <div className="space-y-1">
          <span className="section-header block">Text (Markdown)</span>
          <LazyCodeEditor path="novy.md" value={content ?? ""} onChange={setContent} height="50vh" />
        </div>
        <button disabled={busy} className="btn-primary">
          {busy ? "Ukládám…" : "Přidat"}
        </button>
      </form>
      <ErrorNotice error={error} />
    </div>
  );
}
