import {
  PUBLIC_ASSISTANT_NAME,
  PUBLIC_TOOLS,
  type DocumentSummary,
  type Inquiry,
  type Memory,
  type PublicAssistantSettings,
  type PublicTool,
  type SkillSummary,
  type ThreadMessage,
} from "@osiris/shared";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api } from "./api.ts";
import { AssistantSettings } from "./Assistant.tsx";
import { attempt, ErrorNotice, Field } from "./Scope.tsx";
import { loadSkills } from "./Skills.tsx";

const TOOL_LABELS: Record<PublicTool, { label: string; hint: string }> = {
  estimate_price: { label: "Odhad ceny zakázky", hint: "spočítá orientační cenu z ceníku v jeho znalostech" },
  create_inquiry: { label: "Poptávka", hint: "převezme jméno, kontakt a popis zakázky a pošle vám e-mail" },
};

const NEW: PublicAssistantSettings = {
  name: "",
  enabled: false,
  title: "",
  greeting: "Dobrý den, s čím vám můžu pomoct?",
  knowledge: [],
  memories: [],
  skills: [],
  tools: [],
  tokensPerMonth: null,
};

/**
 * The tenant's assistants for its customers: each with what it knows (picked knowledge, memories), which skills and
 * tools it has, how it talks, where customers find it (a link and the website widget); and the inquiries they took.
 * Settings are for admins.
 */
export function PublicAssistants({ tenantId, isAdmin }: { tenantId: string; isAdmin: boolean }) {
  const [list, setList] = useState<PublicAssistantSettings[]>();
  const [editing, setEditing] = useState<PublicAssistantSettings>();
  const [error, setError] = useState<string>();
  const load = () => api.publicAssistants().then(setList, (e: Error) => setError(e.message));
  useEffect(() => void (isAdmin ? load() : undefined), []);

  if (editing) {
    return (
      <Editor
        key={editing.name || "new"}
        tenantId={tenantId}
        initial={editing}
        onDone={() => (setEditing(undefined), void load())}
      />
    );
  }
  return (
    <div className="detail max-w-3xl space-y-10">
      <div>
        <div className="flex items-center gap-3">
          <h1 className="min-w-0 flex-1 text-lg font-semibold">Asistenti</h1>
          {isAdmin && (
            <button onClick={() => setEditing(NEW)} className="btn-primary">
              + Přidat asistenta
            </button>
          )}
        </div>
        <p className="mt-1 text-sm text-fg-secondary">
          Asistenti pro vaše zákazníky na webu, bez přihlášení. Každý ví jen to, co mu vyberete ze znalostní báze a paměti, a má jen vybrané
          dovednosti a nástroje; nic jiného z Osirisu nevidí.
        </p>
        <ErrorNotice error={error} />
        {isAdmin && (
          <ul className="mt-4 text-sm">
            {list?.map((a) => (
              <li key={a.name}>
                <button onClick={() => setEditing(a)} className="list-row flex w-full items-center gap-2 px-2 py-2 text-left">
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{a.title || a.name}</span> <code className="text-xs text-fg-muted">{a.name}</code>
                  </span>
                  <span className={`text-xs ${a.enabled ? "text-success" : "text-fg-muted"}`}>{a.enabled ? "zapnutý" : "vypnutý"}</span>
                </button>
              </li>
            ))}
            {list && !list.length && <p className="px-2 py-2 text-fg-muted">Zatím žádný.</p>}
          </ul>
        )}
      </div>
      <Inquiries />
    </div>
  );
}

/** Documents and folders of the knowledge base (relative to knowledge/), folders first. */
function knowledgeEntries(docs: DocumentSummary[]): { path: string; label: string; folder: boolean }[] {
  const folders = new Set<string>();
  for (const d of docs) d.id.split("/").slice(0, -1).forEach((_, i, parts) => folders.add(parts.slice(0, i + 1).join("/")));
  return [
    ...[...folders].sort().map((f) => ({ path: f, label: `${f}/`, folder: true })),
    ...docs.map((d) => ({ path: d.id, label: `${d.title} (${d.id})`, folder: false })),
  ];
}

function Editor({ tenantId, initial, onDone }: { tenantId: string; initial: PublicAssistantSettings; onDone: () => void }) {
  const isNew = !initial.name;
  const [settings, setSettings] = useState(initial);
  const [docs, setDocs] = useState<DocumentSummary[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // A switched-off feature's list is just empty.
  useEffect(() => {
    void api.documents().then(setDocs, () => {});
    void api.memories().then((m) => setMemories(m.filter((x) => x.scope === "tenant")), () => {});
    void loadSkills().then((s) => setSkills(s.filter((x) => x.source === "tenant")), () => {});
  }, []);

  const set = <K extends keyof PublicAssistantSettings>(key: K, value: PublicAssistantSettings[K]) => (setSettings({ ...settings, [key]: value }), setSaved(false));
  const toggle = (key: "knowledge" | "memories" | "skills" | "tools", value: string, on: boolean) =>
    set(key, (on ? [...settings[key], value] : (settings[key] as string[]).filter((x) => x !== value)) as never);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void attempt(setBusy, setError, async () => {
      const next = await api.savePublicAssistant(settings);
      if (isNew) return onDone();
      setSettings(next);
      setSaved(true);
    });
  };
  const remove = () =>
    window.confirm(`Smazat asistenta ${settings.title || settings.name}? Odkazy a widgety na webu přestanou fungovat.`) &&
    void attempt(setBusy, setError, async () => (await api.deletePublicAssistant(settings.name), onDone()));
  // Inside a picked folder everything is picked.
  const covered = (path: string) => settings.knowledge.some((k) => k !== path && path.startsWith(`${k}/`));
  const link = `${location.origin}/c/${tenantId}/${settings.name}`;
  const snippet = `<script src="${location.origin}/widget.js" data-tenant="${tenantId}" data-assistant="${settings.name}" async></script>`;

  return (
    <div className="detail max-w-3xl space-y-10">
      <div>
        <button onClick={onDone} className="text-sm text-fg-secondary hover:text-primary">
          ← Asistenti
        </button>
        <h1 className="mt-2 text-lg font-semibold">{isNew ? "Nový asistent" : settings.title || settings.name}</h1>
      </div>
      <form onSubmit={submit} className="space-y-6">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={settings.enabled} onChange={(e) => set("enabled", e.target.checked)} />
          Zapnuto (zákazníci mohou psát)
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Název v odkazu (malá písmena, číslice, pomlčky)">
            <input
              value={settings.name}
              onChange={(e) => set("name", e.target.value.trim().toLowerCase())}
              disabled={!isNew}
              required
              maxLength={40}
              pattern={PUBLIC_ASSISTANT_NAME.source}
              placeholder="např. web nebo eshop"
              className="field"
            />
          </Field>
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

        <Picker title="Znalostní báze" hint="Dokumenty a složky, ve kterých asistent hledá. Vybraná složka zahrnuje i vše, co do ní přibude." empty="Znalostní báze je prázdná.">
          {knowledgeEntries(docs).map((k) => (
            <Check
              key={k.path}
              checked={settings.knowledge.includes(k.path) || covered(k.path)}
              disabled={covered(k.path)}
              onChange={(on) => toggle("knowledge", k.path, on)}
            >
              {k.folder ? <span className="font-medium">{k.label}</span> : k.label}
            </Check>
          ))}
        </Picker>
        <Picker title="Paměť" hint="Fakta, která asistent dostane vždy (např. otevírací doba)." empty="V paměti nic není.">
          {memories.map((m) => (
            <Check key={m.id} checked={settings.memories.includes(m.id)} onChange={(on) => toggle("memories", m.id, on)}>
              {m.content}
            </Check>
          ))}
        </Picker>
        <Picker title="Dovednosti" hint="Postupy firmy, podle kterých smí asistent pracovat." empty="Firma nemá vlastní dovednosti.">
          {skills.map((s) => (
            <Check key={s.name} checked={settings.skills.includes(s.name)} onChange={(on) => toggle("skills", s.name, on)}>
              {s.name} <span className="text-fg-muted">· {s.description}</span>
            </Check>
          ))}
        </Picker>
        <Picker title="Nástroje">
          {PUBLIC_TOOLS.map((t) => (
            <Check key={t} checked={settings.tools.includes(t)} onChange={(on) => toggle("tools", t, on)}>
              {TOOL_LABELS[t].label} <span className="text-fg-muted">· {TOOL_LABELS[t].hint}</span>
            </Check>
          ))}
        </Picker>

        <ErrorNotice error={error} />
        <div className="flex items-center gap-3">
          <button disabled={busy} className="btn-primary">
            Uložit
          </button>
          {saved && <span className="text-sm text-success">Uloženo.</span>}
          <span className="flex-1" />
          {!isNew && (
            <button type="button" disabled={busy} onClick={remove} className="btn-danger text-sm">
              Smazat asistenta
            </button>
          )}
        </div>
      </form>

      {!isNew && (
        <>
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
            <AssistantSettings scope="public" assistant={settings.name} editable />
          </section>
        </>
      )}
    </div>
  );
}

function Picker({ title, hint, empty, children }: { title: string; hint?: string; empty?: string; children: ReactNode[] }) {
  return (
    <div>
      <span className="section-header block">{title}</span>
      {hint && <p className="mt-1 text-xs text-fg-muted">{hint}</p>}
      <div className="mt-1 max-h-64 overflow-y-auto">{children.length ? children : <p className="text-sm text-fg-muted">{empty}</p>}</div>
    </div>
  );
}

function Check({ checked, disabled, onChange, children }: { checked: boolean; disabled?: boolean; onChange: (on: boolean) => void; children: ReactNode }) {
  return (
    <label className="mt-1 flex items-start gap-2 text-sm">
      <input type="checkbox" className="mt-1" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0">{children}</span>
    </label>
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
              {i.assistant && <code className="text-xs text-fg-muted">{i.assistant}</code>}
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
