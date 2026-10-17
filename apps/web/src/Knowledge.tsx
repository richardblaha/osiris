import type { DocumentSummary, Scope } from "@osiris/shared";
import { useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { attempt, canEdit, DetailHeader, ErrorNotice, Field, ScopePicker, type DetailProps } from "./Scope.tsx";

export const documentKey = (d: DocumentSummary) => d.id;

const INTRO = "Poznámky ke klientům, ceníky a postupy, ve kterých asistent vyhledává.";

export function KnowledgeDetail({ item, isAdmin, onSaved, onDeleted }: DetailProps<DocumentSummary>) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [scope, setScope] = useState<Scope>("personal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (item) {
    // Documents are stored as searchable chunks; they can be removed and added again, not edited.
    const editable = canEdit(item.scope, isAdmin);
    return (
      <div className="detail">
        <DetailHeader title={item.title} scope={item.scope} canEdit={editable}>
          {INTRO}
        </DetailHeader>
        <dl className="notice mt-6 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-3 py-2 text-sm">
          <dt className="text-fg-secondary">Částí</dt>
          <dd>{item.chunks}</dd>
          <dt className="text-fg-secondary">Přidáno</dt>
          <dd>{new Date(item.createdAt).toLocaleString("cs-CZ")}</dd>
        </dl>
        {editable && (
          <button
            disabled={busy}
            onClick={() => attempt(setBusy, setError, async () => (await api.deleteDocument(item.id, item.scope), onDeleted()))}
            className="btn-danger mt-6 text-sm"
          >
            Smazat dokument
          </button>
        )}
        <ErrorNotice error={error} />
      </div>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void attempt(setBusy, setError, async () => onSaved(documentKey(await api.addDocument(title, content, scope))));
  };

  return (
    <div className="detail">
      <DetailHeader title="Nový dokument" canEdit>
        {INTRO}
      </DetailHeader>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <ScopePicker value={scope} onChange={setScope} isAdmin={isAdmin} />
        <Field label="Název">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="např. Ceník 2026" required className="field" />
        </Field>
        <Field label="Text">
          <textarea value={content} onChange={(e) => setContent(e.target.value)} required rows={14} className="field" />
        </Field>
        <button disabled={busy} className="btn-primary">
          {busy ? "Ukládám…" : "Přidat"}
        </button>
      </form>
      <ErrorNotice error={error} />
    </div>
  );
}
