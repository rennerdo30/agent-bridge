/** A stable, short chat title from the first nonempty prompt line. */
export function deriveJobTitle(prompt: string, maxChars = 80): string {
  const line = prompt.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
  const title = line.replace(/^(?:#{1,6}\s+|[-*]\s+)/, "").split(/\s+/).slice(0, 7).join(" ");
  return title.slice(0, maxChars).trim() || "Background task";
}
