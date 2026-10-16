import type { SkillSummary } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { PageHeader, ScopeBadge, type ScopedProps } from "./Scope.tsx";

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function Skills({ scope, canEdit }: ScopedProps) {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  /** Editing a skill of this scope in place; false for a new skill or a copy of an inherited one. */
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  // The tenant view lists tenant and bundled skills; the personal one also the user's own, which win by name.
  const refresh = () => api.skills(scope).then(setSkills, (e: Error) => setError(e.message));
  useEffect(() => void refresh(), []);

  const reset = () => {
    setName("");
    setDescription("");
    setInstructions("");
    setEditing(false);
  };

  /** A skill from a lower level (bundled, or tenant in the personal view) is changed by saving a copy here. */
  const own = (s: SkillSummary) => s.source === scope;

  const edit = async (summary: SkillSummary) => {
    setError(undefined);
    try {
      const s = await api.skill(summary.name, scope);
      setName(s.name);
      setDescription(s.description);
      setInstructions(s.instructions);
      setEditing(own(summary));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.saveSkill(name, description, instructions, scope);
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
      <PageHeader title="Dovednosti" scope={scope} canEdit={canEdit}>
        Postupy, podle kterých asistent pracuje (např. jak sestavit nabídku). Osobní dovednost má přednost před dovedností
        tenanta a ta před výchozí se stejným názvem.
      </PageHeader>

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
          <div className="flex items-center gap-2">
            <button disabled={busy} className="btn-primary">
              {busy ? "Ukládám…" : editing ? "Uložit" : "Přidat"}
            </button>
            {(editing || name) && (
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
              {!own(s) && (
                <span className="ml-2">
                  <ScopeBadge scope={s.source} />
                </span>
              )}
              <span className="block text-sm text-fg-secondary">{s.description}</span>
            </span>
            {canEdit && (
              <span className="flex shrink-0 gap-3 text-sm">
                <button onClick={() => edit(s)} className="btn-link">
                  {own(s) ? "Upravit" : "Upravit kopii"}
                </button>
                {own(s) && (
                  <button
                    onClick={() => api.deleteSkill(s.name, scope).then(refresh, (e: Error) => setError(e.message))}
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
