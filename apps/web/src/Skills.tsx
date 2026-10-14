import type { Scope, SkillSummary } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { ScopeBadge, ScopeSelect } from "./Scope.tsx";

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function Skills({ isAdmin }: { isAdmin: boolean }) {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [scope, setScope] = useState<Scope>("personal");
  /** Editing an existing skill in place (its scope is fixed); false for a new skill or a copy. */
  const [editing, setEditing] = useState(false);
  /** Editing a copy of a bundled or tenant skill the user can't change in place. */
  const [copying, setCopying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = () => api.skills().then(setSkills, (e: Error) => setError(e.message));
  useEffect(() => void refresh(), []);

  const reset = () => {
    setName("");
    setDescription("");
    setInstructions("");
    setScope("personal");
    setEditing(false);
    setCopying(false);
  };

  /** Personal skills are always the user's; tenant skills only an admin may change in place. */
  const canEditInPlace = (s: SkillSummary) => s.source === "personal" || (s.source === "tenant" && isAdmin);

  const edit = async (summary: SkillSummary) => {
    setError(undefined);
    try {
      const s = await api.skill(summary.name);
      setName(s.name);
      setDescription(s.description);
      setInstructions(s.instructions);
      const inPlace = canEditInPlace(summary);
      setEditing(inPlace);
      setCopying(!inPlace);
      // A copy of a bundled or tenant skill becomes a personal override (admins may pick the tenant instead).
      setScope(inPlace && summary.source === "tenant" ? "tenant" : "personal");
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
      <h1 className="section-header text-[13px]">Dovednosti</h1>
      <p className="mt-1 text-sm text-fg-secondary">
        Postupy, podle kterých asistent pracuje (např. jak sestavit nabídku). Osobní dovednost má přednost před firemní a
        ta před výchozí se stejným názvem.
      </p>

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
            {busy ? "Ukládám…" : editing ? "Uložit" : copying && scope === "personal" ? "Uložit jako osobní" : "Přidat"}
          </button>
          <ScopeSelect isAdmin={isAdmin} value={scope} onChange={setScope} disabled={editing} />
          {(editing || name) && (
            <button type="button" onClick={reset} className="btn-secondary">
              Zrušit
            </button>
          )}
        </div>
      </form>
      {error && <p className="notice notice-error mt-3 px-3 py-2 text-sm">{error}</p>}

      <ul className="mt-8 divide-y divide-line">
        {skills.map((s) => (
          <li key={s.name} className="flex items-center justify-between gap-4 py-3">
            <span>
              <span className="font-medium">{s.name}</span>
              <span className="ml-2">
                <ScopeBadge scope={s.source} />
              </span>
              <span className="block text-sm text-fg-secondary">{s.description}</span>
            </span>
            <span className="flex shrink-0 gap-3 text-sm">
              <button onClick={() => edit(s)} className="btn-link">
                {canEditInPlace(s) ? "Upravit" : "Upravit kopii"}
              </button>
              {s.source !== "bundled" && canEditInPlace(s) && (
                <button
                  onClick={() => api.deleteSkill(s.name, s.source as Scope).then(refresh, (e: Error) => setError(e.message))}
                  className="btn-danger"
                >
                  Smazat
                </button>
              )}
            </span>
          </li>
        ))}
        {!skills.length && <li className="py-3 text-fg-muted">Zatím žádné dovednosti.</li>}
      </ul>
    </div>
  );
}
