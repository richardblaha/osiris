import { PUBLIC_TOOLS, type Inquiry, type PublicAssistantSettings, type PublicTool, type ThreadMessage } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { AssistantSettings } from "./Assistant.tsx";
import { attempt, ErrorNotice, Field } from "./Scope.tsx";

const TOOL_LABELS: Record<PublicTool, { label: string; hint: string }> = {
  estimate_price: { label: "Odhad ceny zakázky", hint: "spočítá orientační cenu z ceníku ve veřejných souborech" },
  create_inquiry: { label: "Poptávka", hint: "převezme jméno, kontakt a popis zakázky a pošle vám e-mail" },
  load_skill: { label: "Veřejné dovednosti", hint: "postupy z firemních dovedností s public: true v hlavičce SKILL.md" },
};

/**
 * The assistant for the tenant's customers: what it knows (knowledge/public/), which tools it has, how it talks, where
 * customers find it (a link and the website widget), and the inquiries it took. Settings are for admins.
 */
export function PublicAssistant({ tenantId, isAdmin }: { tenantId: string; isAdmin: boolean }) {
  return (
    <div className="detail max-w-3xl space-y-10">
      <div>
        <h1 className="text-lg font-semibold">Veřejný asistent</h1>
        <p className="mt-1 text-sm text-fg-secondary">
          Asistent pro vaše zákazníky na webu, bez přihlášení. Ví jen to, co je ve firemní složce <code>knowledge/public</code> (obchodní podmínky,
          ceník pro zákazníky, popis služeb a průběhu zakázky, časté otázky); nic jiného z Osirisu nevidí.
        </p>
      </div>
      {isAdmin && <Settings tenantId={tenantId} />}
      <Inquiries />
    </div>
  );
}

function Settings({ tenantId }: { tenantId: string }) {
  const [settings, setSettings] = useState<PublicAssistantSettings>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => void api.publicAssistant().then(setSettings, (e: Error) => setError(e.message)), []);
  if (!settings) return <ErrorNotice error={error} />;

  const set = <K extends keyof PublicAssistantSettings>(key: K, value: PublicAssistantSettings[K]) => (setSettings({ ...settings, [key]: value }), setSaved(false));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void attempt(setBusy, setError, async () => (setSettings(await api.savePublicAssistant(settings)), setSaved(true)));
  };
  const link = `${location.origin}/c/${tenantId}`;
  const snippet = `<script src="${location.origin}/widget.js" data-tenant="${tenantId}" async></script>`;

  return (
    <>
      <form onSubmit={submit} className="space-y-4">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={settings.enabled} onChange={(e) => set("enabled", e.target.checked)} />
          Zapnuto (zákazníci mohou psát)
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Název firmy pro zákazníky">
            <input value={settings.title} onChange={(e) => set("title", e.target.value)} placeholder={tenantId} maxLength={120} className="field" />
          </Field>
          <Field label="Měsíční limit tokenů (prázdné = jen limit firmy)">
            <input
              type="number"
              min={0}
              value={settings.tokensPerMonth ?? ""}
              onChange={(e) => set("tokensPerMonth", e.target.value === "" ? null : Number(e.target.value))}
              className="field w-48"
            />
          </Field>
        </div>
        <Field label="Uvítání">
          <input value={settings.greeting} onChange={(e) => set("greeting", e.target.value)} maxLength={500} className="field" />
        </Field>
        <div>
          <span className="section-header block">Nástroje</span>
          <p className="mt-1 text-xs text-fg-muted">Hledání ve veřejných informacích má asistent vždy.</p>
          {PUBLIC_TOOLS.map((t) => (
            <label key={t} className="mt-1 flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={settings.tools.includes(t)}
                onChange={(e) => set("tools", e.target.checked ? [...settings.tools, t] : settings.tools.filter((x) => x !== t))}
              />
              <span>
                {TOOL_LABELS[t].label} <span className="text-fg-muted">· {TOOL_LABELS[t].hint}</span>
              </span>
            </label>
          ))}
        </div>
        <ErrorNotice error={error} />
        <div className="flex items-center gap-3">
          <button disabled={busy} className="btn-primary">
            Uložit
          </button>
          {saved && <span className="text-sm text-success">Uloženo.</span>}
        </div>
      </form>

      <section>
        <h2 className="section-header">Kde ho zákazníci najdou</h2>
        <p className="mt-2 text-sm">
          Odkaz:{" "}
          <a href={link} target="_blank" rel="noreferrer" className="btn-link">
            {link}
          </a>
        </p>
        <p className="mt-3 text-sm">Na váš web (např. do www/index.html před &lt;/body&gt;) vložte:</p>
        <div className="mt-1 flex gap-2">
          <input readOnly value={snippet} onFocus={(e) => e.target.select()} className="field min-w-0 flex-1 font-mono text-xs" />
          <button type="button" onClick={() => void navigator.clipboard.writeText(snippet)} className="btn-secondary text-sm">
            Kopírovat
          </button>
        </div>
      </section>

      <section>
        <h2 className="section-header">Persona a pravidla pro zákazníky</h2>
        <AssistantSettings scope="public" editable />
      </section>
    </>
  );
}

function Inquiries() {
  const [list, setList] = useState<Inquiry[]>();
  const [open, setOpen] = useState<{ id: string; messages: ThreadMessage[] }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const load = () => api.inquiries().then(setList, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);

  return (
    <section>
      <h2 className="section-header">Poptávky</h2>
      <ErrorNotice error={error} />
      {list && !list.length && <p className="mt-2 text-sm text-fg-muted">Zatím žádné.</p>}
      <ul className="mt-2 space-y-2">
        {list?.map((i) => (
          <li key={i.id} className={`notice px-3 py-2 text-sm ${i.status === "done" ? "opacity-60" : ""}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{i.name}</span>
              <span className="text-fg-secondary">{i.contact}</span>
              <span className="flex-1 text-right text-xs text-fg-muted">{new Date(`${i.createdAt.replace(" ", "T")}Z`).toLocaleString("cs-CZ")}</span>
            </div>
            <p className="mt-1 whitespace-pre-wrap">{i.description}</p>
            {i.preferredTime && <p className="mt-1 text-xs text-fg-secondary">Termín: {i.preferredTime}</p>}
            <div className="mt-2 flex gap-3 text-xs">
              <button
                disabled={busy}
                onClick={() => void attempt(setBusy, setError, async () => (await api.setInquiryStatus(i.id, i.status === "done" ? "new" : "done"), await load()))}
                className="btn-link"
              >
                {i.status === "done" ? "Vrátit mezi nové" : "Vyřízeno"}
              </button>
              {i.threadId && (
                <button
                  disabled={busy}
                  onClick={() =>
                    open?.id === i.id
                      ? setOpen(undefined)
                      : void attempt(setBusy, setError, async () => setOpen({ id: i.id, messages: await api.inquiryMessages(i.id) }))
                  }
                  className="btn-link"
                >
                  {open?.id === i.id ? "Skrýt konverzaci" : "Konverzace"}
                </button>
              )}
            </div>
            {open?.id === i.id && (
              <div className="mt-2 space-y-1 border-t border-line pt-2 text-xs">
                {open.messages.map((m) => (
                  <p key={m.id} className="whitespace-pre-wrap">
                    <span className="font-medium">{m.role === "user" ? "Zákazník" : "Asistent"}:</span>{" "}
                    {m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("")}
                  </p>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
