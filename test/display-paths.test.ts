import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configurePathDisplay, discoverDriveAliases, displayPath, displayPathText, PATH_ALIAS_CACHE_TTL_MS } from "../src/core/display-paths.js";

const canonical = (path: string) => ({ "X:\\": "C:\\", "Q:\\": "D:\\", "R:\\": "C:\\subfolder" })[path] ?? path;
beforeEach(() => configurePathDisplay({ preferAlias: true }));
afterEach(() => { configurePathDisplay({ preferAlias: true }); vi.useRealTimers(); });

describe("verified preferred drive spelling", () => {
  it("formats absolute paths, including future files and native prefixes", () => {
    expect(discoverDriveAliases("win32", canonical)).toEqual([{ alias: "Q:\\", real: "D:\\" }, { alias: "X:\\", real: "C:\\" }]);
    expect(displayPath("C:/new/report.md", "win32", canonical)).toBe("X:/new/report.md");
    expect(displayPath("d:\\work\\file", "win32", canonical)).toBe("Q:\\work\\file");
    expect(displayPath("\\\\?\\C:\\work", "win32", canonical)).toBe("X:\\work");
    expect(displayPath("X:/work", "win32", canonical)).toBe("X:/work");
    expect(displayPath("Q:/work", "win32", canonical)).toBe("Q:/work");
    expect(displayPath("C:relative", "win32", canonical)).toBe("C:relative");
    expect(displayPath("R:/unrelated", "win32", canonical)).toBe("R:/unrelated");
  });
  it("leaves paths unchanged without a verified whole-drive mapping", () => {
    const path = "C:/work";
    for (const resolve of [() => { throw new Error("missing"); }, (p: string) => p, () => "C:\\subfolder", (p: string) => { if (p === "X:\\") return "C:\\"; throw new Error("target unavailable"); }]) {
      expect(displayPath(path, "win32", resolve)).toBe(path);
      expect(displayPathText(`cwd=${path}`, "win32", resolve)).toBe(`cwd=${path}`);
    }
    expect(displayPath(path, "linux", canonical)).toBe(path);
    expect(displayPath("\\\\server\\share", "win32", canonical)).toBe("\\\\server\\share");
  });
  it("formats diagnostic paths idempotently without rewriting embedded identifiers", () => {
    const text = 'cwd=C:/work; log: "D:\\new file.log"; failed (\\\\?\\C:\\work); notC:/value';
    const formatted = displayPathText(text, "win32", canonical);
    expect(formatted).toBe('cwd=X:/work; log: "Q:\\new file.log"; failed (X:\\work); notC:/value');
    expect(displayPathText(formatted, "win32", canonical)).toBe(formatted);
    expect(displayPathText("`C:/work` [file](D:/work)", "win32", canonical)).toBe("`X:/work` [file](Q:/work)");
  });
  it("accepts namespaced roots and deterministically chooses among verified aliases", () => {
    const roots = (path: string) => path === "X:\\" || path === "W:\\" ? "\\\\?\\c:\\" : path;
    expect(displayPath("C:/file", "win32", roots)).toBe("W:/file");
    expect(displayPath("X:/file", "win32", roots)).toBe("X:/file");
  });
  it("bounds positive and negative discovery to 26 probes per TTL across hot-path calls", () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(0);
    let present = false;
    const probe = vi.fn((path: string) => present && path === "X:\\" ? "C:\\" : path);
    expect(displayPath("C:/file", "win32", probe)).toBe("C:/file");
    expect(probe).toHaveBeenCalledTimes(26);
    present = true;
    for (let i = 0; i < 100; i++) { displayPath("C:/file", "win32", probe); displayPathText("C:/file", "win32", probe); discoverDriveAliases("win32", probe); }
    expect(probe).toHaveBeenCalledTimes(26);
    vi.setSystemTime(PATH_ALIAS_CACHE_TTL_MS);
    expect(displayPath("C:/file", "win32", probe)).toBe("X:/file");
    expect(probe).toHaveBeenCalledTimes(52);
    present = false; vi.setSystemTime(PATH_ALIAS_CACHE_TTL_MS * 2);
    expect(displayPathText("C:/file", "win32", probe)).toBe("C:/file");
    expect(probe).toHaveBeenCalledTimes(78);
  });
  it("does not probe drives on non-Windows platforms or when display preference is disabled", () => {
    const probe = vi.fn(canonical);
    expect(displayPath("C:/file", "linux", probe)).toBe("C:/file");
    configurePathDisplay({ preferAlias: false });
    expect(displayPath("C:/file", "win32", probe)).toBe("C:/file");
    expect(displayPathText("D:/file", "win32", probe)).toBe("D:/file");
    expect(probe).not.toHaveBeenCalled();
  });
});
