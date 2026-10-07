import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { resolveBinary, unwrapNpmShim } from "../core/delegate.js";
import { t } from "../core/i18n.js";
import { describeCodexUser, listCodexUsers } from "./codex-users.js";
import { installOpencode, opencodeSourceDir, uninstallOpencode } from "./opencode-install.js";
import { installAntigravity, antigravitySourceDir, uninstallAntigravity } from "./antigravity-install.js";

/** Where the agent-bridge marketplaces live (Claude Code and Codex read the same repo). */
export const MARKETPLACE_REPO = "rennerdo30/agent-bridge";
export const MARKETPLACE_NAME = "agent-bridge";
export const PLUGIN_ID = `agent-bridge@${MARKETPLACE_NAME}`;

export type Tool = "claude" | "codex" | "opencode" | "antigravity";
export const TOOLS: readonly Tool[] = ["claude", "codex", "opencode", "antigravity"];
export type Action = "install" | "update" | "uninstall";

/** One step: either an official CLI command, or the opencode file copy (opencode has no plugin CLI for this). */
export type Step = { kind: "command"; bin: string; args: string[]; allowFailure?: boolean } | { kind: "opencode"; action: Action } | { kind: "antigravity"; action: Action };

/** The exact official commands for each tool and action. Nothing else is ever run. */
export function planFor(tool: Tool, action: Action): Step[] {
  if (tool === "antigravity") return [{ kind: "antigravity", action }];
  if (tool === "claude") {
    switch (action) {
      case "install":
        return [
          // Adding an existing marketplace fails harmlessly; the update afterwards refreshes it.
          { kind: "command", bin: "claude", args: ["plugin", "marketplace", "add", MARKETPLACE_REPO], allowFailure: true },
          { kind: "command", bin: "claude", args: ["plugin", "marketplace", "update", MARKETPLACE_NAME] },
          { kind: "command", bin: "claude", args: ["plugin", "install", PLUGIN_ID] },
        ];
      case "update":
        return [
          { kind: "command", bin: "claude", args: ["plugin", "marketplace", "update", MARKETPLACE_NAME] },
          { kind: "command", bin: "claude", args: ["plugin", "update", PLUGIN_ID] },
        ];
      case "uninstall":
        return [{ kind: "command", bin: "claude", args: ["plugin", "uninstall", PLUGIN_ID] }];
    }
  }
  if (tool === "codex") {
    switch (action) {
      case "install":
        return [
          { kind: "command", bin: "codex", args: ["plugin", "marketplace", "add", MARKETPLACE_REPO], allowFailure: true },
          { kind: "command", bin: "codex", args: ["plugin", "marketplace", "upgrade", MARKETPLACE_NAME] },
          { kind: "command", bin: "codex", args: ["plugin", "add", PLUGIN_ID] },
        ];
      case "update":
        return [
          { kind: "command", bin: "codex", args: ["plugin", "marketplace", "upgrade", MARKETPLACE_NAME] },
          { kind: "command", bin: "codex", args: ["plugin", "add", PLUGIN_ID] },
        ];
      case "uninstall":
        return [{ kind: "command", bin: "codex", args: ["plugin", "remove", PLUGIN_ID] }];
    }
  }
  return [{ kind: "opencode", action }];
}

export function describeStep(step: Step): string {
  if (step.kind === "command") return `${step.bin} ${step.args.join(" ")}`;
  if (step.kind === "antigravity") return `${step.action} Antigravity global agent-bridge plugin with backups`;
  return step.action === "uninstall" ? t("installer.opencodeRemove") : t("installer.opencodeCopy");
}

function runInherited(bin: string, args: string[]): Promise<number> {
  const resolved = resolveBinary(bin);
  if (!resolved) return Promise.resolve(127);
  const shim = /\.(cmd|bat)$/i.test(resolved) ? unwrapNpmShim(resolved) : null;
  const command = shim?.command ?? resolved;
  const fullArgs = [...(shim?.prefix ?? []), ...args];
  return new Promise((resolve) => {
    const child = spawn(command, fullArgs, { stdio: "inherit", shell: false });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** Ask a question; closed input (EOF, e.g. piped or non-interactive) counts as "no". */
function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => {
    const onClose = () => resolve("");
    rl.once("close", onClose);
    rl.question(question).then(
      (a) => {
        rl.off("close", onClose);
        resolve(a);
      },
      () => resolve(""),
    );
  });
}

export interface InstallerOptions {
  action: Action;
  tools: Tool[];
  yes: boolean;
  out: (s: string) => void;
}

/** Run the plan tool by tool, showing each command and asking before it runs (unless --yes). */
export async function runInstaller(opts: InstallerOptions): Promise<number> {
  const rl = opts.yes ? null : createInterface({ input: process.stdin, output: process.stdout });
  let failures = 0;
  try {
    for (const tool of opts.tools) {
      const bin = tool === "antigravity" ? "agy" : tool;
      if (!resolveBinary(bin)) {
        opts.out(t("installer.notFound", { tool }));
        continue;
      }
      const steps = planFor(tool, opts.action);
      opts.out(t("installer.plan", { tool }));
      for (const s of steps) opts.out(`  ${describeStep(s)}`);
      if (tool === "codex") {
        opts.out(t("installer.codexNote"));
        const users = await listCodexUsers();
        if (users.length) {
          opts.out(t("installer.codexInUse"));
          for (const u of users) opts.out(`    - ${describeCodexUser(u)}`);
          // On Windows the update cannot replace a plugin folder in use: skip it instead of failing.
          if (process.platform === "win32") {
            opts.out(t("installer.codexSkippedInUse"));
            continue;
          }
        }
      }
      if (rl) {
        const answer = (await ask(rl, t("installer.confirm", { tool }))).trim().toLowerCase();
        if (answer !== "y" && answer !== "yes") {
          opts.out(t("installer.skipped", { tool }));
          continue;
        }
      }
      for (const step of steps) {
        if (step.kind === "antigravity") {
          const source = antigravitySourceDir();
          if (step.action !== "uninstall" && !source) { opts.out("Missing Antigravity plugin build"); failures++; continue; }
          const res = step.action === "uninstall" ? uninstallAntigravity() : installAntigravity(source!);
          for (const file of res.files) opts.out(`  ${file}`);
          opts.out("Restart agy to load the agent-bridge plugin. Existing files were backed up.");
          continue;
        }
        if (step.kind === "opencode") {
          const source = opencodeSourceDir();
          if (step.action === "uninstall") {
            const res = uninstallOpencode();
            for (const f of res.files) opts.out(`  - ${f}`);
          } else if (!source) {
            opts.out(t("cli.opencode.noSource"));
            failures++;
          } else {
            const res = installOpencode(source);
            for (const f of res.files) opts.out(`  + ${f}`);
            for (const f of res.skipped) opts.out(t("cli.install.skipped", { path: f }));
          }
          continue;
        }
        opts.out(`> ${describeStep(step)}`);
        const code = await runInherited(step.bin, step.args);
        if (code !== 0 && !step.allowFailure) {
          opts.out(t("installer.stepFailed", { code }));          if (tool === "codex") {
            const users = await listCodexUsers();
            if (users.length) {
              opts.out(t("installer.codexBlocked"));
              for (const u of users) opts.out(`    - ${describeCodexUser(u)}`);
            }
          }
          failures++;
          break;
        }
      }
    }
  } finally {
    rl?.close();
  }
  opts.out(failures ? t("installer.doneWithErrors", { count: failures }) : t("installer.done"));
  return failures ? 1 : 0;
}

export function parseInstallerArgs(action: Action, rest: string[]): InstallerOptions["tools"] {
  const picked = rest.filter((a) => (TOOLS as readonly string[]).includes(a)) as Tool[];
  return picked.length ? picked : [...TOOLS];
}
