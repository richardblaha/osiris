import { PersonaEditor } from "./PersonaEditor.tsx";
import { CUSTOM_PERSONA, type AssistantProfile, type AssistantProfiles, type Scope } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { attempt, ErrorNotice, Pending } from "./Scope.tsx";
import { t } from "i18next";

/**
 * The assistant's persona at one level (the project's, the user's own or a public assistant's). A persona is written
 * by the model from a free-form description, then edited before saving. Rules are guards (Guards.tsx).
 */
export function AssistantSettings({ scope, editable, assistant }: { scope: "personal" | "public"; editable: boolean; assistant?: string }) {
  const [all, setAll] = useState<AssistantProfiles>();
  const [error, setError] = useState<string>();
  useEffect(() => void api.assistant(assistant).then(setAll, (e: Error) => setError(e.message)), []);
  if (!all) return <Pending error={error} />;
  const own = (scope === "public" ? all.public : all.personal) ?? { persona: null };
  return (
    <ProfileForm
      key={scope}
      scope={scope}
      profile={own}
      editable={editable}
      inherited={all}
      assistant={assistant}
      onSaved={(p) => setAll({ ...all, [scope]: p })}
    />
  );
}

function ProfileForm({
  scope,
  profile,
  editable,
  inherited,
  assistant,
  onSaved,
}: {
  scope: Scope | "public";
  profile: AssistantProfile;
  editable: boolean;
  inherited: AssistantProfiles;
  assistant?: string;
  onSaved: (p: AssistantProfile) => void;
}) {
  const [description, setDescription] = useState(profile.persona?.description ?? "");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const generate = () => {
    setSaved(false);
    return attempt(setBusy, setError, async () => setDescription((await api.generatePersona(description)).description));
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const next: AssistantProfile = { persona: description.trim() ? { character: CUSTOM_PERSONA, source: "", description: description.trim() } : null };
    void attempt(setBusy, setError, async () => {
      onSaved(await api.saveAssistant(scope, next, assistant));
      setSaved(true);
    });
  };

  return (
    <form onSubmit={submit} className="mt-4 space-y-4">
      <div>
        <span className="section-header block">{t("assistant:persona")}</span>
        <p className="mt-1 text-xs text-fg-muted">
          {t("assistant:personaHint")}
          {scope === "public" && ` ${t("assistant:publicOnly")}`}
        </p>
        <PersonaEditor value={description} onChange={(value) => { setDescription(value); setSaved(false); }} onGenerate={() => void generate()} busy={busy} disabled={!editable} />
      </div>

      <ErrorNotice error={error} />
      {editable && (
        <div className="flex items-center gap-3">
          <button disabled={busy} className="btn-primary">
            {t("assistant:save")}
          </button>
          {saved && <span className="text-sm text-success">{t("savedNotice")}</span>}
        </div>
      )}
    </form>
  );
}
