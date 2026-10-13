import { describe, expect, it } from "vitest";
import { classifyWindowsCreate, daemonEnvironment, windowsArgument } from "../src/core/daemon-launcher.js";

describe("daemon creation evidence", () => {
  it("allows only complete known WMI failures to select degraded compatibility", () => {
    for (const code of [2, 3, 8, 9, 21, 22, 0xffffffff]) expect(classifyWindowsCreate(0, JSON.stringify({ code, pid: 0 })).kind).toBe("unavailable");
    for (const output of ["", "{}", '{"code":0,', '{"code":"2","pid":0}', '{"code":1234,"pid":0}', '{"code":2,"pid":123}', '{"code":0,"pid":0}', '{"code":0,"pid":123,"extra":true}']) {
      expect(classifyWindowsCreate(0, output).kind).toBe("unknown");
    }
    expect(classifyWindowsCreate(1, '{"code":2,"pid":0}').kind).toBe("unknown");
    expect(classifyWindowsCreate(null, '{"code":0,"pid":123}').kind).toBe("unknown");
    expect(classifyWindowsCreate(0, '{"code":0,"pid":123}').kind).toBe("created");
  });
  it("quotes spaces, literal quotes and trailing backslashes as Windows argv", () => {
    expect(windowsArgument("a b")).toBe('"a b"');
    expect(windowsArgument('a"b')).toBe('"a\\"b"');
    expect(windowsArgument("a\\")).toBe('"a\\\\"');
    expect(() => windowsArgument("a\nb")).toThrow();
  });
  it("does not inherit session control credentials or arbitrary Node injection", () => {
    const env = daemonEnvironment({ cli: "fixture", home: "fixture-home", pipe: "fixture-pipe", cwd: "fixture" });
    expect(Object.keys(env).filter(key => /^AGENT_BRIDGE_(?:PARENT_|ROOT_|JOB_|DELEGATE_|INTERNAL$)/.test(key))).toEqual([]);
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.AGENT_BRIDGE_HOME).toBe("fixture-home");
    expect(env.AGENT_BRIDGE_PIPE).toBe("fixture-pipe");
  });
});
