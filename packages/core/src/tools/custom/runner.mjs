// One call of a project's own tool (`.osiris/tools/<name>.ts`), in a process of its own: Node's permission model lets it
// read only its tools folder (no project data, no keys, no child processes), its environment is empty, and the parent
// kills it when it runs too long. Secrets reach the outside world only through `ctx.fetch`, which the parent fills.
import { pathToFileURL } from "node:url";

const pending = new Map();
let seq = 0;

const send = (message) => process.send(message);

process.on("message", (m) => {
  if (m.type === "fetch-result") {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (!p) return;
    if (m.error) p.reject(new Error(m.error));
    else p.resolve({ ...m.response, ok: m.response.status >= 200 && m.response.status < 300, json: () => JSON.parse(m.response.text) });
  } else if (m.type === "call") void call(m);
});

/** `ctx.fetch(url, { method, headers, body })`: through Osiris, with `{{secret:NAME}}` filled for the secret's allowed hosts. */
function osirisFetch(url, init = {}) {
  const id = ++seq;
  const headers = init.headers instanceof Headers ? Object.fromEntries(init.headers) : { ...(init.headers ?? {}) };
  const body = init.body === undefined || init.body === null ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ type: "fetch", id, request: { method: String(init.method ?? "GET").toUpperCase(), url: String(url), headers, body } });
  });
}

async function call({ op, file, input, context }) {
  try {
    const mod = await import(pathToFileURL(file).href);
    const def = mod.default;
    if (!def || typeof def !== "object") throw new Error("the file must export default { description, input, run }");
    if (typeof def.description !== "string" || !def.description.trim()) throw new Error("description must be a non-empty string");
    if (!def.input || typeof def.input !== "object" || def.input.type !== "object") throw new Error('input must be a JSON Schema with "type": "object"');
    if (typeof def.run !== "function") throw new Error("run must be a function");
    if (op === "describe") {
      send({ type: "done", value: { description: def.description.trim(), input: JSON.parse(JSON.stringify(def.input)) } });
      return;
    }
    const value = await def.run(input, Object.freeze({ ...context, fetch: osirisFetch }));
    send({ type: "done", value: typeof value === "string" ? value : (JSON.stringify(value) ?? "null") });
  } catch (err) {
    send({ type: "done", error: err instanceof Error ? err.message : String(err) });
  }
}
