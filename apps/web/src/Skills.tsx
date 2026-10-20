import type { Scope, SkillSummary } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { LazyCodeEditor } from "./LazyCodeEditor.tsx";
import { attempt, DetailHeader, ErrorNotice, Field, type DetailProps } from "./Scope.tsx";

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const skillKey = (s: Pick<SkillSummary, "source" | "name">) => `${s.source}:${s.name}`;

/** The tenant's skills and the bundled ones it didn't replace. */
export async function loadSkills(): Promise<SkillSummary[]> {
  return (await api.skills("tenant")).sort((a, b) => a.name.localeCompare(b.name));
}

const INTRO =
  "Postupy, podle kterých asistent pracuje (např. jak sestavit nabídku). Jsou to soubory skills/<název>/SKILL.md. Dovednost tenanta má přednost před výchozí se stejným názvem.";

export function SkillDetail({ item, isAdmin, onSaved, onDeleted }: DetailProps<SkillSummary>) {
  const [name, setName] = useState(item?.name ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [instructions, setInstructions] = useState("");
  /** Admins change the tenant's skills, and a bundled one by saving the tenant's copy. */
  const own = item && item.source !== "bundled" && isAdmin;
  const scope: Scope = "tenant";
  const [loaded, setLoaded] = useState(!item);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!item) return;
    api.skill(item.name, "tenant").then((s) => {
      setInstructions(s.instructions);
      setLoaded(true);
    }, (e: Error) => setError(e.message));
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!instructions.trim()) return setError("Napiš postup dovednosti.");
    void attempt(setBusy, setError, async () => {
      await api.saveSkill(name, description, instructions, scope);
      onSaved(skillKey({ source: scope, name }));
    });
  };

  return (
    <div className="detail">
      <DetailHeader title={item?.name ?? "Nová dovednost"} scope={item ? (item.source === "bundled" ? undefined : item.source) : scope} canEdit={!!own}>
        {item?.source === "bundled" ? "Výchozí dovednost, která je součástí aplikace. Správce ji změní uložením kopie se stejným názvem." : INTRO}
      </DetailHeader>
      {loaded && (
        <form onSubmit={submit} className="mt-6 space-y-4">
          <Field label="Název">
            <input
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder="malá písmena a pomlčky, např. revize-elektro"
              pattern={NAME.source}
              readOnly={!!item}
              required
              className="field"
            />
          </Field>
          <Field label="Kdy ji použít">
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="jedna věta" required disabled={!isAdmin} className="field" />
          </Field>
          <div className="space-y-1">
            <span className="section-header block">Postup (Markdown, uloží se jako skills/{name || "…"}/SKILL.md)</span>
            <LazyCodeEditor path="SKILL.md" value={instructions} readOnly={!isAdmin} onChange={setInstructions} height="50vh" />
          </div>
          <div className={`flex items-center gap-4 ${isAdmin ? "" : "hidden"}`}>
            <button disabled={busy} className="btn-primary">
              {busy ? "Ukládám…" : !item ? "Přidat" : own ? "Uložit" : "Uložit kopii"}
            </button>
            {own && (
              <button
                type="button"
                disabled={busy}
                onClick={() => attempt(setBusy, setError, async () => (await api.deleteSkill(item.name, item.source as Scope), onDeleted()))}
                className="btn-danger text-sm"
              >
                Smazat
              </button>
            )}
          </div>
        </form>
      )}
      <ErrorNotice error={error} />
    </div>
  );
}
