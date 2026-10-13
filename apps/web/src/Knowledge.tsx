import { useEffect, useState, type FormEvent } from "react";
import { api, type DocumentSummary } from "./api.ts";

export function Knowledge({ canEdit }: { canEdit: boolean }) {
  const [docs, setDocs] = useState<DocumentSummary[]>([]);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = () => api.documents().then(setDocs, (e: Error) => setError(e.message));
  useEffect(() => void refresh(), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.addDocument(title, content);
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
    <div className="mx-auto max-w-3xl overflow-y-auto p-6">
      <h1 className="text-lg font-semibold">Znalostní báze</h1>
      <p className="mt-1 text-sm text-neutral-500">Poznámky ke klientům, ceníky a postupy, ve kterých asistent vyhledává.</p>

      {canEdit && (
        <form onSubmit={submit} className="mt-6 space-y-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Název (např. Ceník 2026)"
            required
            className="w-full rounded-lg border border-neutral-300 px-3 py-2"
          />
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Text dokumentu"
            required
            rows={8}
            className="w-full rounded-lg border border-neutral-300 px-3 py-2"
          />
          <button disabled={busy} className="rounded-lg bg-neutral-900 px-4 py-2 text-white disabled:opacity-40">
            {busy ? "Ukládám…" : "Přidat"}
          </button>
        </form>
      )}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <ul className="mt-8 divide-y divide-neutral-200">
        {docs.map((d) => (
          <li key={d.id} className="flex items-center justify-between py-3">
            <span>
              {d.title} <span className="text-sm text-neutral-500">· {d.chunks} částí</span>
            </span>
            {canEdit && (
              <button
                onClick={() => api.deleteDocument(d.id).then(refresh, (e: Error) => setError(e.message))}
                className="text-sm text-red-600"
              >
                Smazat
              </button>
            )}
          </li>
        ))}
        {!docs.length && <li className="py-3 text-neutral-500">Zatím žádné dokumenty.</li>}
      </ul>
    </div>
  );
}
