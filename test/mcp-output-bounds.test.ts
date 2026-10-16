import { describe, expect, it } from "vitest";
import {
  boundMcpText, boundMcpTexts, fitsMcpResult, mcpContentBytes, messageBodyPage, MCP_RESULT_BUDGET_BYTES, pageListing,
  projectFilter, projectPathKey, selectForDelivery, sliceWhole, type ListingLine,
} from "../src/mcp/output-bounds.js";
import { registerTools } from "../src/mcp/server.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const extra = { signal: new AbortController().signal };
function tools(ctx: Record<string, unknown>) {
  const handlers = new Map<string, (args: any, extra: any) => Promise<any>>();
  registerTools({ registerTool: (name: string, _spec: unknown, fn: any) => handlers.set(name, fn) } as any,
    { agent: "codex", cfg: DEFAULT_CONFIG, log: nullLogger, channelActive: () => false, ...ctx } as any, []);
  return (name: string, args: Record<string, unknown> = {}) => handlers.get(name)!(args, extra) as Promise<{ content: { text: string }[]; isError?: boolean }>;
}

describe("AB-404 serialized result measurement", () => {
  it("measures the serialized UTF-8 content, not characters, and never splits a surrogate pair", () => {
    // 70,000 characters: well under a character limit, but 210,000 UTF-8 bytes once serialized.
    const euros = "\u20ac".repeat(70_000);
    expect(euros.length).toBeLessThan(MCP_RESULT_BUDGET_BYTES);
    expect(fitsMcpResult(euros)).toBe(false);
    // JSON escaping doubles quotes and backslashes.
    expect(fitsMcpResult("\"".repeat(100_000))).toBe(false);
    expect(fitsMcpResult("x".repeat(100_000))).toBe(true);
    const bounded = boundMcpText(euros, "Use a smaller page.");
    expect(mcpContentBytes([bounded])).toBeLessThanOrEqual(MCP_RESULT_BUDGET_BYTES);
    expect(bounded).toContain("Use a smaller page.");

    const emoji = "a\u{1F600}".repeat(60_000);
    const pages: string[] = [];
    for (let offset = 0; offset < emoji.length;) {
      const page = messageBodyPage(emoji, offset, (slice) => `header\n${slice}`);
      expect(mcpContentBytes([page.text])).toBeLessThanOrEqual(MCP_RESULT_BUDGET_BYTES);
      const slice = emoji.slice(page.start, page.end);
      expect(loneSurrogate.test(slice)).toBe(false);
      pages.push(slice);
      offset = page.end;
    }
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.join("")).toBe(emoji);
    // An offset inside a pair starts at the whole character.
    expect(sliceWhole("a\u{1F600}b", 2)).toBe("\u{1F600}b");
    expect(loneSurrogate.test(boundMcpText(emoji))).toBe(false);
  });

  it("keeps a JSON array's shape with a paging hint, and wraps other JSON with the hint", () => {
    const items = Array.from({ length: 3_000 }, (_, i) => ({ id: i, text: "y".repeat(100) }));
    const [json, note] = boundMcpTexts([JSON.stringify(items)], "Use limit=... .");
    const shown = JSON.parse(json!) as unknown[];
    expect(Array.isArray(shown)).toBe(true);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(items.length);
    expect(shown[0]).toEqual(items[0]);
    expect(note).toContain(`showing ${shown.length} of 3000 items`);
    expect(note).toContain("Use limit=... .");
    expect(mcpContentBytes([json!, note!])).toBeLessThanOrEqual(MCP_RESULT_BUDGET_BYTES);
    const wrapped = JSON.parse(boundMcpText(JSON.stringify({ results: items }), "Narrow the query."));
    expect(wrapped).toMatchObject({ truncated: true, hint: "Narrow the query." });
    const single = boundMcpText("line ".repeat(60_000), "Ask again with a filter.");
    expect(single).toMatch(/\[Output shortened from 300000 to \d+ characters .* Ask again with a filter\.\]$/);
  });
});

describe("AB-404 listing pages", () => {
  const listing = (count: number): ListingLine[] => [
    { info: "Version skew: info that stays on every page." },
    { header: "Peers:", category: "peers" },
    ...Array.from({ length: count }, (_, i) => ({ entry: `- peer-${String(i).padStart(5, "0")} ${"z".repeat(90)}`, category: "peers" })),
    { info: "Resume a wait with wait_for_message(resume_id=...)." },
  ];

  it("pages only entries, keeps information lines on every page and reaches every entry once", () => {
    const lines = listing(5_000), seen: string[] = [];
    let offset: number | null = 0, pages = 0;
    while (offset !== null) {
      const page = pageListing(lines, { offset, hint: "Use offset=..." });
      expect(mcpContentBytes([page.text])).toBeLessThanOrEqual(MCP_RESULT_BUDGET_BYTES);
      expect(page.text).toContain("Version skew: info that stays on every page.");
      expect(page.text).toContain("Resume a wait with wait_for_message");
      expect(page.text).toContain("Peers:");
      seen.push(...page.text.split("\n").filter((line) => line.startsWith("- peer-")));
      offset = page.nextOffset; pages++;
    }
    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual(lines.flatMap((line) => "entry" in line ? [line.entry] : []));
  });

  it("does not turn a small listing into a reduced view when limit or offset is given", () => {
    const whole = pageListing(listing(3), { hint: "h" });
    expect(whole.text).not.toContain("[Showing entries");
    const limited = pageListing(listing(3), { limit: 2, hint: "h" });
    expect(limited.text.split("\n").slice(0, 4)).toEqual(whole.text.split("\n").slice(0, 4));
    expect(limited.text).toContain("[Showing entries 1-2 of 3; next page: offset=2. h]");
    expect(pageListing(listing(3), { offset: 2, hint: "h" }).text).toContain("- peer-00002");
  });

  it("pages the delegated peers listing in a stable name order with filters", async () => {
    const siblings = Array.from({ length: 2_500 }, (_, i) => ({ name: `codex-job-${String((i * 7919) % 2500).padStart(4, "0")}`,
      title: `Fake listing ${"x".repeat(80)}`, agent: "codex", status: (i * 7919) % 100 === 0 ? "running" : "done" }));
    const call = tools({ node: undefined, home: "E:/synthetic-home", cwd: () => "E:/synthetic-home",
      parent: { name: "parent", siblings: { peers: async () => siblings, policy: async () => ({ maxHops: 4, sendTo: ["granted"] }) } } });
    const seen: string[] = [];
    for (let offset: number | null = 0; offset !== null;) {
      const text = (await call("peers", { offset })).content[0]!.text;
      expect(mcpContentBytes([text])).toBeLessThanOrEqual(MCP_RESULT_BUDGET_BYTES);
      // The delegated instructions and grants stay on every page.
      expect(text).toContain('Use send(to="parent", message=...) to message your parent.');
      expect(text).toContain("Explicit send_to grants: granted.");
      seen.push(...[...text.matchAll(/^- (codex-job-\d{4})/gm)].map((m) => m[1]!));
      const next = /next page: offset=(\d+)/.exec(text);
      offset = next ? Number(next[1]) : null;
    }
    expect(seen).toEqual([...siblings.map((s) => s.name)].sort());
    const running = (await call("peers", { status: "running", limit: 2, offset: 1 })).content[0]!.text;
    expect([...running.matchAll(/^- (codex-job-\d{4})/gm)].map((m) => m[1])).toEqual(["codex-job-0100", "codex-job-0200"]);
    expect(running).toContain("[Showing entries 2-3 of 25; next page: offset=3.");
  });

  it("selects deliverable messages in linear time without re-rendering every prefix", () => {
    const messages = Array.from({ length: 200 }, (_, i) => `message ${i} ${"m".repeat(2_000)}`);
    let renders = 0;
    const render = (shown: string[], oversized: string[], deferred: string[]) => { renders++; return [...shown, `${oversized.length}/${deferred.length}`].join("\n"); };
    const selection = selectForDelivery(messages, render, (m) => m);
    expect(selection.shown.length).toBeGreaterThan(10);
    expect(selection.shown.length + selection.deferred.length).toBe(200);
    expect(renders).toBeLessThan(10);
    expect(mcpContentBytes([render(selection.shown, selection.oversized, selection.deferred)])).toBeLessThanOrEqual(MCP_RESULT_BUDGET_BYTES);
  });

  it("decides oversized without a one-time prefix: a message only the prefix crowds out is deferred", () => {
    const prefix = "p".repeat(150_000), normal = `normal ${"n".repeat(40_000)}`, huge = `huge ${"h".repeat(200_000)}`;
    const render = (withPrefix: boolean) => (shown: string[], oversized: string[], deferred: string[]) =>
      [withPrefix ? prefix : "", ...shown, `${oversized.length}/${deferred.length}`].filter(Boolean).join("\n");
    const crowded = selectForDelivery([normal, huge], render(true), (m) => m, MCP_RESULT_BUDGET_BYTES, render(false));
    expect(crowded).toEqual({ shown: [], oversized: [huge], deferred: [normal] });
    // Without the standalone rendering the prefix would make the normal message oversized for good.
    expect(selectForDelivery([normal], render(true), (m) => m).oversized).toEqual([normal]);
    // The next call, without the prefix, shows it.
    expect(selectForDelivery([normal], render(false), (m) => m).shown).toEqual([normal]);
  });
});

describe("AB-404 project filter", () => {
  it("treats E:/D: drive aliases, separators, case and trailing slashes as one physical path", () => {
    const missing = () => { throw new Error("ENOENT"); };
    const key = (path: string) => projectPathKey(path, missing, [{ alias: "E:\\", real: "D:\\" }], "win32");
    expect(key("E:\\Development\\Game\\")).toBe(key("d:/development/game"));
    const inProject = projectFilter("E:\\Development\\Game", key)!;
    expect(inProject(["D:\\Development\\Game\\src"])).toBe(true);
    expect(inProject(["d:/development/game"])).toBe(true);
    expect(inProject(["D:\\Development\\Game2"])).toBe(false);
    expect(inProject([undefined, null, "C:\\Other"])).toBe(false);
    expect(projectFilter("game", key)!(["E:\\Development\\Game"])).toBe(true);
    expect(projectFilter(undefined, key)).toBeNull();
  });

  it("resolves an existing folder through its physical path", () => {
    const dir = mkdtempSync(join(tmpdir(), "ab-404-filter-"));
    try {
      const respelled = process.platform === "win32" ? `${dir.toUpperCase().replace(/\\/g, "/")}/` : `${dir}/`;
      expect(projectFilter(respelled)!([join(dir, "nested")])).toBe(true);
      expect(projectFilter(join(dir, "nested"))!([dir])).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
