import { DB_COLUMN_TYPES, type DbColumn, type DbColumnType, type DbQueryResult, type DbRows, type DbTable } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api, saveBlob, type DbColumnInput, type DbTableChange } from "./api.ts";
import { LazyCodeEditor } from "./LazyCodeEditor.tsx";
import { MasterDetail } from "./MasterDetail.tsx";
import { attempt, ErrorNotice, Field, Loading } from "./Scope.tsx";
import { t } from "i18next";
import { formatDateTime, formatNumber } from "./i18n.ts";

/** The key of the SQL console in the list (table names are lowercase letters, digits and _). */
const SQL = "#sql";
const PAGE = 50;

const typeLabel = (type: DbColumnType) => t(`database:types.${type}`);

/** A cell as text: booleans as a tick, JSON compact, dates as they are. */
const cell = (v: unknown) => (v === null || v === undefined ? "" : v === true ? "✓" : v === false ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));

/**
 * Rows as CSV for Excel: a BOM, quotes where needed, and the separator Excel expects in the reader's locale (a
 * semicolon where the decimal mark is a comma).
 */
function toCsv(columns: string[], rows: unknown[][]) {
  const separator = formatNumber(1.5).includes(",") ? ";" : ",";
  const quote = (v: unknown) => {
    const s = cell(v);
    return /[;,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + [columns, ...rows].map((r) => r.map(quote).join(separator)).join("\r\n");
}
const downloadCsv = (name: string, r: DbQueryResult) => saveBlob(new Blob([toCsv(r.columns, r.rows)], { type: "text/csv" }), `${name}.csv`);

/** Project > Databáze: the tables the assistant keeps (contacts, deals…), their rows, and read-only SQL. */
export function Database({ isAdmin }: { isAdmin: boolean }) {
  const [tables, setTables] = useState<DbTable[]>();
  const [selected, setSelected] = useState<string | null>();
  const [error, setError] = useState<string>();
  const load = () => api.db.tables().then(setTables, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);
  const table = tables?.find((t) => t.name === selected);

  return (
    <MasterDetail
      title={t("app:nav.database")}
      loading={!tables && !error}
      top={
        <button onClick={() => setSelected(SQL)} data-active={selected === SQL} className="list-row mt-1 w-full px-2 py-1.5 text-start">
          {t("database:sql")}
        </button>
      }
      groups={[
        {
          title: t("database:tables"),
          items: (tables ?? []).map((t) => ({ key: t.name, label: t.name, hint: t.description || undefined, badge: <span className="text-xs text-fg-muted">{t.rows}</span> })),
          empty: t("database:empty"),
        },
      ]}
      selected={selected}
      onSelect={setSelected}
      add={isAdmin ? { label: t("database:newTable"), onClick: () => setSelected(null) } : undefined}
      placeholder={t("database:placeholder")}
    >
      {error ? (
        <div className="detail">
          <ErrorNotice error={error} />
        </div>
      ) : selected === SQL ? (
        <SqlConsole />
      ) : selected === null ? (
        <div className="detail max-w-4xl">
          <h1 className="text-lg font-semibold">{t("database:newTable")}</h1>
          <StructureForm tables={tables ?? []} onSaved={(t) => void load().then(() => setSelected(t.name))} />
        </div>
      ) : table ? (
        <TableView
          key={table.name}
          table={table}
          tables={tables ?? []}
          isAdmin={isAdmin}
          onChanged={(name) => void load().then(() => name !== undefined && setSelected(name))}
        />
      ) : undefined}
    </MasterDetail>
  );
}

/** A table's rows: search, sort by a column, pages; a row opens in a form. Admins also change its structure. */
function TableView({ table, tables, isAdmin, onChanged }: { table: DbTable; tables: DbTable[]; isAdmin: boolean; onChanged: (name?: string) => void }) {
  const [page, setPage] = useState<DbRows>();
  const [offset, setOffset] = useState(0);
  const [order, setOrder] = useState({ column: "id", desc: true });
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  // A row's id, "new" for a new one, null for none.
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [structure, setStructure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const load = () =>
    api.db.rows(table.name, { limit: PAGE, offset, order: order.column, desc: order.desc, search: term }).then(setPage, (e: Error) => setError(e.message));
  useEffect(() => void load(), [offset, order, term, table.rows]);

  const sortBy = (column: string) => (setOffset(0), setOrder((o) => ({ column, desc: o.column === column ? !o.desc : false })));
  const exportCsv = () => attempt(setBusy, setError, async () => downloadCsv(table.name, await api.db.query(`SELECT * FROM "${table.name}"`)));
  const drop = () =>
    window.confirm(t("database:confirmDrop", { name: table.name, count: table.rows })) &&
    void attempt(setBusy, setError, async () => (await api.db.dropTable(table.name), onChanged(undefined)));
  const saved = () => (setEditing(null), onChanged(), void load());
  const row = typeof editing === "number" ? page?.rows.find((r) => r.id === editing) : undefined;
  const columns = table.columns;

  return (
    <div className="detail relative space-y-4">
      <Loading show={!page && !error} />
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold">{table.name}</h1>
          {table.description && <p className="text-sm text-fg-secondary">{table.description}</p>}
        </div>
        <button disabled={busy} onClick={() => void exportCsv()} className="btn-secondary text-sm">
          {t("database:exportCsv")}
        </button>
        {isAdmin && (
          <>
            <button onClick={() => (setEditing(null), setStructure((s) => !s))} data-active={structure} className="btn-secondary text-sm">
              {t("database:structure")}
            </button>
            <button disabled={busy} onClick={drop} className="btn-danger text-sm">
              {t("database:dropTable")}
            </button>
          </>
        )}
      </div>
      <ErrorNotice error={error} />

      {structure && (
        <section className="rounded-md border border-line p-4">
          <StructureForm table={table} tables={tables} onSaved={(t) => (setStructure(false), onChanged(t.name))} />
        </section>
      )}
      {editing !== null && (editing === "new" || row) && (
        <section className="rounded-md border border-line p-4">
          <RowForm key={editing} table={table} row={row} onSaved={saved} onCancel={() => setEditing(null)} />
        </section>
      )}

      <form onSubmit={(e) => (e.preventDefault(), setOffset(0), setTerm(search))} className="flex gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("database:searchPlaceholder")} className="field w-64" />
        <button className="btn-secondary text-sm">{t("files:search")}</button>
      </form>

      {page && (
        <>
          <div className="overflow-x-auto rounded-md border border-line">
            <table className="w-full text-start text-sm">
              <thead className="bg-sidebar text-xs text-fg-secondary">
                <tr>
                  {columns.map((c) => (
                    <th key={c.name} className="whitespace-nowrap px-3 py-2 font-medium">
                      <button onClick={() => sortBy(c.name)} title={typeLabel(c.type)} className={c.system && c.name !== "id" ? "text-fg-muted" : ""}>
                        {c.name}
                        {order.column === c.name ? (order.desc ? " ↓" : " ↑") : ""}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page.rows.map((r) => (
                  <tr
                    key={String(r.id)}
                    onClick={() => (setStructure(false), setEditing(r.id as number))}
                    data-active={editing === r.id}
                    className="list-row cursor-pointer border-t border-line"
                  >
                    {columns.map((c) => (
                      <td key={c.name} className={`max-w-xs truncate px-3 py-1.5 ${c.system && c.name !== "id" ? "text-fg-muted" : ""}`} title={cell(r[c.name])}>
                        {c.type === "datetime" && r[c.name] ? formatDateTime(String(r[c.name])) : cell(r[c.name])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {!page.rows.length && <p className="px-3 py-4 text-sm text-fg-muted">{term ? t("nothingFound") : t("database:emptyTable")}</p>}
          </div>
          {page.total > PAGE && (
            <div className="flex items-center gap-3 text-sm">
              <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} className="btn-secondary text-sm" aria-label={t("database:previous")}>
                ←
              </button>
              <span className="text-fg-secondary">
                {t("database:range", { from: formatNumber(offset + 1), to: formatNumber(Math.min(offset + PAGE, page.total)), total: formatNumber(page.total) })}
              </span>
              <button disabled={offset + PAGE >= page.total} onClick={() => setOffset(offset + PAGE)} className="btn-secondary text-sm" aria-label={t("database:next")}>
                →
              </button>
            </div>
          )}
        </>
      )}
      <button onClick={() => (setStructure(false), setEditing("new"))} className="btn-primary text-sm">
        + {t("database:row")}
      </button>
    </div>
  );
}

/** A form value of a column as the input holds it. */
const toInput = (c: DbColumn, v: unknown): string | boolean => {
  if (c.type === "boolean") return v === true;
  if (v === null || v === undefined) return "";
  if (c.type === "json") return JSON.stringify(v, null, 2);
  if (c.type === "datetime") return String(v).slice(0, 16);
  return String(v);
};

/** An input's value as the API takes it; JSON that doesn't parse is refused by name. */
function fromInput(c: DbColumn, v: string | boolean): unknown {
  if (c.type === "boolean") return v === true;
  const s = String(v).trim();
  if (s === "") return null;
  if (c.type === "integer" || c.type === "real") return Number(s.replace(",", "."));
  if (c.type === "json") {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      throw new Error(t("database:invalidJson", { column: c.name }));
    }
  }
  return s;
}

function RowForm({ table, row, onSaved, onCancel }: { table: DbTable; row?: Record<string, unknown>; onSaved: () => void; onCancel: () => void }) {
  const columns = table.columns.filter((c) => !c.system);
  const [values, setValues] = useState(() => Object.fromEntries(columns.map((c) => [c.name, toInput(c, row?.[c.name])])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const id = row?.id as number | undefined;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void attempt(setBusy, setError, async () => {
      const out = Object.fromEntries(columns.map((c) => [c.name, fromInput(c, values[c.name]!)]));
      if (id === undefined) await api.db.insert(table.name, [out]);
      else await api.db.update(table.name, id, out);
      onSaved();
    });
  };
  const remove = () => id !== undefined && window.confirm(t("database:confirmDeleteRow", { id })) && void attempt(setBusy, setError, async () => (await api.db.delete(table.name, id), onSaved()));
  const input = (c: DbColumn) => {
    const v = values[c.name]!;
    const set = (x: string | boolean) => setValues({ ...values, [c.name]: x });
    if (c.type === "boolean") return <input type="checkbox" checked={v === true} onChange={(e) => set(e.target.checked)} />;
    if (c.type === "json") return <textarea value={String(v)} onChange={(e) => set(e.target.value)} rows={3} className="field w-full font-mono text-xs" />;
    const type = { integer: "number", real: "number", date: "date", datetime: "datetime-local", text: "text" }[c.type];
    return <input type={type} step={c.type === "real" ? "any" : undefined} required={c.required} value={String(v)} onChange={(e) => set(e.target.value)} className="field w-full" />;
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <h2 className="font-medium">{id === undefined ? t("database:newRow") : t("database:rowTitle", { id })}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {columns.map((c) => (
          <Field key={c.name} label={`${c.name}${c.required ? " *" : ""}${c.references ? ` → ${c.references}` : ""}`}>
            {input(c)}
          </Field>
        ))}
      </div>
      <ErrorNotice error={error} />
      <div className="flex gap-3">
        <button disabled={busy} className="btn-primary">
          {t("save")}
        </button>
        <button type="button" onClick={onCancel} className="btn-secondary">
          {t("cancel")}
        </button>
        {id !== undefined && (
          <button type="button" disabled={busy} onClick={remove} className="btn-danger ms-auto">
            {t("database:deleteRow")}
          </button>
        )}
      </div>
    </form>
  );
}

type NewColumn = Required<DbColumnInput> & { key: number };
const newColumn = (key: number): NewColumn => ({ key, name: "", type: "text", required: false, unique: false, references: null });

/**
 * A new table's columns, or an existing one's changes: rename it and its columns, drop columns, add new ones (which
 * can't be required: the rows there have none).
 */
function StructureForm({ table, tables, onSaved }: { table?: DbTable; tables: DbTable[]; onSaved: (t: DbTable) => void }) {
  const [name, setName] = useState(table?.name ?? "");
  const [description, setDescription] = useState(table?.description ?? "");
  const existing = table?.columns.filter((c) => !c.system) ?? [];
  const [renames, setRenames] = useState<Record<string, string>>(() => Object.fromEntries(existing.map((c) => [c.name, c.name])));
  const [drops, setDrops] = useState<string[]>([]);
  const [added, setAdded] = useState<NewColumn[]>(() => (table ? [] : [newColumn(0)]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const change = (key: number, c: Partial<NewColumn>) => setAdded(added.map((x) => (x.key === key ? { ...x, ...c, ...(c.references ? { type: "integer" as const } : {}) } : x)));
  const columns = () => added.filter((c) => c.name.trim()).map(({ key: _, ...c }) => ({ ...c, name: c.name.trim() }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (drops.length && !window.confirm(t("database:confirmDropColumns", { columns: drops.join(", ") }))) return;
    void attempt(setBusy, setError, async () => {
      if (!table) return onSaved(await api.db.createTable({ name: name.trim(), description, columns: columns() }));
      const c: DbTableChange = {
        description,
        rename: name.trim() !== table.name ? name.trim() : undefined,
        dropColumns: drops.length ? drops : undefined,
        renameColumns: Object.entries(renames)
          .filter(([from, to]) => from !== to.trim() && !drops.includes(from))
          .map(([from, to]) => ({ from, to: to.trim() })),
        addColumns: columns().map((x) => ({ ...x, required: false })),
      };
      onSaved(await api.db.alterTable(table.name, c));
    });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("name")}>
          <input value={name} onChange={(e) => setName(e.target.value)} required pattern="[a-z][a-z0-9_]*" placeholder="contacts" className="field w-full" />
        </Field>
        <Field label={t("guards:description")}>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("database:descriptionPlaceholder")} className="field w-full" />
        </Field>
      </div>
      <p className="text-xs text-fg-muted">{t("database:namingHint")}</p>

      {existing.length > 0 && (
        <div className="space-y-2">
          <h3 className="section-header">{t("database:columns")}</h3>
          {existing.map((c) => (
            <div key={c.name} className="flex flex-wrap items-center gap-3 text-sm">
              <input
                value={renames[c.name]}
                disabled={drops.includes(c.name)}
                onChange={(e) => setRenames({ ...renames, [c.name]: e.target.value })}
                className="field w-48"
              />
              <span className="w-28 text-fg-secondary">{typeLabel(c.type)}</span>
              <span className="text-xs text-fg-muted">
                {[c.required && t("database:required"), c.unique && t("database:unique"), c.references && `→ ${c.references}`].filter(Boolean).join(", ")}
              </span>
              <label className="ms-auto flex items-center gap-1 text-error">
                <input type="checkbox" checked={drops.includes(c.name)} onChange={(e) => setDrops(e.target.checked ? [...drops, c.name] : drops.filter((d) => d !== c.name))} />
                {t("database:dropColumn")}
              </label>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <h3 className="section-header">{table ? t("database:newColumns") : t("database:columns")}</h3>
        {added.map((c) => (
          <div key={c.key} className="flex flex-wrap items-center gap-3 text-sm">
            <input value={c.name} onChange={(e) => change(c.key, { name: e.target.value })} placeholder={t("database:columnPlaceholder")} pattern="[a-z][a-z0-9_]*" className="field w-48" />
            <select value={c.type} disabled={!!c.references} onChange={(e) => change(c.key, { type: e.target.value as DbColumnType })} className="field w-32">
              {DB_COLUMN_TYPES.map((type) => (
                <option key={type} value={type}>
                  {typeLabel(type)}
                </option>
              ))}
            </select>
            {!table && (
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={c.required} onChange={(e) => change(c.key, { required: e.target.checked })} /> {t("database:required")}
              </label>
            )}
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={c.unique} onChange={(e) => change(c.key, { unique: e.target.checked })} /> {t("database:unique")}
            </label>
            <select value={c.references ?? ""} onChange={(e) => change(c.key, { references: e.target.value || null })} className="field w-40">
              <option value="">{t("database:noReference")}</option>
              {tables.map((other) => (
                <option key={other.name} value={other.name}>
                  → {other.name}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => setAdded(added.filter((x) => x.key !== c.key))} className="btn-link text-fg-muted" aria-label={t("remove")}>
              ×
            </button>
          </div>
        ))}
        <button type="button" onClick={() => setAdded([...added, newColumn(Math.max(0, ...added.map((x) => x.key)) + 1)])} className="btn-link text-sm">
          + {t("database:column")}
        </button>
      </div>

      <ErrorNotice error={error} />
      <button disabled={busy} className="btn-primary">
        {table ? t("database:saveStructure") : t("database:createTable")}
      </button>
    </form>
  );
}

/** Read-only SQL over the project's tables (one SELECT, at most 1000 rows), with the answer as a table or CSV. */
function SqlConsole() {
  const [sql, setSql] = useState("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\';");
  const [result, setResult] = useState<DbQueryResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = () => attempt(setBusy, setError, async () => setResult(await api.db.query(sql)));
  return (
    <div className="detail space-y-3">
      <h1 className="text-lg font-semibold">{t("database:sql")}</h1>
      <p className="text-sm text-fg-secondary">{t("database:sqlIntro")}</p>
      <div onKeyDown={(e) => (e.ctrlKey || e.metaKey) && e.key === "Enter" && (e.preventDefault(), void run())}>
        <LazyCodeEditor path="dotaz.sql" value={sql} onChange={setSql} height="30vh" />
      </div>
      <div className="flex items-center gap-3">
        <button disabled={busy || !sql.trim()} onClick={() => void run()} className="btn-primary">
          {t("database:run")}
        </button>
        <span className="text-xs text-fg-muted">Ctrl+Enter</span>
        {result && (
          <button onClick={() => downloadCsv(t("database:queryFile"), result)} className="btn-secondary ms-auto text-sm">
            {t("database:exportCsv")}
          </button>
        )}
      </div>
      <ErrorNotice error={error} />
      {result && (
        <>
          <div className="overflow-x-auto rounded-md border border-line">
            <table className="w-full text-start text-sm">
              <thead className="bg-sidebar text-xs text-fg-secondary">
                <tr>
                  {result.columns.map((c, i) => (
                    <th key={i} className="whitespace-nowrap px-3 py-2 font-medium">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r, i) => (
                  <tr key={i} className="border-t border-line">
                    {r.map((v, j) => (
                      <td key={j} className="max-w-xs truncate px-3 py-1.5" title={cell(v)}>
                        {cell(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {!result.rows.length && <p className="px-3 py-4 text-sm text-fg-muted">{t("database:noRows")}</p>}
          </div>
          <p className="text-xs text-fg-muted">
            {t("database:rowCount", { count: result.rows.length })}
            {result.truncated && ` ${t("database:truncated")}`}
          </p>
        </>
      )}
    </div>
  );
}
