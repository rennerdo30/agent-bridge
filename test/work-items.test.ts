import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_EVENT_TEXT_CHARS,
  formatEvent,
  notifyWorkItem,
  parseTrackersConfig,
  parseWorkItem,
  type TrackerAdapter,
  type WorkItemEvent,
  type WorkItemRef,
} from "../src/core/work-items.js";
import { PAIR_DESK_TIMEOUT_MS, PairDeskAdapter } from "../src/core/trackers/pair-desk.js";
import { buildTrackerAdapters, loadConfig } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";

function testLogger() {
  return {
    ...nullLogger,
    warn: vi.fn(( _msg: string, _data?: Record<string, unknown>) => {}),
    debug: vi.fn(( _msg: string, _data?: Record<string, unknown>) => {}),
  };
}

describe("parseWorkItem", () => {
  it("parses valid references", () => {
    expect(parseWorkItem("pair-desk:AB-281")).toEqual({ tracker: "pair-desk", id: "AB-281" });
    expect(parseWorkItem("a:b")).toEqual({ tracker: "a", id: "b" });
    expect(parseWorkItem("my-tracker-1:x")).toEqual({ tracker: "my-tracker-1", id: "x" });
  });
  it("splits only on the first colon", () => {
    expect(parseWorkItem("github:owner/repo#12")).toEqual({ tracker: "github", id: "owner/repo#12" });
    expect(parseWorkItem("a:b:c")).toEqual({ tracker: "a", id: "b:c" });
  });
  it("rejects each invalid shape", () => {
    const longId = "a:" + "x".repeat(201);
    const longTracker = `${"a".repeat(33)}:x`;
    for (const bad of [
      "",
      "no-colon-here",
      ":missing-tracker",
      "pair-desk:",
      "Pair-desk:AB-1",
      "1abc:x",
      "-abc:x",
      "a:b c",
      "a:b\tc",
      "a:b\nc",
      "a:b\rc",
      "a:b\x00c",
      "a:b\x7fc",
      longId,
      longTracker,
    ]) {
      expect(() => parseWorkItem(bad), JSON.stringify(bad)).toThrowError();
    }
  });
});

describe("formatEvent", () => {
  it("formats a started event with a bold first line and one bullet per field", () => {
    expect(formatEvent({ kind: "started", job: "codex-job-x", agent: "codex" })).toBe(
      "**agent-bridge: job codex-job-x started**\n- agent: codex",
    );
    expect(formatEvent({ kind: "started", job: "j", agent: "a", title: "Do things" })).toBe(
      "**agent-bridge: job j started**\n- agent: a\n- title: Do things",
    );
  });
  it("formats a finished event with only the present fields", () => {
    expect(
      formatEvent({ kind: "finished", job: "j", agent: "a", branch: "feat/x", head: "abc123", summary: "done" }),
    ).toBe(
      "**agent-bridge: job j finished**\n- agent: a\n- branch: feat/x\n- head: abc123\n- summary: done",
    );
    expect(formatEvent({ kind: "finished", job: "j", agent: "a" })).toBe(
      "**agent-bridge: job j finished**\n- agent: a",
    );
  });
  it("formats a failed event", () => {
    expect(formatEvent({ kind: "failed", job: "j", agent: "a", reason: "boom" })).toBe(
      "**agent-bridge: job j failed**\n- agent: a\n- reason: boom",
    );
    expect(formatEvent({ kind: "failed", job: "j", agent: "a" })).toBe(
      "**agent-bridge: job j failed**\n- agent: a",
    );
  });
  it("truncates long summary and reason text", () => {
    expect(MAX_EVENT_TEXT_CHARS).toBe(2000);
    const long = "x".repeat(2500);
    const finished = formatEvent({ kind: "finished", job: "j", agent: "a", summary: long });
    expect(finished.split("- summary: ")[1]).toHaveLength(MAX_EVENT_TEXT_CHARS);
    const failed = formatEvent({ kind: "failed", job: "j", agent: "a", reason: long });
    expect(failed.split("- reason: ")[1]).toHaveLength(MAX_EVENT_TEXT_CHARS);
    const short = formatEvent({ kind: "finished", job: "j", agent: "a", summary: "ok" });
    expect(short).toContain("- summary: ok");
  });
});

describe("notifyWorkItem", () => {
  const ref: WorkItemRef = { tracker: "pair-desk", id: "AB-1" };
  const event: WorkItemEvent = { kind: "started", job: "job-1", agent: "codex" };

  it("warns and does not throw for an unknown tracker", async () => {
    const log = testLogger();
    await expect(notifyWorkItem(new Map(), ref, event, log)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.debug).not.toHaveBeenCalled();
  });
  it("warns with the error message and does not throw when the adapter fails", async () => {
    const log = testLogger();
    const failing: TrackerAdapter = { type: "pair-desk", post: async () => { throw new Error("cli exploded"); } };
    await expect(notifyWorkItem(new Map([["pair-desk", failing]]), ref, event, log)).resolves.toBeUndefined();
    expect(log.debug).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0]?.[0] ?? "")).toBeTruthy();
    expect(JSON.stringify(log.warn.mock.calls[0])).toContain("cli exploded");
  });
  it("calls the matching adapter once with the ref and event", async () => {
    const log = testLogger();
    const post = vi.fn(async (_r: WorkItemRef, _e: WorkItemEvent) => {});
    await notifyWorkItem(new Map([["pair-desk", { type: "pair-desk", post }]]), ref, event, log);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(ref, event);
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("parseTrackersConfig", () => {
  it("returns empty for absent config", () => {
    expect(parseTrackersConfig(undefined)).toEqual({});
    expect(parseTrackersConfig(null)).toEqual({});
  });
  it("accepts a valid pair-desk entry with timeout and args prefix", () => {
    const log = testLogger();
    expect(
      parseTrackersConfig(
        { docs: { type: "pair-desk", command: "pair-desk.exe", timeoutMs: 5000, argsPrefix: ["-m", "pair_desk"] } },
        log,
      ),
    ).toEqual({ docs: { type: "pair-desk", command: "pair-desk.exe", timeoutMs: 5000, argsPrefix: ["-m", "pair_desk"] } });
    expect(log.warn).not.toHaveBeenCalled();
  });
  it("skips invalid keys, types, commands, timeouts and prefixes with a warning", () => {
    const log = testLogger();
    const parsed = parseTrackersConfig(
      {
        ok: { type: "pair-desk", command: "pair-desk.exe" },
        Bad: { type: "pair-desk", command: "x" },
        "1x": { type: "pair-desk", command: "x" },
        "": { type: "pair-desk", command: "x" },
        github: { type: "github", command: "gh" },
        nocmd: { type: "pair-desk", command: "" },
        blank: { type: "pair-desk", command: "   " },
        fast: { type: "pair-desk", command: "x", timeoutMs: 500 },
        slow: { type: "pair-desk", command: "x", timeoutMs: 200000 },
        frac: { type: "pair-desk", command: "x", timeoutMs: 1500.5 },
        str: { type: "pair-desk", command: "x", timeoutMs: "5000" },
        badprefix: { type: "pair-desk", command: "x", argsPrefix: [""] },
        manyprefix: { type: "pair-desk", command: "x", argsPrefix: Array(11).fill("a") },
        notobj: "pair-desk:AB-1",
      },
      log,
    );
    expect(parsed).toEqual({ ok: { type: "pair-desk", command: "pair-desk.exe" } });
    expect(log.warn.mock.calls.length).toBeGreaterThanOrEqual(13);
  });
  it("rejects a non-object root without throwing", () => {
    const log = testLogger();
    expect(parseTrackersConfig("pair-desk", log)).toEqual({});
    expect(parseTrackersConfig([], log)).toEqual({});
    expect(log.warn).toHaveBeenCalled();
  });
});

describe("tracker config wiring", () => {
  function homeWith(config: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "ab-trackers-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify(config));
    return dir;
  }
  it("loads home-level trackers and builds adapters for them", () => {
    const home = homeWith({ trackers: { docs: { type: "pair-desk", command: "pair-desk.exe", timeoutMs: 5000 } } });
    try {
      const cfg = loadConfig(home, "codex", nullLogger, {});
      expect(cfg.trackers).toEqual({ docs: { type: "pair-desk", command: "pair-desk.exe", timeoutMs: 5000 } });
      const adapters = buildTrackerAdapters(cfg);
      expect(adapters.get("docs")?.type).toBe("pair-desk");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  it("leaves trackers absent when unconfigured and builds no adapters", () => {
    const home = homeWith({});
    try {
      const cfg = loadConfig(home, "codex", nullLogger, {});
      expect(cfg.trackers).toBeUndefined();
      expect(buildTrackerAdapters(cfg).size).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  it("ignores project-level trackers (user-level only)", () => {
    const home = homeWith({});
    const project = mkdtempSync(join(tmpdir(), "ab-trackers-proj-"));
    try {
      mkdirSync(join(project, ".agent-bridge"), { recursive: true });
      writeFileSync(
        join(project, ".agent-bridge", "config.json"),
        JSON.stringify({ trackers: { evil: { type: "pair-desk", command: "evil.exe" } } }),
      );
      const cfg = loadConfig(home, "codex", nullLogger, {}, project);
      expect(cfg.trackers).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("PairDeskAdapter", () => {
  const FIXTURE_SOURCE = `
import { readFileSync, writeFileSync } from "node:fs";
const out = process.env.FIXTURE_OUT;
const argv = process.argv.slice(2);
if (process.env.FIXTURE_SLEEP_MS) await new Promise((r) => setTimeout(r, Number(process.env.FIXTURE_SLEEP_MS)));
if (process.env.FIXTURE_FAIL === "1") process.exit(3);
const idx = argv.indexOf("--text-file");
const text = idx >= 0 ? readFileSync(argv[idx + 1], "utf8") : "";
if (out) writeFileSync(out, JSON.stringify({ argv, text }));
`;

  function fixtureCommand(): { dir: string; fixture: string; out: string } {
    const dir = mkdtempSync(join(tmpdir(), "ab-pairdesk-fixture-"));
    const fixture = join(dir, "fixture.mjs");
    const out = join(dir, "record.json");
    writeFileSync(fixture, FIXTURE_SOURCE);
    return { dir, fixture, out };
  }

  function withEnv(name: string, value: string | undefined, fn: () => Promise<void>): Promise<void>;
  function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void>;
  async function withEnv(
    nameOrEnv: string | Record<string, string | undefined>,
    valueOrFn: string | undefined | (() => Promise<void>),
    maybeFn?: () => Promise<void>,
  ): Promise<void> {
    const env = typeof nameOrEnv === "string" ? { [nameOrEnv]: valueOrFn as string | undefined } : nameOrEnv;
    const fn = (typeof nameOrEnv === "string" ? maybeFn : valueOrFn) as () => Promise<void>;
    const previous = new Map<string, string | undefined>();
    for (const [k, v] of Object.entries(env)) {
      previous.set(k, process.env[k]);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      await fn();
    } finally {
      for (const [k, v] of previous) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  function recorded(out: string): { argv: string[]; text: string } {
    return JSON.parse(readFileSync(out, "utf8")) as { argv: string[]; text: string };
  }

  function pairDeskDirs(): string[] {
    return readdirSync(tmpdir()).filter((n) => n.startsWith("agent-bridge-pair-desk-"));
  }

  it(`uses the default ${PAIR_DESK_TIMEOUT_MS}ms timeout constant`, () => {
    expect(PAIR_DESK_TIMEOUT_MS).toBe(15000);
  });

  it("posts with the fixed args and deletes the temp text file afterwards", async () => {
    const { dir, fixture, out } = fixtureCommand();
    try {
      const ref: WorkItemRef = { tracker: "pair-desk", id: "AB-1" };
      const event: WorkItemEvent = { kind: "started", job: "job-1", agent: "codex", title: "Hello" };
      const adapter = new PairDeskAdapter({ command: process.execPath, argsPrefix: [fixture] });
      await withEnv("FIXTURE_OUT", out, () => adapter.post(ref, event));
      const { argv, text } = recorded(out);
      expect(argv.slice(0, 4)).toEqual(["comment", "AB-1", "--author", "agent-bridge"]);
      expect(argv[4]).toBe("--text-file");
      expect(typeof argv[5]).toBe("string");
      expect(text).toBe(formatEvent(event));
      // The text file and the temp dir it lived in are gone.
      expect(existsSync(argv[5] as string)).toBe(false);
      expect(existsSync(join(argv[5] as string, ".."))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects on a non-zero exit and leaves no temp dir behind", async () => {
    const { dir, fixture, out } = fixtureCommand();
    const before = new Set(pairDeskDirs());
    try {
      const adapter = new PairDeskAdapter({ command: process.execPath, argsPrefix: [fixture] });
      await withEnv({ FIXTURE_OUT: out, FIXTURE_FAIL: "1" }, () =>
        expect(adapter.post({ tracker: "pair-desk", id: "AB-9" }, { kind: "failed", job: "j", agent: "a" })).rejects.toThrow(),
      );
      for (const name of pairDeskDirs()) expect(before.has(name), name).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("kills a hanging command after timeoutMs", async () => {
    const { dir, fixture, out } = fixtureCommand();
    try {
      const adapter = new PairDeskAdapter({ command: process.execPath, timeoutMs: 1000, argsPrefix: [fixture] });
      await withEnv({ FIXTURE_OUT: out, FIXTURE_SLEEP_MS: "8000" }, () =>
        expect(
          adapter.post({ tracker: "pair-desk", id: "AB-2" }, { kind: "started", job: "j", agent: "a" }),
        ).rejects.toThrow(),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects .cmd/.bat commands with a clear error before spawning", async () => {
    for (const command of ["pair-desk.cmd", "pair-desk-wrapper.BAT"]) {
      const before = new Set(pairDeskDirs());
      const adapter = new PairDeskAdapter({ command });
      await expect(
        adapter.post({ tracker: "pair-desk", id: "AB-3" }, { kind: "started", job: "j", agent: "a" }),
      ).rejects.toThrow(/executable.*shell|\.cmd.*shell|shell.*\.cmd/i);
      for (const name of pairDeskDirs()) expect(before.has(name), `${command}:${name}`).toBe(true);
    }
  });
});
