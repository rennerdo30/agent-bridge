const REMOVAL_FUNCTIONS = new Set(["rm", "rmSync", "unlink", "unlinkSync", "rmdir", "rmdirSync", "truncate", "truncateSync"]);
export interface Removal { kind: "file" | "sql"; expression: string }
export const normalizeSource = (text: string) => text.replace(/\s+/g, " ").trim();

/** Grep-style guard resolves fs import aliases and namespaces, then balances call parentheses. */
export function removalOperations(text: string): Removal[] {
  const names = new Map<string, string>(), found: Removal[] = [];
  for (const match of text.matchAll(/import\s+([^;]+?)\s+from\s+["'](?:node:)?fs(?:\/promises)?["']/g)) {
    const clause = match[1]!;
    const namespace = /\*\s+as\s+(\w+)/.exec(clause)?.[1] ?? (/^\w+$/.test(clause.trim()) ? clause.trim() : undefined);
    if (namespace) for (const name of REMOVAL_FUNCTIONS) names.set(`${namespace}.${name}`, name);
    const bindings = /\{([^}]+)\}/.exec(clause)?.[1];
    for (const binding of bindings?.split(",") ?? []) {
      const parts = binding.trim().split(/\s+as\s+/), name = parts[0]!;
      if (REMOVAL_FUNCTIONS.has(name)) names.set(parts[1] ?? name, name);
    }
  }
  for (const [binding, name] of names) {
    const pattern = new RegExp(`(?<![\\w$.])${binding.replaceAll(".", "\\.")}\\s*\\(`, "g");
    for (const match of text.matchAll(pattern)) {
      const start = match.index! + match[0].lastIndexOf("(");
      let depth = 1, end = start + 1, quote = "";
      for (; end < text.length && depth; end++) {
        const char = text[end]!;
        if (quote) { if (char === "\\") end++; else if (char === quote) quote = ""; }
        else if (["'", '"', "`"].includes(char)) quote = char;
        else if (char === "(") depth++;
        else if (char === ")") depth--;
      }
      found.push({ kind: "file", expression: normalizeSource(`${name}${text.slice(start, end)}`) });
    }
  }
  for (const match of text.matchAll(/\b([A-Za-z_$][\w$]*\.truncate)\s*\(/g)) {
    const start = match.index!, open = start + match[0].lastIndexOf("(");
    let depth = 1, end = open + 1;
    for (; end < text.length && depth; end++) { if (text[end] === "(") depth++; else if (text[end] === ")") depth--; }
    found.push({ kind: "file", expression: normalizeSource(text.slice(start, end)) });
  }
  // Inspect whole string/template literals so a deletion after another SQL statement is still caught.
  for (let start = 0; start < text.length; start++) {
    if (text.startsWith("//", start)) { start = text.indexOf("\n", start); if (start < 0) break; continue; }
    if (text.startsWith("/*", start)) { const end = text.indexOf("*/", start + 2); if (end < 0) break; start = end + 1; continue; }
    const quote = text[start]!;
    if (!["'", '"', "`"].includes(quote)) continue;
    let end = start + 1;
    for (; end < text.length; end++) { if (text[end] === "\\") end++; else if (text[end] === quote) { end++; break; } }
    const literal = text.slice(start, end);
    if (/\b(?:DELETE\s+FROM|DROP\s+TABLE|TRUNCATE\s+TABLE)\b/i.test(literal)) found.push({ kind: "sql", expression: normalizeSource(literal) });
    start = end - 1;
  }
  return found;
}
