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
      <h1 className="section-header text-[13px]">Dovednosti</h1>
      <p className="mt-1 text-sm text-fg-secondary">
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
            className="field"
          />
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Kdy ji použít (jedna věta)"
            required
            className="field"
          />
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Postup krok za krokem"
            required
            rows={10}
            className="field text-sm"
          />
          <div className="flex gap-2">
            <button disabled={busy} className="btn-primary">
              {busy ? "Ukládám…" : editing ? "Uložit" : "Přidat"}
            </button>
            {editing && (
              <button type="button" onClick={reset} className="btn-secondary">
                Zrušit
              </button>
            )}
          </div>
        </form>
      )}
      {error && <p className="notice notice-error mt-3 px-3 py-2 text-sm">{error}</p>}

      <ul className="mt-8 divide-y divide-line">
        {skills.map((s) => (
          <li key={s.name} className="flex items-center justify-between gap-4 py-3">
            <span>
              <span className="font-medium">{s.name}</span>
              {s.source === "bundled" && <span className="badge ml-2">výchozí</span>}
              <span className="block text-sm text-fg-secondary">{s.description}</span>
            </span>
            {canEdit && (
              <span className="flex shrink-0 gap-3 text-sm">
                <button onClick={() => edit(s.name)} className="btn-link">{s.source === "bundled" ? "Upravit kopii" : "Upravit"}</button>
                {s.source === "tenant" && (
                  <button
                    onClick={() => api.deleteSkill(s.name).then(refresh, (e: Error) => setError(e.message))}
                    className="btn-danger"
                  >
                    Smazat
                  </button>
                )}
              </span>
            )}
          </li>
        ))}
        {!skills.length && <li className="py-3 text-fg-muted">Zatím žádné dovednosti.</li>}
      </ul>
    </div>
  );
}
