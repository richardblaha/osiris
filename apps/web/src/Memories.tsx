import type { Memory } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { PageHeader, type ScopedProps } from "./Scope.tsx";

export function Memories({ scope, canEdit }: ScopedProps) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = () => api.memories().then((all) => setMemories(all.filter((m) => m.scope === scope)), (e: Error) => setError(e.message));
  useEffect(() => void refresh(), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.addMemory(content, scope);
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
      <PageHeader title="Paměť" scope={scope} canEdit={canEdit}>
        Fakta, která si asistent pamatuje mezi konverzacemi. Ukládá si je i sám, když mu něco řekneš.
      </PageHeader>

      {canEdit && (
      <form onSubmit={submit} className="mt-6 space-y-2">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Např. Nejsem plátce DPH. Zálohy chci 50 % předem."
          maxLength={500}
          rows={3}
          required
          className="field"
        />
        <div className="flex items-center gap-2">
          <button disabled={busy} className="btn-primary">
            {busy ? "Ukládám…" : "Přidat"}
          </button>
        </div>
      </form>
      )}
      {error && <p className="notice notice-error mt-3 px-3 py-2 text-sm">{error}</p>}

      <ul className="mt-8 divide-y divide-line">
        {memories.map((m) => (
          <li key={m.id} className="flex items-center justify-between gap-4 py-3">
            <span>{m.content}</span>
            {canEdit && (
              <button
                onClick={() => api.deleteMemory(m.id, m.scope).then(refresh, (e: Error) => setError(e.message))}
                className="btn-danger shrink-0 text-sm"
              >
                Smazat
              </button>
            )}
          </li>
        ))}
        {!memories.length && <li className="py-3 text-fg-muted">Zatím nic.</li>}
      </ul>
    </div>
  );
}
