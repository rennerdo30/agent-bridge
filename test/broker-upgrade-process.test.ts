import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { makeEnv } from "./helpers.js";
import { nullLogger } from "../src/core/logger.js";
import { writeJsonStore } from "../src/core/json-store.js";
import { OwnerQuestionStore, readOwnerQuestions } from "../src/core/owner-questions.js";
import { publishApproval, newApprovalId, listPendingApprovals, answerPendingApproval } from "../src/core/relay.js";

it("real old/new servers automatically transfer ownership once, retaining mail, jobs, approvals, questions and the old session", async () => {
  const env = makeEnv(), children: { child: ChildProcess; call(op: string, args?: unknown): Promise<any> }[] = [];
  let closeApproval: (() => void) | undefined;
  const start = async (version: string, name: string) => {
    const file = join(env.home, `${name}.mjs`);
    await build({ entryPoints: [join(import.meta.dirname, "fixtures/broker-upgrade-server.ts")], outfile: file, bundle: true, platform: "node", format: "esm", logLevel: "silent",
      plugins: [{ name: "fixture-version", setup(build) { build.onLoad({ filter: /[\\/]core[\\/]constants\.ts$/ }, args => ({ contents: readFileSync(args.path, "utf8").replace(/APP_VERSION = "[^"]+"/, `APP_VERSION = "${version}"`), loader: "ts" })); } }],
    });
    const child = spawn(process.execPath, [file, env.home, name], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true,
      env: { ...process.env, AGENT_BRIDGE_HISTORY_INGEST: "0", AGENT_BRIDGE_AUTO_BACKUP: "0" } });
    let stderr = "", sequence = 0;
    child.stderr?.on("data", chunk => stderr += chunk);
    const waiting = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
    let ready!: () => void, failed!: (error: Error) => void;
    const readiness = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
    child.on("message", (message: any) => {
      if (message.ready) return ready();
      const entry = waiting.get(message.id); if (!entry) return;
      clearTimeout(entry.timer); waiting.delete(message.id);
      if (message.error) entry.reject(new Error(message.error)); else entry.resolve(message.result);
    });
    child.on("exit", () => { failed(new Error(`fixture exited: ${stderr}`)); for (const entry of waiting.values()) { clearTimeout(entry.timer); entry.reject(new Error(stderr)); } waiting.clear(); });
    const server = { child, call(op: string, args: unknown = {}) { return new Promise<any>((resolve, reject) => {
      const id = ++sequence; const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${name} ${op} timed out: ${stderr}`)); }, 15_000);
      waiting.set(id, { resolve, reject, timer }); child.send({ id, op, args });
    }); } };
    children.push(server); await readiness; return server;
  };
  const job = { id: "retained-job", name: "codex-job-retained", agent: "codex", owner: "old", status: "running", startedAt: Date.now(), prompt: "retained task" };
  try {
    const old = await start("0.30.12", "old"); expect((await old.call("status")).isBroker).toBe(true);
    writeJsonStore(join(env.home, "jobs.json"), { jobs: [job] }, null);
    const questions = new OwnerQuestionStore(env.home, nullLogger);
    const question = questions.ask({ title: "Choose retained scope", context: "Retained owner choice", topic: "handover", options: [{ id: "one", label: "One", consequence: "First", recommended: true }, { id: "two", label: "Two", consequence: "Second", recommended: false }], blocking: true, blocks: "Scope", meanwhile: "Independent work" }, env.home, { session: "old", sessionId: "old-thread", agent: "codex", main: "old" }).question;
    questions.close();
    const approval = { id: newApprovalId(), owner: "old", job: job.name, agent: "codex", tool: "exec", command: "retained operation", reason: "Owner choice", askedAt: Date.now(), deadline: Date.now() + 120_000 };
    let answer = "";
    closeApproval = await publishApproval(env.home, approval, body => { answer = body; return true; });
    const approvalBytes = readFileSync(join(env.home, "approvals", `${approval.id}.json`));
    const sent = await old.call("send", { to: "later", body: "durable queued mail" });
    const next = await start("0.30.13", "next");
    let changed = false;
    for (let i = 0; i < 100; i++) {
      const state = await next.call("status");
      if (state.isBroker && state.health.brokerVersion === "0.30.13") { changed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(changed).toBe(true);
    const oldState = await old.call("status"); expect(oldState).toMatchObject({ isBroker: false, isConnected: true });
    expect(oldState.health.brokerPid).toBe(next.child.pid);
    await old.call("send", { to: "next", body: "old session working" });
    expect((await next.call("status")).mail.some((m: any) => m.body === "old session working")).toBe(true);
    expect(readOwnerQuestions(env.home).find(q => q.id === question.id)).toMatchObject({ status: "open", title: question.title });
    expect(listPendingApprovals(env.home)).toContainEqual(approval);
    expect(readFileSync(join(env.home, "approvals", `${approval.id}.json`))).toEqual(approvalBytes);
    expect(JSON.parse(readFileSync(join(env.home, "jobs.json"), "utf8")).jobs).toContainEqual(job);
    const later = await start("0.30.13", "later");
    expect((await later.call("status")).mail).toContainEqual(expect.objectContaining({ id: sent.messages[0].id, body: "durable queued mail" }));
    const newer = await start("0.30.14", "newer");
    for (let i = 0; i < 4; i++) {
      await new Promise(resolve => setTimeout(resolve, 1_100));
      const state = await newer.call("status"); expect(state.isBroker).toBe(false);
      expect(state.health).toMatchObject({ brokerPid: next.child.pid, brokerVersion: "0.30.13", handoverPending: "upgrade cooldown" });
    }
    expect(await answerPendingApproval(env.home, approval.id, { decision: "allow" })).toBe("answered"); expect(answer).toBe("allow");
    const db = new DatabaseSync(env.db, { readOnly: true });
    try { expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok"); expect(db.prepare("SELECT body FROM messages WHERE id=?").get(sent.messages[0].id)?.body).toBe("durable queued mail"); }
    finally { db.close(); }
  } finally {
    for (const server of children.reverse()) {
      const exited = new Promise<void>(resolve => { if (server.child.exitCode !== null) resolve(); else server.child.once("exit", () => resolve()); });
      try { await server.call("stop"); } catch { server.child.kill(); }
      await exited;
    }
    closeApproval?.(); await env.cleanup();
  }
});
