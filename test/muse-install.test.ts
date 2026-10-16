import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeStep, planFor, type Action } from "../src/cli/installer.js";
import { installMusePlugin, musePluginArgs } from "../src/cli/muse-install.js";

const mocks = vi.hoisted(() => ({ source: vi.fn() }));
vi.mock("../src/cli/opencode-install.js", async original => ({
  ...await original<typeof import("../src/cli/opencode-install.js")>(), pluginSourceDir: mocks.source,
}));
const source = "/fixture/plugins/muse";
// The durable copy Muse installs from (and records as the plugin's source), not the transient CLI package.
const bundle = "/fixture/home/plugin-versions/muse/0.30.23";
const publish = vi.fn((_: string) => bundle);
beforeEach(() => { mocks.source.mockReturnValue(source); });
afterEach(() => { vi.clearAllMocks(); });

describe("Muse native plugin lifecycle", () => {
  it.each(["install", "update"] as const)("%s installs the durable bundle, then approves or inspects only after the plugin command succeeds", async action => {
    const commands = action === "install" ? [["plugins", "install", bundle], ["plugins", "approve", "agent-bridge"]]
      : [["plugins", "install", bundle], ["plugins", "inspect", "agent-bridge"]];
    let finish!: (code: number) => void;
    const run = vi.fn<(args: string[]) => Promise<number>>()
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(0);
    const result = installMusePlugin(action, run, publish);
    expect(publish).toHaveBeenCalledExactlyOnceWith(source);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenNthCalledWith(1, commands[0]);
    finish(0);
    const done = await result;
    expect(done[0]).toBe(`+ ${bundle}`);
    expect(done.slice(1, 3)).toEqual(commands.map(args => `muse ${args.join(" ")}`));
    if (action === "update") expect(done[3]).toContain("modified/review_needed");
    expect(run.mock.calls.map(([args]) => args)).toEqual(commands);
    expect(musePluginArgs(action, bundle)).toEqual(commands);
    const plan = planFor("muse", action);
    expect(plan).toEqual([{ kind: "muse", action }]);
    expect(describeStep(plan[0]!)).toContain(action === "install" ? "approve" : "review");
  });

  it("never updates through `muse plugins update`, which only re-reads the recorded (possibly old cached) source", () => {
    expect(musePluginArgs("update", bundle).flat()).not.toContain("update");
  });

  it.each(["install", "update"] as const)("failed %s never approves a bundle or reports success", async action => {
    const run = vi.fn<(args: string[]) => Promise<number>>().mockResolvedValue(23);
    await expect(installMusePlugin(action, run, publish)).rejects.toThrow(/failed with code 23/);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(["plugins", "install", bundle]);
  });

  it.each(["install", "update"] as const)("failed approval after %s surfaces the approval failure", async action => {
    const run = vi.fn<(args: string[]) => Promise<number>>().mockResolvedValueOnce(0).mockResolvedValueOnce(29);
    const finalAction = action === "install" ? "approve" : "inspect";
    await expect(installMusePlugin(action, run, publish)).rejects.toThrow(`muse plugins ${finalAction} agent-bridge failed with code 29`);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith(["plugins", finalAction, "agent-bridge"]);
  });

  it.each(["install", "update"] as const)("preserves a rejected %s command's diagnostic without proceeding to approval", async action => {
    const failure = new Error("Synthetic Muse stderr: plugin capability manifest rejected");
    const run = vi.fn<(args: string[]) => Promise<number>>().mockRejectedValue(failure);
    await expect(installMusePlugin(action, run, publish)).rejects.toBe(failure);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("preserves inspection diagnostics after a successful update", async () => {
    const failure = new Error("Synthetic Muse stderr: capability inspection failed");
    const run = vi.fn<(args: string[]) => Promise<number>>().mockResolvedValueOnce(0).mockRejectedValueOnce(failure);
    await expect(installMusePlugin("update", run, publish)).rejects.toBe(failure);
    expect(run.mock.calls.map(([args]) => args)).toEqual([["plugins", "install", bundle], ["plugins", "inspect", "agent-bridge"]]);
  });

  it("does not run Muse when the durable copy cannot be published", async () => {
    const failure = new Error("Immutable plugin version differs");
    const run = vi.fn<(args: string[]) => Promise<number>>();
    await expect(installMusePlugin("update", run, () => { throw failure; })).rejects.toBe(failure);
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["install", "update"] as Action[])("rejects %s before invoking Muse when the packaged source is absent", async action => {
    mocks.source.mockReturnValue(null);
    const run = vi.fn<(args: string[]) => Promise<number>>();
    await expect(installMusePlugin(action, run, publish)).rejects.toThrow("Missing Muse plugin build");
    expect(run).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("removes an installed plugin without requiring a packaged source or approving capabilities", async () => {
    mocks.source.mockReturnValue(null);
    const run = vi.fn<(args: string[]) => Promise<number>>().mockResolvedValue(0);
    await expect(installMusePlugin("uninstall", run, publish)).resolves.toEqual(["muse plugins remove agent-bridge"]);
    expect(run.mock.calls.map(([args]) => args)).toEqual([["plugins", "remove", "agent-bridge"]]);
    expect(publish).not.toHaveBeenCalled();
    const plan = planFor("muse", "uninstall");
    expect(plan).toEqual([{ kind: "muse", action: "uninstall" }]);
    expect(describeStep(plan[0]!)).not.toContain("approve");
  });
});
