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
import { attempt, ErrorNotice, Field, Loading } from "./Scope.tsx";
import { loadSkills } from "./Skills.tsx";
import { MasterDetail } from "./MasterDetail.tsx";
import { t } from "i18next";
import { formatDateTime } from "./i18n.ts";

const toolLabel = (tool: PublicTool) => ({ label: t(`public:tools.${tool}.label`), hint: t(`public:tools.${tool}.hint`) });

const INQUIRIES = " inquiries";

/** A new assistant; its greeting is a starting point in the admin's language. */
const newAssistant = (): PublicAssistantSettings => ({
  name: "",
  enabled: false,
  title: "",
  greeting: t("public:defaultGreeting"),
  knowledge: [],
  memories: [],
  skills: [],
  tools: [],
  tokensPerMonth: null,
});

/**
 * The tenant's assistants for its customers: each with what it knows (picked knowledge, memories), which skills and
 * tools it has, how it talks, where customers find it (a link and the website widget); and the inquiries they took.
 * Settings are for admins.
 */
export function PublicAssistants({ tenantId, isAdmin }: { tenantId: string; isAdmin: boolean }) {
  const [list, setList] = useState<PublicAssistantSettings[]>();
  // An assistant's name, INQUIRIES, or null for a new one.
  const [selected, setSelected] = useState<string | null>(INQUIRIES);
  const [error, setError] = useState<string>();
  const load = () => api.publicAssistants().then(setList, (e: Error) => setError(e.message));
  useEffect(() => void (isAdmin ? load() : undefined), []);
  const open = list?.find((a) => a.name === selected);

  return (
    <MasterDetail
      title={t("app:nav.assistants")}
      loading={isAdmin && !list && !error}
      top={<p className="px-2 text-xs text-fg-muted">{t("public:intro")}</p>}
      groups={[
        { items: [{ key: INQUIRIES, label: t("public:inquiries") }] },
        ...(isAdmin
          ? [
              {
                title: t("app:nav.assistants"),
                items: (list ?? []).map((a) => ({
                  key: a.name,
                  label: a.title || a.name,
                  hint: a.name,
                  badge: <span className={`text-xs ${a.enabled ? "text-success" : "text-fg-muted"}`}>{a.enabled ? t("public:on") : t("public:off")}</span>,
                })),
                empty: t("noneYet"),
              },
            ]
          : []),
      ]}
      selected={selected}
      onSelect={setSelected}
      add={isAdmin ? { label: t("public:add"), onClick: () => setSelected(null) } : undefined}
    >
      {error ? (
        <div className="detail">
          <ErrorNotice error={error} />
        </div>
      ) : selected === INQUIRIES ? (
        <div className="detail max-w-3xl">
          <Inquiries />
        </div>
      ) : selected === null || open ? (
        <Editor
          key={open?.name ?? "new"}
          tenantId={tenantId}
          initial={open ?? newAssistant()}
          onSaved={(name) => void load().then(() => setSelected(name))}
          onDeleted={() => void load().then(() => setSelected(INQUIRIES))}
        />
      ) : undefined}
    </MasterDetail>
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

function Editor({
  tenantId,
  initial,
  onSaved,
  onDeleted,
}: {
  tenantId: string;
  initial: PublicAssistantSettings;
  onSaved: (name: string) => void;
  onDeleted: () => void;
}) {
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
      setSettings(next);
      setSaved(true);
      onSaved(next.name);
    });
  };
  const remove = () =>
    window.confirm(t("public:confirmDelete", { name: settings.title || settings.name })) &&
    void attempt(setBusy, setError, async () => (await api.deletePublicAssistant(settings.name), onDeleted()));
  // Inside a picked folder everything is picked.
  const covered = (path: string) => settings.knowledge.some((k) => k !== path && path.startsWith(`${k}/`));
  const link = `${location.origin}/c/${tenantId}/${settings.name}`;
  const snippet = `<script src="${location.origin}/widget.js" data-tenant="${tenantId}" data-assistant="${settings.name}" async></script>`;

  return (
    <div className="detail max-w-3xl space-y-10">
      <div>
        <h1 className="text-lg font-semibold">{isNew ? t("public:new") : settings.title || settings.name}</h1>
      </div>
      <form onSubmit={submit} className="space-y-6">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={settings.enabled} onChange={(e) => set("enabled", e.target.checked)} />
          {t("public:enabled")}
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("public:name")}>
            <input
              value={settings.name}
              onChange={(e) => set("name", e.target.value.trim().toLowerCase())}
              disabled={!isNew}
              required
              maxLength={40}
              pattern={PUBLIC_ASSISTANT_NAME.source}
              placeholder={t("public:namePlaceholder")}
              className="field"
            />
          </Field>
          <Field label={t("public:title")}>
            <input value={settings.title} onChange={(e) => set("title", e.target.value)} placeholder={tenantId} maxLength={120} className="field" />
          </Field>
          <Field label={t("public:tokens")}>
            <input
              type="number"
              min={0}
              value={settings.tokensPerMonth ?? ""}
              onChange={(e) => set("tokensPerMonth", e.target.value === "" ? null : Number(e.target.value))}
              className="field w-48"
            />
          </Field>
        </div>
        <Field label={t("public:greeting")}>
          <input value={settings.greeting} onChange={(e) => set("greeting", e.target.value)} maxLength={500} className="field" />
        </Field>

        <Picker title={t("tenants:features.knowledge.label")} hint={t("public:knowledgeHint")} empty={t("public:knowledgeEmpty")}>
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
        <Picker title={t("app:nav.memory")} hint={t("public:memoryHint")} empty={t("public:memoryEmpty")}>
          {memories.map((m) => (
            <Check key={m.id} checked={settings.memories.includes(m.id)} onChange={(on) => toggle("memories", m.id, on)}>
              {m.content}
            </Check>
          ))}
        </Picker>
        <Picker title={t("app:nav.skills")} hint={t("public:skillsHint")} empty={t("public:skillsEmpty")}>
          {skills.map((s) => (
            <Check key={s.name} checked={settings.skills.includes(s.name)} onChange={(on) => toggle("skills", s.name, on)}>
              {s.name} <span className="text-fg-muted">· {s.description}</span>
            </Check>
          ))}
        </Picker>
        <Picker title={t("public:toolsTitle")}>
          {PUBLIC_TOOLS.map((tool) => (
            <Check key={tool} checked={settings.tools.includes(tool)} onChange={(on) => toggle("tools", tool, on)}>
              {toolLabel(tool).label} <span className="text-fg-muted">· {toolLabel(tool).hint}</span>
            </Check>
          ))}
        </Picker>

        <ErrorNotice error={error} />
        <div className="flex items-center gap-3">
          <button disabled={busy} className="btn-primary">
            {t("save")}
          </button>
          {saved && <span className="text-sm text-success">{t("savedNotice")}</span>}
          <span className="flex-1" />
          {!isNew && (
            <button type="button" disabled={busy} onClick={remove} className="btn-danger text-sm">
              {t("public:delete")}
            </button>
          )}
        </div>
      </form>

      {!isNew && (
        <>
          <section>
            <h2 className="section-header">{t("public:where")}</h2>
            <p className="mt-2 text-sm">
              {t("public:link")}{" "}
              <a href={link} target="_blank" rel="noreferrer" className="btn-link">
                {link}
              </a>
            </p>
            <p className="mt-3 text-sm">{t("public:snippetHint")}</p>
            <div className="mt-1 flex gap-2">
              <input readOnly value={snippet} onFocus={(e) => e.target.select()} className="field min-w-0 flex-1 font-mono text-xs" />
              <button type="button" onClick={() => void navigator.clipboard.writeText(snippet)} className="btn-secondary text-sm">
                {t("copy")}
              </button>
            </div>
          </section>

          <section>
            <h2 className="section-header">{t("public:persona")}</h2>
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
    <section className="relative min-h-32">
      <Loading show={!list && !error} />
      <h2 className="section-header">{t("public:inquiries")}</h2>
      <ErrorNotice error={error} />
      {list && !list.length && <p className="mt-2 text-sm text-fg-muted">{t("noneYet")}</p>}
      <ul className="mt-2 space-y-2">
        {list?.map((i) => (
          <li key={i.id} className={`notice px-3 py-2 text-sm ${i.status === "done" ? "opacity-60" : ""}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{i.name}</span>
              <span className="text-fg-secondary">{i.contact}</span>
              {i.assistant && <code className="text-xs text-fg-muted">{i.assistant}</code>}
              <span className="flex-1 text-end text-xs text-fg-muted">{formatDateTime(`${i.createdAt.replace(" ", "T")}Z`)}</span>
            </div>
            <p className="mt-1 whitespace-pre-wrap">{i.description}</p>
            {i.preferredTime && <p className="mt-1 text-xs text-fg-secondary">{t("public:time", { time: i.preferredTime })}</p>}
            <div className="mt-2 flex gap-3 text-xs">
              <button
                disabled={busy}
                onClick={() => void attempt(setBusy, setError, async () => (await api.setInquiryStatus(i.id, i.status === "done" ? "new" : "done"), await load()))}
                className="btn-link"
              >
                {i.status === "done" ? t("public:reopen") : t("public:done")}
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
                  {open?.id === i.id ? t("public:hideConversation") : t("public:conversation")}
                </button>
              )}
            </div>
            {open?.id === i.id && (
              <div className="mt-2 space-y-1 border-t border-line pt-2 text-xs">
                {open.messages.map((m) => (
                  <p key={m.id} className="whitespace-pre-wrap">
                    <span className="font-medium">{m.role === "user" ? t("public:customer") : t("dashboards:columns.assistant")}:</span>{" "}
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
