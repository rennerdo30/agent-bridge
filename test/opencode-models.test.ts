import { describe, expect, it } from "vitest";
import { resolveOpencodeModel } from "../src/core/opencode-models.js";

const MODELS = [
  "opencode/big-pickle",
  "opencode/muse-spark-1.3-contributor-free",
  "opencode/mimo-v2.6-flash-free",
  "zai-coding-plan/glm-4.7",
  "zai-coding-plan/glm-4.6",
  "deepseek/deepseek-chat",
];

describe("resolveOpencodeModel", () => {
  it("keeps exact ids", () => {
    expect(resolveOpencodeModel("zai-coding-plan/glm-4.7", MODELS)).toEqual({ model: "zai-coding-plan/glm-4.7", note: null });
  });

  it("resolves short and partial names when they are unique", () => {
    for (const input of ["muse-spark", "opencode/muse-spark", "Muse-Spark", "muse"]) {
      const r = resolveOpencodeModel(input, MODELS);
      expect(r, input).toMatchObject({ model: "opencode/muse-spark-1.3-contributor-free" });
      expect((r as { note: string }).note).toContain("resolved");
    }
    expect(resolveOpencodeModel("deepseek-chat", MODELS)).toMatchObject({ model: "deepseek/deepseek-chat" });
  });

  it("refuses ambiguous names and lists the candidates", () => {
    const r = resolveOpencodeModel("glm", MODELS) as { error: string };
    expect(r.error).toContain("ambiguous");
    expect(r.error).toContain("zai-coding-plan/glm-4.7");
    expect(r.error).toContain("zai-coding-plan/glm-4.6");
  });

  it("explains unknown names with suggestions", () => {
    const r = resolveOpencodeModel("openai/gpt-flash", MODELS) as { error: string };
    expect(r.error).toContain('Unknown opencode model "openai/gpt-flash"');
    expect(r.error).toContain("opencode/mimo-v2.6-flash-free");
  });

  it("passes the input through when the model list is unavailable", () => {
    expect(resolveOpencodeModel("anything/x", [])).toEqual({ model: "anything/x", note: null });
  });
});
