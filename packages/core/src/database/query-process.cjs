// One read-only query against the tenant's database, in its own process: the parent kills it when it runs too long
// (SQLite's native loop can't be interrupted from JavaScript, not even in a worker thread).
const { createClient } = require(process.env.OSIRIS_LIBSQL);

process.once("message", async ({ url, sql }) => {
  try {
    const db = createClient({ url });
    await db.execute("PRAGMA query_only = ON");
    const r = await db.execute(sql);
    const cell = (v) => (typeof v === "bigint" ? Number(v) : v instanceof ArrayBuffer ? `<binární data, ${v.byteLength} B>` : v);
    process.send({ columns: r.columns, rows: r.rows.map((row) => r.columns.map((_, i) => cell(row[i]))) });
  } catch (err) {
    process.send({ error: err instanceof Error ? err.message : String(err) });
  }
});
