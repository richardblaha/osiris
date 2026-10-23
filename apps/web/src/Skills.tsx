import type { Scope, SkillSummary } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { LazyCodeEditor } from "./LazyCodeEditor.tsx";
import { attempt, DetailHeader, ErrorNotice, Field, type DetailProps, Pending } from "./Scope.tsx";
import { t } from "i18next";
import { compareText } from "./i18n.ts";

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const skillKey = (s: Pick<SkillSummary, "source" | "name">) => `${s.source}:${s.name}`;

/** The tenant's skills and the bundled ones it didn't replace. */
export async function loadSkills(): Promise<SkillSummary[]> {
  return (await api.skills("tenant")).sort((a, b) => compareText(a.name, b.name));
}

const intro = () => t("skills:intro");

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
    if (!instructions.trim()) return setError(t("skills:instructionsRequired"));
    void attempt(setBusy, setError, async () => {
      await api.saveSkill(name, description, instructions, scope);
      onSaved(skillKey({ source: scope, name }));
    });
  };

  return (
    <div className="detail">
      <DetailHeader title={item?.name ?? t("skills:new")} scope={item ? (item.source === "bundled" ? undefined : item.source) : scope} canEdit={!!own}>
        {item?.source === "bundled" ? t("skills:bundled") : intro()}
      </DetailHeader>
      {!loaded && <Pending error={error} />}
      {loaded && (
        <form onSubmit={submit} className="mt-6 space-y-4">
          <Field label={t("name")}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder={t("skills:namePlaceholder")}
              pattern={NAME.source}
              readOnly={!!item}
              required
              className="field"
            />
          </Field>
          <Field label={t("skills:when")}>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("skills:whenPlaceholder")} required disabled={!isAdmin} className="field" />
          </Field>
          <div className="space-y-1">
            <span className="section-header block">{t("skills:instructions", { path: `skills/${name || "…"}/SKILL.md` })}</span>
            <LazyCodeEditor path="SKILL.md" value={instructions} readOnly={!isAdmin} onChange={setInstructions} height="50vh" />
          </div>
          <div className={`flex items-center gap-4 ${isAdmin ? "" : "hidden"}`}>
            <button disabled={busy} className="btn-primary">
              {busy ? t("saving") : !item ? t("add") : own ? t("save") : t("skills:saveCopy")}
            </button>
            {own && (
              <button
                type="button"
                disabled={busy}
                onClick={() => attempt(setBusy, setError, async () => (await api.deleteSkill(item.name, item.source as Scope), onDeleted()))}
                className="btn-danger text-sm"
              >
                {t("delete")}
              </button>
            )}
          </div>
        </form>
      )}
      <ErrorNotice error={error} />
    </div>
  );
}
