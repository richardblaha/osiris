import type { SkillSummary } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function Skills({ canEdit }: { canEdit: boolean }) {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = () => api.skills().then(setSkills, (e: Error) => setError(e.message));
  useEffect(() => void refresh(), []);

  const reset = () => {
    setName("");
    setDescription("");
    setInstructions("");
    setEditing(false);
  };

  const edit = async (skillName: string) => {
    setError(undefined);
    try {
      const s = await api.skill(skillName);
      setName(s.name);
      setDescription(s.description);
      setInstructions(s.instructions);
      setEditing(true);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.saveSkill(name, description, instructions);
      reset();
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto p-6">
      <h1 className="text-lg font-semibold">Dovednosti</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Postupy, podle kterých asistent pracuje (např. jak sestavit nabídku). Vlastní dovednost se stejným názvem nahradí
        výchozí.
      </p>

      {canEdit && (
        <form onSubmit={submit} className="mt-6 space-y-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
            placeholder="Název (malá písmena a pomlčky, např. revize-elektro)"
            pattern={NAME.source}
            readOnly={editing}
            required
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 read-only:bg-neutral-100"
          />
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Kdy ji použít (jedna věta)"
            required
            className="w-full rounded-lg border border-neutral-300 px-3 py-2"
          />
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Postup krok za krokem"
            required
            rows={10}
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 font-mono text-sm"
          />
          <div className="flex gap-2">
            <button disabled={busy} className="rounded-lg bg-neutral-900 px-4 py-2 text-white disabled:opacity-40">
              {busy ? "Ukládám…" : editing ? "Uložit" : "Přidat"}
            </button>
            {editing && (
              <button type="button" onClick={reset} className="rounded-lg px-4 py-2 text-neutral-600">
                Zrušit
              </button>
            )}
          </div>
        </form>
      )}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <ul className="mt-8 divide-y divide-neutral-200">
        {skills.map((s) => (
          <li key={s.name} className="flex items-center justify-between gap-4 py-3">
            <span>
              <span className="font-medium">{s.name}</span>
              {s.source === "bundled" && <span className="ml-2 text-xs text-neutral-400">výchozí</span>}
              <span className="block text-sm text-neutral-500">{s.description}</span>
            </span>
            {canEdit && (
              <span className="flex shrink-0 gap-3 text-sm">
                <button onClick={() => edit(s.name)}>{s.source === "bundled" ? "Upravit kopii" : "Upravit"}</button>
                {s.source === "tenant" && (
                  <button
                    onClick={() => api.deleteSkill(s.name).then(refresh, (e: Error) => setError(e.message))}
                    className="text-red-600"
                  >
                    Smazat
                  </button>
                )}
              </span>
            )}
          </li>
        ))}
        {!skills.length && <li className="py-3 text-neutral-500">Zatím žádné dovednosti.</li>}
      </ul>
    </div>
  );
}
