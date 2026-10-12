import { describe, expect, it } from "vitest";
import { displayPath, displayPathText } from "../src/core/display-paths.js";

const canonical = (path: string) => path === "E:\\" ? "Q:\\" : path;

describe("verified preferred drive spelling", () => {
  it("formats absolute paths, including future files and native prefixes", () => {
    expect(displayPath("Q:/new/report.md", "win32", canonical)).toBe("E:/new/report.md");
    expect(displayPath("q:\\work\\file", "win32", canonical)).toBe("E:\\work\\file");
    expect(displayPath("\\\\?\\Q:\\work", "win32", canonical)).toBe("E:\\work");
    expect(displayPath("E:/work", "win32", canonical)).toBe("E:/work");
    expect(displayPath("Q:relative", "win32", canonical)).toBe("Q:relative");
    expect(displayPath("R:/unrelated", "win32", canonical)).toBe("R:/unrelated");
  });
  it("leaves paths unchanged without a verified whole-drive mapping", () => {
    const path = "Q:/work";
    for (const resolve of [() => { throw new Error("missing"); }, (p: string) => p, () => "Q:\\subfolder", (p: string) => p === "E:\\" ? "Q:\\" : "R:\\"]) {
      expect(displayPath(path, "win32", resolve)).toBe(path);
      expect(displayPathText(`cwd=${path}`, "win32", resolve)).toBe(`cwd=${path}`);
    }
    expect(displayPath(path, "linux", canonical)).toBe(path);
    expect(displayPath("\\\\server\\share", "win32", canonical)).toBe("\\\\server\\share");
  });
  it("formats diagnostic paths idempotently without rewriting embedded identifiers", () => {
    const text = 'cwd=Q:/work; log: "Q:\\new file.log"; failed (\\\\?\\Q:\\work); notQ:/value';
    const formatted = displayPathText(text, "win32", canonical);
    expect(formatted).toBe('cwd=E:/work; log: "E:\\new file.log"; failed (E:\\work); notQ:/value');
    expect(displayPathText(formatted, "win32", canonical)).toBe(formatted);
    expect(displayPathText("`Q:/work` [file](Q:/work)", "win32", canonical)).toBe("`E:/work` [file](E:/work)");
  });
});
