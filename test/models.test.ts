import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import { describeModels, modelParameterDescription, readModels } from "../src/core/models.js";
import { captureOutput, codexAppServerCall } from "../src/core/usage.js";
import { listOpencodeModels } from "../src/core/opencode-models.js";
import { makeEnv, type TestEnv } from "./helpers.js";

vi.mock("../src/core/usage.js", () => ({ captureOutput: vi.fn(), codexAppServerCall: vi.fn() }));
vi.mock("../src/core/opencode-models.js", () => ({ listOpencodeModels: vi.fn() }));

let env: TestEnv;
const cfg = { ...DEFAULT_CONFIG, effort: {} };
beforeEach(() => {
  env = makeEnv();
  vi.clearAllMocks();
  vi.mocked(codexAppServerCall).mockResolvedValue({ data: [{ id: "test-codex", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }], defaultReasoningEffort: "high" }, { id: "other-codex" }] });
  vi.mocked(captureOutput).mockResolvedValue("--model <model> Model (e.g. 'opus', 'sonnet') --effort <level> Effort (low, medium, high)");
  vi.mocked(listOpencodeModels).mockResolvedValue(["provider/first", "provider/second"]);
});
afterEach(async () => env.cleanup());

describe("available subagent models", () => {
  it("does not start any CLI while producing the startup model description", () => {
    const desc = modelParameterDescription("codex", { ...cfg, codexModel: "chosen" }, env.home, "example");
    expect(desc).toContain("Default: chosen.");
    expect(desc).toContain('list_models(agent="codex")');
    expect(modelParameterDescription("claude", cfg, env.home, "opus")).toContain("Available: opus, sonnet.");
    expect(codexAppServerCall).not.toHaveBeenCalled();
    expect(captureOutput).not.toHaveBeenCalled();
    expect(listOpencodeModels).not.toHaveBeenCalled();
  });

  it("shares concurrent reads, caches the list and exposes its default and effort levels", async () => {
    const reports = await Promise.all([readModels("codex", cfg, env.home, nullLogger, env.home), readModels("codex", cfg, env.home, nullLogger, env.home)]);
    expect(codexAppServerCall).toHaveBeenCalledTimes(1);
    expect(reports[0]).toMatchObject({ defaultModel: "test-codex", models: ["test-codex", "other-codex"] });
    expect(reports[0]!.lines.join("\n")).toContain("Efforts: low, high (default high)");
    expect(await readModels("codex", cfg, env.home, nullLogger, env.home)).toEqual(reports[0]);
    expect(codexAppServerCall).toHaveBeenCalledTimes(1);
    expect(modelParameterDescription("codex", cfg, env.home, "example")).toContain("Available: test-codex, other-codex.");
    expect(modelParameterDescription("codex", cfg, env.home, "example")).toContain("Default: test-codex.");
    const cache = JSON.parse(readFileSync(join(env.home, "models-codex.json"), "utf8"));
    cache.at = 0;
    writeFileSync(join(env.home, "models-codex.json"), JSON.stringify(cache));
    expect(modelParameterDescription("codex", cfg, env.home, "example")).not.toContain("test-codex");
    await readModels("codex", cfg, env.home, nullLogger, env.home);
    expect(codexAppServerCall).toHaveBeenCalledTimes(2);
  });

  it("shows Claude aliases, opencode ids and configured defaults", async () => {
    expect(await readModels("claude", { ...cfg, claudeModel: "sonnet" }, env.home, nullLogger, env.home)).toMatchObject({ defaultModel: "sonnet", models: ["opus", "sonnet"] });
    expect(await readModels("opencode", { ...cfg, opencodeModel: "provider/first" }, env.home, nullLogger, env.home)).toMatchObject({ defaultModel: "provider/first", models: ["provider/first", "provider/second"] });
    expect(await readModels("opencode", cfg, env.home, nullLogger, env.home)).toMatchObject({ defaultModel: null });
    expect((await describeModels("codex", cfg, env.home, nullLogger, "other")).join("\n")).toContain("- other-codex");
    expect((await describeModels("codex", cfg, env.home, nullLogger, "other")).join("\n")).not.toContain("- test-codex");
  });

  it("does not keep failed CLI reads or reuse a list from another binary", async () => {
    vi.mocked(codexAppServerCall).mockRejectedValueOnce(new Error("unavailable"));
    expect((await readModels("codex", cfg, env.home, nullLogger, env.home)).lines[0]).toContain("Could not list");
    await readModels("codex", cfg, env.home, nullLogger, env.home);
    expect(codexAppServerCall).toHaveBeenCalledTimes(2);
    expect(modelParameterDescription("codex", { ...cfg, codexBin: "another-codex" }, env.home, "example")).not.toContain("test-codex");
  });
});
