export const MCP_TEXT_LIMIT = 170_000;

export function boundMcpText(value: string): string {
  if (value.length <= MCP_TEXT_LIMIT) return value;
  const note = `\n[Output shortened from ${value.length} characters to stay within the MCP frame. Narrow the query or use a smaller page.]`;
  // JSON callers must receive valid JSON, even when an individual record is huge.
  if (value.startsWith("{") || value.startsWith("[")) {
    let previewLength = MCP_TEXT_LIMIT - 256;
    let result = JSON.stringify({ truncated: true, totalCharacters: value.length, preview: value.slice(0, previewLength) });
    while (result.length > MCP_TEXT_LIMIT) {
      previewLength = Math.floor(previewLength * 0.7);
      result = JSON.stringify({ truncated: true, totalCharacters: value.length, preview: value.slice(0, previewLength) });
    }
    return result;
  }
  return value.slice(0, MCP_TEXT_LIMIT - note.length) + note;
}

export function pageMcpLines(entries: string[], options: { offset?: number; limit?: number }): { entries: string[]; text: string; nextOffset: number | null } {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? entries.length;
  const page: string[] = [];
  let size = 0;
  for (let i = offset; i < entries.length && page.length < limit; i++) {
    const line = entries[i]!;
    if (size + line.length + 1 > MCP_TEXT_LIMIT - 256) {
      if (page.length === 0) page.push(boundMcpText(line).slice(0, MCP_TEXT_LIMIT - 256));
      break;
    }
    page.push(line);
    size += line.length + 1;
  }
  const nextOffset = offset + page.length < entries.length ? offset + page.length : null;
  return { entries: page, text: page.join("\n"), nextOffset };
}

/** Select only entries that can be returned before a caller marks them consumed. */
export function takeMcpEntries<T>(entries: T[], render: (entries: T[]) => string): { entries: T[]; oversizedFirst: boolean } {
  const selected: T[] = [];
  for (const entry of entries) {
    if (render([...selected, entry]).length > MCP_TEXT_LIMIT - 1024) break;
    selected.push(entry);
  }
  return { entries: selected, oversizedFirst: entries.length > 0 && selected.length === 0 };
}
