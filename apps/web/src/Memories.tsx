import type { Memory } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";

export function Memories({ isAdmin }: { isAdmin: boolean }) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [content, setContent] = useState("");
  const [shared, setShared] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = () => api.memories().then(setMemories, (e: Error) => setError(e.message));
  useEffect(() => void refresh(), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      await api.addMemory(content, shared);
      setContent("");
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto p-6">
      <h1 className="section-header text-[13px]">Paměť</h1>
      <p className="mt-1 text-sm text-fg-secondary">
        Co si asistent pamatuje mezi konverzacemi. Osobní záznamy vidíš jen ty, firemní všichni ve firmě.
      </p>

      <form onSubmit={submit} className="mt-6 flex flex-wrap items-center gap-2">
        <input
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Např. Nejsem plátce DPH"
          maxLength={500}
          required
          className="field min-w-0 flex-1"
        />
        {isAdmin && (
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> pro celou firmu
          </label>
        )}
        <button className="btn-primary">Přidat</button>
      </form>
      {error && <p className="notice notice-error mt-3 px-3 py-2 text-sm">{error}</p>}

      <ul className="mt-8 divide-y divide-line">
        {memories.map((m) => (
          <li key={m.id} className="flex items-center justify-between gap-4 py-3">
            <span>
              {m.content}
              {m.shared && <span className="badge badge-accent ml-2">firma</span>}
            </span>
            {(!m.shared || isAdmin) && (
              <button
                onClick={() => api.deleteMemory(m.id).then(refresh, (e: Error) => setError(e.message))}
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
