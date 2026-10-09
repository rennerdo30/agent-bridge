export const CONVERSATION_BYTES = 64 * 1024;

/** Searchable human/tool text, without another full copy of raw transcript JSON. */
export function indexedConversationText(raw: Buffer): string {
  const text = raw.toString("utf8");
  let value: unknown;
  try { value = JSON.parse(text); } catch {
    const lines = text.trim().split("\n");
    if (lines.length > 1 && lines.every(line => { try { JSON.parse(line); return true; } catch { return false; } })) return lines.map(line => indexedConversationText(Buffer.from(line))).join("\n");
    // Oversized/incomplete records remain searchable in bounded 64 KiB fragments.
    return text;
  }
  const found: string[] = [];
  const visit = (item: unknown, depth = 0): void => {
    if (depth > 8 || found.join("\n").length >= CONVERSATION_BYTES) return;
    if (Array.isArray(item)) { for (const v of item.slice(0, 100)) visit(v, depth + 1); }
    else if (item && typeof item === "object") for (const [key, v] of Object.entries(item)) {
      if (["text", "body", "content", "summary", "prompt", "title", "topic", "description", "note", "reason", "detail", "question", "answer"].includes(key) && typeof v === "string") found.push(v);
      else if (["message", "payload", "content", "parts", "output", "data"].includes(key)) visit(v, depth + 1);
    }
  };
  visit(value);
  return found.join("\n").slice(0, CONVERSATION_BYTES);
}

/** The text a transcript record stands for. conversation_records.body is stored only when it differs:
 * NULL (copied by the v2 migration) means the raw bytes as UTF-8; '' (live writer) means "derive from raw". */
export function conversationBodyText(body: unknown, raw: Buffer): string {
  if (body === null || body === undefined) return raw.toString("utf8");
  return String(body) || indexedConversationText(raw);
}
