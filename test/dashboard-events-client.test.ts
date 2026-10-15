import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UI_PAGE } from "../src/cli/ui-page.js";

afterEach(() => { vi.useRealTimers(); });

/** Execute the served stream lifecycle with browser-shaped events and deterministic time. */
function browser(visibilityState = "visible", random = 0.5) {
  vi.useFakeTimers();
  const streams: FakeEventSource[] = [];
  const document = { visibilityState, addEventListener: vi.fn() };
  const render = vi.fn();
  const delays: number[] = [];
  class FakeEventSource {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    readyState = 0;
    close = vi.fn(() => { this.readyState = 2; });
    constructor(readonly url: string) { streams.push(this); }
    // A refused HTTP response (including 503) is terminal; network loss may be CONNECTING.
    fail(readyState = 2) { this.readyState = readyState; this.onerror?.(); }
    open() { this.readyState = 1; this.onopen?.(); }
  }
  const script = UI_PAGE.slice(UI_PAGE.indexOf("function pushed(changes)"), UI_PAGE.lastIndexOf("</script>"));
  runInNewContext(script, {
    document, EventSource: FakeEventSource, render, pushPending: false,
    shownRuns: new Set(), shownChat: { session: "shown-session" },
    Math: { min: Math.min, random: () => random },
    setTimeout: (callback: () => void, delay: number) => {
      if (delay > 0) delays.push(delay);
      return setTimeout(callback, delay);
    },
    clearTimeout,
  });
  const visibility = document.addEventListener.mock.calls.find(([name]) => name === "visibilitychange")![1] as () => void;
  return { streams, render, delays, visibility: (state: string) => { document.visibilityState = state; visibility(); } };
}

describe("dashboard visible-tab event stream retry", () => {
  it("reconnects after a terminal 503 while still visible and reads changes missed during backoff", () => {
    const page = browser();
    expect(page.streams[0]!.url).toBe("/api/events");
    page.streams[0]!.fail();
    expect(page.streams[0]!.close).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(999);
    expect(page.streams).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(page.streams).toHaveLength(2);
    page.streams[1]!.open();
    vi.advanceTimersByTime(0);
    expect(page.render).toHaveBeenCalledOnce();
    page.streams[1]!.onmessage?.({ data: JSON.stringify([{ kind: "chat", session: "shown-session" }]) });
    vi.advanceTimersByTime(0);
    expect(page.render).toHaveBeenCalledTimes(2);
    // A successful open resets the backoff, including after a network failure.
    page.streams[1]!.fail(0);
    expect(page.delays).toEqual([1000, 1000]);
    vi.advanceTimersByTime(1000);
    expect(page.streams).toHaveLength(3);
  });

  it("does not connect while hidden and cancels a pending retry when hidden", () => {
    const page = browser("hidden");
    vi.advanceTimersByTime(60_000);
    expect(page.streams).toHaveLength(0);
    page.visibility("visible");
    expect(page.streams).toHaveLength(1);
    page.streams[0]!.fail();
    page.visibility("hidden");
    vi.advanceTimersByTime(60_000);
    expect(page.streams).toHaveLength(1);
    page.visibility("visible");
    expect(page.streams).toHaveLength(2);
    page.visibility("hidden");
    expect(page.streams[1]!.close).toHaveBeenCalledOnce();
    // Late errors on the closed stream must not schedule retries.
    page.streams[1]!.fail();
    vi.advanceTimersByTime(60_000);
    expect(page.streams).toHaveLength(2);
  });

  it.each([0, 0.5, 0.999999])("caps repeated failures at 30 seconds with jitter %s", random => {
    const page = browser("visible", random);
    for (let n = 0; n < 12; n++) {
      page.streams[n]!.fail();
      // Duplicate errors must not add another timer or advance backoff.
      page.streams[n]!.fail();
      expect(page.delays).toHaveLength(n + 1);
      const delay = page.delays[n]!;
      expect(delay).toBeGreaterThanOrEqual(800);
      expect(delay).toBeLessThanOrEqual(30_000);
      vi.advanceTimersByTime(Math.ceil(delay));
      expect(page.streams).toHaveLength(n + 2);
    }
    expect(page.delays.slice(0, 5)).toEqual([1000, 2000, 4000, 8000, 16000].map(base => base * (0.8 + random * 0.4)));
    expect(page.delays.slice(5)).toEqual(Array(7).fill(Math.min(30_000, 30_000 * (0.8 + random * 0.4))));
  });
});
