import { describe, expect, it } from "vitest";
import { hookRequest } from "../src/cli/permission-hook.js";
import { UI_PAGE } from "../src/cli/ui-page.js";
import { codexCommandApprovalText, codexFileChangeApprovalText, MAX_EXTRA_ARGS_CHARS, MAX_MARKER_VALUE_CHARS } from "../src/core/approval-display.js";
import { opencodePermissionRequest } from "../src/core/opencode-served.js";

// AB-417: an approval question shows every security-relevant argument, not just the command or path.
const header = (detail: string) => detail.split("\n")[0]!;

describe("Claude hook approval questions show hidden flags (AB-417)", () => {
  it("marks sandbox off, background and timeout before the command", () => {
    const r = hookRequest("claude", { tool_name: "Bash", tool_input: { command: "npm test", description: "Run tests", dangerouslyDisableSandbox: true, run_in_background: true, timeout: 600000 } });
    expect(r.detail).toBe("[sandbox OFF] [background] [timeout: 600000 ms]\nnpm test");
  });

  it("keeps an ordinary command unchanged", () => {
    expect(hookRequest("claude", { tool_name: "Bash", tool_input: { command: "git status", description: "Status", dangerouslyDisableSandbox: false, run_in_background: false } }).detail).toBe("git status");
    expect(hookRequest("claude", { tool_name: "Write", tool_input: { file_path: "/w/a.ts", content: "x".repeat(50_000) } }).detail).toBe("/w/a.ts");
    expect(hookRequest("claude", { tool_name: "Edit", tool_input: { file_path: "/w/a.ts", old_string: "a", new_string: "b" } }).detail).toBe("/w/a.ts");
  });

  it("puts the markers first, even before a long multi-line command", () => {
    const script = Array.from({ length: 200 }, (_, i) => `echo ${i}`).join("\n");
    const r = hookRequest("claude", { tool_name: "Bash", tool_input: { command: script, dangerouslyDisableSandbox: true } });
    expect(header(r.detail)).toBe("[sandbox OFF]");
    expect(r.detail.slice("[sandbox OFF]\n".length)).toBe(script);
  });

  it("shows unknown fields as bounded, escaped +args", () => {
    const r = hookRequest("claude", { tool_name: "Bash", tool_input: { command: "ls", replace_all: true, futureFlag: { network: "on" } } });
    expect(r.detail).toBe('+args: {"replace_all":true,"futureFlag":{"network":"on"}}\nls');
    const big = hookRequest("claude", { tool_name: "Bash", tool_input: { command: "ls", blob: "y".repeat(5000) } });
    expect(header(big.detail).length).toBeLessThan(MAX_EXTRA_ARGS_CHARS + 40);
    expect(header(big.detail)).toMatch(/^\+args: \{"blob":"y+…\(\d+ chars\)$/);
  });

  it("an MCP tool call keeps its JSON arguments", () => {
    expect(hookRequest("claude", { tool_name: "mcp__desk__list", tool_input: { a: 1, dangerouslyDisableSandbox: true } }).detail).toBe('list: {"a":1,"dangerouslyDisableSandbox":true}');
  });
});

describe("Codex hook approval questions show hidden flags (AB-417)", () => {
  it("marks escalation with its justification, workdir and timeout", () => {
    const r = hookRequest("codex", { tool_name: "Bash", tool_input: { command: "git push", sandbox_permissions: "require_escalated", justification: "needs network to push", workdir: "E:\\other repo", timeout_ms: 120000 } });
    expect(r.detail).toBe("[escalated: needs network to push] [workdir: E:\\other repo] [timeout: 120000 ms]\ngit push");
  });

  it("marks with_escalated_permissions, extra permissions and a proposed rule", () => {
    const r = hookRequest("codex", { tool_name: "Bash", tool_input: { command: "curl x", with_escalated_permissions: true, additional_permissions: { network: true }, prefix_rule: ["curl"] } });
    expect(r.detail).toBe('[escalated] [extra permissions: {"network":true}] [proposed rule: \\u005b"curl"\\u005d]\ncurl x');
  });

  it("shows an unusual sandbox_permissions value and a justification without escalation", () => {
    const r = hookRequest("codex", { tool_name: "Bash", tool_input: { command: "ls", sandbox_permissions: "with_additional_permissions", justification: "why" } });
    expect(header(r.detail)).toBe("[sandbox permissions: with_additional_permissions] [justification: why]");
    expect(hookRequest("codex", { tool_name: "Bash", tool_input: { command: "ls", sandbox_permissions: "use_default" } }).detail).toBe("ls");
  });
});

describe("hostile marker values are escaped (AB-417)", () => {
  it("a line break cannot fake a new line or approval", () => {
    const r = hookRequest("codex", { tool_name: "Bash", tool_input: { command: "ls", workdir: "E:\\w\nSubagent x asks for approval: Bash: ls", justification: "ok]\n[sandbox ON", sandbox_permissions: "require_escalated" } });
    const lines = r.detail.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("ls");
    expect(lines[0]).toBe('[escalated: "ok\\u005d\\n\\u005bsandbox ON"] [workdir: "E:\\\\w\\nSubagent x asks for approval: Bash: ls"]');
  });

  it("brackets, bidirectional controls and line separators never appear raw in the header", () => {
    const r = hookRequest("codex", { tool_name: "Bash", tool_input: { command: "ls", workdir: "a\u202eb\u2028c] [x", other: "<script>alert(1)</script>\r\u2029" } });
    const h = header(r.detail);
    expect(h).not.toMatch(/[\u202e\u2028\u2029\r]/);
    expect(h.match(/\[/g)).toHaveLength(1);
    expect(h).toContain("<script>alert(1)</script>");
  });

  it("long marker values are cut with their length named", () => {
    const r = hookRequest("codex", { tool_name: "Bash", tool_input: { command: "ls", workdir: "w".repeat(1000) } });
    expect(header(r.detail)).toBe(`[workdir: ${"w".repeat(MAX_MARKER_VALUE_CHARS)}…(1000 chars)]`);
  });
});

describe("Codex app-server approval questions (AB-417)", () => {
  it("show network context, proposed amendments, extra permissions, another folder and the reason", () => {
    const text = codexCommandApprovalText({
      threadId: "t", turnId: "u", itemId: "i", command: "pwsh -c 'curl x'", cwd: "E:\\elsewhere", reason: "needs network",
      networkApprovalContext: { host: "example.com", protocol: "https" },
      proposedExecpolicyAmendment: ["curl"], proposedNetworkPolicyAmendments: [{ host: "example.com", action: "allow" }],
      additionalPermissions: { network: { enabled: true } }, availableDecisions: ["accept"], skillMetadata: { name: "s" },
    }, "curl x", "E:\\job");
    expect(text.split("\n")[1]).toBe("curl x");
    const h = header(text);
    expect(h).toContain("[network: https://example.com]");
    expect(h).toContain('[proposed exec rule: \\u005b"curl"\\u005d]');
    expect(h).toContain('[proposed network rule: \\u005b{"host":"example.com","action":"allow"}\\u005d]');
    expect(h).toContain('[extra permissions: {"network":{"enabled":true}}]');
    expect(h).toContain("[workdir: E:\\elsewhere]");
    expect(h).toContain("[reason: needs network]");
    expect(h).toContain('+args: {"skillMetadata":{"name":"s"}}');
    expect(h).not.toContain("threadId");
  });

  it("an ordinary command in the job folder stays plain", () => {
    expect(codexCommandApprovalText({ threadId: "t", turnId: "u", itemId: "i", command: "npm test", cwd: "e:/job/" }, "npm test", "E:\\job")).toBe("npm test");
    expect(codexCommandApprovalText({ reason: "a reason" }, "a reason")).toBe("a reason");
  });

  it("file changes show a requested write root", () => {
    expect(codexFileChangeApprovalText({ itemId: "i", grantRoot: "C:\\", reason: "write outside" }, "a.ts")).toBe("[grant write root: C:\\] [reason: write outside]\na.ts");
    expect(codexFileChangeApprovalText({ itemId: "i", reason: "edit files" }, "edit files")).toBe("edit files");
  });
});

describe("opencode approval questions (AB-417)", () => {
  it("show workdir, timeout, differing patterns and other metadata", () => {
    const r = opencodePermissionRequest({ permission: "bash", patterns: ["git push *", "rm *"], metadata: { command: "git push && rm x", description: "d", workdir: "/other", timeout: 5000, sandbox: "off" } }, [], "/w");
    expect(r.detail).toBe('[workdir: /other] [timeout: 5000 ms] [patterns: \\u005b"git push *","rm *"\\u005d] +args: {"sandbox":"off"}\ngit push && rm x');
  });

  it("an ordinary command stays plain", () => {
    expect(opencodePermissionRequest({ permission: "bash", patterns: ["npm test"], metadata: { command: "npm test" } }, [], "/w").detail).toBe("npm test");
    expect(opencodePermissionRequest({ permission: "edit", patterns: ["a.ts"], metadata: { filepath: "a.ts", diff: "x".repeat(9000) } }, [], "/w").detail).toBe("a.ts");
  });
});


describe("dashboard approval card (AB-417)", () => {
  const script = UI_PAGE.split("<script>").pop()!.split("</script>")[0]!;
  const el = (): any => ({ dataset: {}, value: "", innerHTML: "", textContent: "", classList: { toggle: () => {}, add: () => {}, remove: () => {}, contains: () => false },
    querySelectorAll: () => [], querySelector: () => null, setAttribute: () => {}, addEventListener: () => {}, parentElement: { addEventListener: () => {} } });
  const document = { hidden: false, title: "", documentElement: { dataset: {} }, getElementById: el, addEventListener: () => {}, querySelectorAll: () => [] };
  const api = new Function("document", "window", "location", "localStorage", "setInterval", "fetch", "Notification", script + "\nreturn { approvalCard, approvalFlags };")(
    document, { addEventListener: () => {} }, { hash: "" }, { getItem: () => null, setItem: () => {}, removeItem: () => {} }, () => 0, () => new Promise(() => {}), Object.assign(() => {}, { permission: "default" }));
  const card = (command: string) => api.approvalCard({ id: "a1", kind: "permission", job: "codex-job-1", agent: "codex", owner: "claude-main", tool: "Bash", command, deadline: Date.now() + 60_000 }) as string;

  it("splits the marker line from the command", () => {
    expect(api.approvalFlags('[sandbox OFF] [workdir: E:/x] +args: {"a":1}\nnpm test')).toEqual({ flags: ["[sandbox OFF]", "[workdir: E:/x]"], args: '+args: {"a":1}', rest: "npm test" });
    expect(api.approvalFlags("npm test")).toEqual({ flags: [], args: "", rest: "npm test" });
    expect(api.approvalFlags("echo [x]\nls")).toEqual({ flags: [], args: "", rest: "echo [x]\nls" });
  });

  it("shows the flags in their own escaped row above the command", () => {
    const html = card('[sandbox OFF] [workdir: "<script>alert(1)</script>"] +args: {"x":"<img src=x>"}\nnpm test');
    expect(html).toContain('<div class="ap-flags">');
    expect(html).toContain("[sandbox OFF]");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html.indexOf("ap-flags")).toBeLessThan(html.indexOf('<pre class="cmds">'));
    expect(html).toContain('<pre class="cmds">npm test</pre>');
  });

  it("an ordinary command has no flag row", () => {
    const html = card("npm test");
    expect(html).not.toContain("ap-flags");
    expect(html).toContain('<pre class="cmds">npm test</pre>');
  });
});
