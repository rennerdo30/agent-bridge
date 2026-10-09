import { exportDecompressed, inspectCatalog, inspectQuery, INSPECT_DATABASES } from "../core/db-inspect.js";

const USAGE = `Usage:
  agent-bridge db tables [--json]
  agent-bridge db query "<sql>" [--db bridge|history|archive] [--json]
  agent-bridge db export --decompressed <table|view> <new-file.sqlite> [--db bridge|history|archive]
Read-only. SQL can call ab_text(value, codec) and ab_raw(value, codec) to decode compressed history,
and the views v_conversation_records and v_history_documents already do.`;

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  args.splice(at, 2);
  return value;
}

function table(columns: string[], rows: Record<string, unknown>[]): string {
  const cell = (v: unknown) => { const s = v === null || v === undefined ? "NULL" : typeof v === "string" ? v : JSON.stringify(v); return s.replace(/\s+/g, " ").slice(0, 120); };
  const widths = columns.map(c => Math.max(c.length, ...rows.map(r => cell(r[c]).length)));
  const line = (values: string[]) => values.map((v, i) => v.padEnd(widths[i]!)).join(" | ");
  return [line(columns), widths.map(w => "-".repeat(w)).join("-+-"), ...rows.map(r => line(columns.map(c => cell(r[c]))))].join("\n");
}

export function runDb(rest: string[], home: string, out: (text: string) => void): number {
  const args = [...rest];
  const command = args.shift();
  const json = args.includes("--json");
  if (json) args.splice(args.indexOf("--json"), 1);
  const db = option(args, "--db") ?? (command === "tables" ? undefined : "history");
  if (db !== undefined && !Object.hasOwn(INSPECT_DATABASES, db)) { out(USAGE); return 2; }
  try {
    if (command === "tables" && !args.length) {
      const catalog = inspectCatalog(home);
      if (json) { out(JSON.stringify(catalog, null, 2)); return 0; }
      for (const entry of catalog.dbs) {
        out(`${entry.db} (${(entry.bytes / 1024 ** 2).toFixed(1)} MiB)`);
        for (const t of entry.tables) out(`  ${t.kind === "view" ? "view " : "table"} ${t.name}${t.rows !== undefined ? `  ~${t.rows.toLocaleString("en")} rows` : ""}`);
      }
      return 0;
    }
    if (command === "query" && args.length === 1) {
      const result = inspectQuery(home, db!, args[0]!);
      out(json ? JSON.stringify(result.rows, null, 2) : table(result.columns, result.rows));
      return 0;
    }
    if (command === "export" && args[0] === "--decompressed" && args.length === 3) {
      const rows = exportDecompressed(home, db!, args[1]!, args[2]!);
      out(`Exported ${rows.toLocaleString("en")} rows of ${args[1]} with decoded text to ${args[2]}.`);
      return 0;
    }
  } catch (err) { out(String((err as Error).message)); return 1; }
  out(USAGE);
  return 2;
}
