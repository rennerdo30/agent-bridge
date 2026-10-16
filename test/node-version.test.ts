import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { MIN_NODE_MAJOR, nodeVersionProblem } from "../src/core/node-version.js";

it("accepts Node 24 and newer and refuses Node 22 and older", () => {
  expect(MIN_NODE_MAJOR).toBe(24);
  for (const ok of ["v24.0.0", "v24.22.0", "v26.4.0", "v30.1.2"]) expect(nodeVersionProblem(ok)).toBeNull();
  for (const old of ["v22.16.0", "v22.23.3", "v23.11.1", "v20.0.0", "v18.20.8"]) {
    expect(nodeVersionProblem(old)).toContain(`requires Node.js 24 or newer; this is Node.js ${old}`);
  }
  // An unreadable version is never treated as supported.
  expect(nodeVersionProblem("unknown")).toContain("requires Node.js 24 or newer");
  // The running test process itself is supported.
  expect(nodeVersionProblem(process.version)).toBeNull();
});

it("guards every bundled entry point before its other imports, and declares the same minimum", () => {
  for (const entry of ["src/mcp/launcher.ts", "src/mcp/main.ts", "src/cli/main.ts"]) {
    const first = readFileSync(join(import.meta.dirname, "..", entry), "utf8").split("\n").find((line) => line.startsWith("import "));
    expect(first, entry).toBe('import "../core/node-version-guard.js";');
  }
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
  expect(pkg.engines.node).toBe(`>=${MIN_NODE_MAJOR}`);
});
