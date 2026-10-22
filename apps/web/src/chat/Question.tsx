import { useAui, useAuiState } from "@assistant-ui/react";
import type { ChatQuestion } from "@osiris/shared";
import { useEffect, useState, useContext, createContext } from "react";
import { api } from "../api.ts";
import { ThreadIdContext } from "./Thread.tsx";

export const QuestionLoaderContext = createContext<(thread: string, id: string) => Promise<ChatQuestion>>(api.question);

export function Question({ initial }: { initial: ChatQuestion }) {
  const [question, setQuestion] = useState(initial);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string>();
  const thread = useAui().thread();
  const running = useAuiState(s => s.thread.isRunning);
  const getId = useContext(ThreadIdContext);
  const loadQuestion = useContext(QuestionLoaderContext);
  useEffect(() => {
    if (question.state !== "open") return;
    const id = getId();
    if (!id) return;
    const load = () => loadQuestion(id, initial.id).then(setQuestion).catch(() => {});
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [initial.id, question.state]);
  const send = async (cancel = false) => {
    setError(undefined);
    try {
      thread.append({ role: "user", content: [{ type: "text", text: `@osiris-answer:${JSON.stringify({ id: question.id, values, cancel })}` }] });
    } catch (e) { setError(e instanceof Error ? e.message : "Odpověď se nepodařila"); }
  };
  if (question.state !== "open") return <p className="my-3 text-sm text-fg-secondary">{question.title} · {question.state === "answered" ? "Zodpovězeno" : question.state === "cancelled" ? "Zrušeno" : "Vypršelo"}</p>;
  return <form onSubmit={e => { e.preventDefault(); void send(); }} className="my-3 space-y-3 rounded border border-line bg-sidebar p-4">
    <h3 className="font-medium">{question.title}</h3>
    {question.fields.map(f => <label key={f.name} className="block space-y-1 text-sm">
      <span>{f.label}{f.required ? " *" : ""}</span>
      {f.type === "select" || f.type === "boolean" ? <select className="field" required={f.required} value={values[f.name] === undefined ? "" : String(values[f.name])} onChange={e => setValues({ ...values, [f.name]: e.target.value === "" ? undefined : f.type === "boolean" ? e.target.value === "true" : e.target.value })}>
        <option value="">Vyber…</option>
        {(f.type === "boolean" ? [{ value: "true", label: "Ano" }, { value: "false", label: "Ne" }] : f.options ?? []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select> : f.type === "multiselect" ? <select className="field" multiple required={f.required} value={(values[f.name] as string[] | undefined) ?? []} onChange={e => setValues({ ...values, [f.name]: Array.from(e.target.selectedOptions, o => o.value) })}>{f.options?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
        : <input className="field" type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"} step={f.type === "number" ? "any" : undefined} required={f.required} maxLength={4000} value={String(values[f.name] ?? "")} onChange={e => setValues({ ...values, [f.name]: f.type === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value })} />}
    </label>)}
    {error && <p className="text-sm text-error">{error}</p>}
    <div className="flex gap-3"><button className="btn-primary" disabled={running}>Odeslat odpověď</button><button type="button" className="btn-secondary" disabled={running} onClick={() => void send(true)}>Zrušit</button></div>
  </form>;
}
