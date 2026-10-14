import type { Memory, Scope } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { ScopeBadge, ScopeSelect } from "./Scope.tsx";

export function Memories({ isAdmin }: { isAdmin: boolean }) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [content, setContent] = useState("");
  const [scope, setScope] = useState<Scope>("personal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = () => api.memories().then(setMemories, (e: Error) => setError(e.message));
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
      <h1 className="section-header text-[13px]">Paměť</h1>
      <p className="mt-1 text-sm text-fg-secondary">
        Fakta, která si asistent pamatuje mezi konverzacemi. Ukládá si je i sám, když mu něco řekneš. Osobní záznamy vidíš
        jen ty, firemní všichni ve firmě.
      </p>

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
          <ScopeSelect isAdmin={isAdmin} value={scope} onChange={setScope} />
        </div>
      </form>
      {error && <p className="notice notice-error mt-3 px-3 py-2 text-sm">{error}</p>}

      <ul className="mt-8 divide-y divide-line">
        {memories.map((m) => (
          <li key={m.id} className="flex items-center justify-between gap-4 py-3">
            <span>
              {m.content} <ScopeBadge scope={m.scope} />
            </span>
            {(m.scope === "personal" || isAdmin) && (
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
