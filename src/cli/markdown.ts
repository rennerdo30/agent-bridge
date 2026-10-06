/**
 * Small Markdown renderer for the dashboard's message bubbles: what agents actually write (headings, bold,
 * italic, code, code blocks, lists, quotes, links, tables). Everything is HTML-escaped first and only known
 * constructs become tags, so a message cannot inject markup; links are limited to http(s) and mailto.
 *
 * Self-contained on purpose (no imports, no outer references): the page embeds its source as-is.
 */
export function renderMarkdown(src: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const safeUrl = (u: string) => (/^(https?:\/\/|mailto:)/i.test(u) ? u : null);

  const inline = (text: string): string => {
    const codes: string[] = [];
    // Code spans first: nothing inside them is formatted.
    let s = text.replace(/`([^`\n]+)`/g, (_, c: string) => `\u0000${codes.push(`<code>${esc(c)}</code>`) - 1}\u0000`);
    s = esc(s);
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label: string, url: string) => {
      const href = safeUrl(url.replace(/&amp;/g, "&"));
      return href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : m;
    });
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, (_, pre: string, url: string) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^\w*])\*([^*\s][^*\n]*?)\*(?!\w)/g, "$1<em>$2</em>").replace(/(^|[^\w])_([^_\s][^_\n]*?)_(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
    return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]!);
  };

  const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Any info string after the fence (```ts, ```verify:, ``` json title="x"), as in CommonMark; only backticks end it.
    const fence = /^\s*(```|~~~)[^`]*$/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trim().startsWith(fence[1]!); i++) body.push(lines[i]!);
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = Math.min(heading[1]!.length + 2, 6); // small headings inside a bubble
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push("<hr>");
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      flush();
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!); i++) rows.push(cells(lines[i]!));
      i--;
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("") +
          "</tbody></table>",
      );
      continue;
    }
    const list = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (list) {
      flush();
      const ordered = /\d/.test(list[2]!);
      const items: string[] = [];
      for (; i < lines.length; i++) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]!);
        if (m && /\d/.test(m[2]!) === ordered) items.push(`<li${m[1]!.length >= 2 ? ' class="sub"' : ""}>${inline(m[3]!)}</li>`);
        else if (items.length && /^\s{2,}\S/.test(lines[i]!)) items[items.length - 1] = items[items.length - 1]!.replace(/<\/li>$/, `<br>${inline(lines[i]!.trim())}</li>`);
        else break;
      }
      i--;
      out.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const quoted: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]!); i++) quoted.push(lines[i]!.replace(/^\s*>\s?/, ""));
      i--;
      out.push(`<blockquote>${quoted.map(inline).join("<br>")}</blockquote>`);
      continue;
    }
    para.push(line);
  }
  flush();
  return out.join("");
}
