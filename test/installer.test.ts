import { describe, expect, it } from "vitest";
import { describeStep, parseInstallerArgs, planFor } from "../src/cli/installer.js";

describe("installer plans", () => {
  it("only runs the official plugin commands", () => {
    expect(planFor("claude", "install").map(describeStep)).toEqual([
      "claude plugin marketplace add rennerdo30/agent-bridge",
      "claude plugin marketplace update agent-bridge",
      "claude plugin install agent-bridge@agent-bridge",
    ]);
    expect(planFor("codex", "install").map(describeStep)).toEqual([
      "codex plugin marketplace add rennerdo30/agent-bridge",
      "codex plugin marketplace upgrade agent-bridge",
      "codex plugin add agent-bridge@agent-bridge",
    ]);
    expect(planFor("claude", "uninstall").map(describeStep)).toEqual(["claude plugin uninstall agent-bridge@agent-bridge"]);
    expect(planFor("codex", "uninstall").map(describeStep)).toEqual(["codex plugin remove agent-bridge@agent-bridge"]);
    expect(planFor("opencode", "update")).toEqual([{ kind: "opencode", action: "update" }]);
  });

  it("selects tools from the arguments, or all of them", () => {
    expect(parseInstallerArgs("install", ["codex", "--yes"])).toEqual(["codex"]);
    expect(parseInstallerArgs("install", [])).toEqual(["claude", "codex", "opencode"]);
  });
});
