import type { DocumentSummary, Scope } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { ScopeBadge, ScopeSelect } from "./Scope.tsx";

export function Knowledge({ isAdmin }: { isAdmin: boolean }) {
  const [docs, setDocs] = useState<DocumentSummary[]>([]);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [scope, setScope] = useState<Scope>("personal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = () => api.documents().then(setDocs, (e: Error) => setError(e.message));
  useEffect(() => void refresh(), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.addDocument(title, content, scope);
      setTitle("");
      setContent("");
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto p-6">
      <h1 className="section-header text-[13px]">Znalostní báze</h1>
      <p className="mt-1 text-sm text-fg-secondary">
        Poznámky ke klientům, ceníky a postupy, ve kterých asistent vyhledává. Osobní dokumenty vidíš a prohledáváš jen
        ty, firemní všichni ve firmě.
      </p>

      <form onSubmit={submit} className="mt-6 space-y-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Název (např. Ceník 2026)"
          required
          className="field"
        />
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Text dokumentu"
          required
          rows={8}
          className="field"
        />
        <div className="flex items-center gap-2">
          <button disabled={busy} className="btn-primary">
            {busy ? "Ukládám…" : "Přidat"}
          </button>
          <ScopeSelect isAdmin={isAdmin} value={scope} onChange={setScope} />
        </div>
      </form>
      {error && <p className="notice notice-error mt-3 px-3 py-2 text-sm">{error}</p>}

      <ul className="mt-8 divide-y divide-line">
        {docs.map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-4 py-3">
            <span>
              {d.title} <ScopeBadge scope={d.scope} />{" "}
              <span className="text-sm text-fg-secondary">· {d.chunks} částí</span>
            </span>
            {(d.scope === "personal" || isAdmin) && (
              <button
                onClick={() => api.deleteDocument(d.id, d.scope).then(refresh, (e: Error) => setError(e.message))}
                className="btn-danger text-sm"
              >
                Smazat
              </button>
            )}
          </li>
        ))}
        {!docs.length && <li className="py-3 text-fg-muted">Zatím žádné dokumenty.</li>}
      </ul>
    </div>
  );
}
