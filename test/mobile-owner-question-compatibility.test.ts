import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { buildSync } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { OwnerQuestionStore, ownerQuestionVersion, QUESTIONS_FILE, QuestionVersionConflict } from "../src/core/owner-questions.js";
import { OwnerQuestionStore as V1Store } from "./fixtures/mobile-owner-questions-v1.js";

// Pinned a679e53746640c04094070730fb8a29558e1e985 source, blob
// c45efa2eb796121f18c36eb2d039a9b2e8387cf7. Only four import paths are relocated.
const pinnedSha256 = "d80cd4aab73404de3029084774589e5d9377bd31d3d404d7e45b7c479cdae885";
const asker = { session: "fixture", sessionId: "fixture-session", main: "fixture-main", agent: "codex" as const };
const author = { id: "owner:fixture", name: "Fixture owner", agent: "other" as const };
const ask = (topic: string) => ({ title: "Choose scope", topic, context: "Synthetic compatibility question", options: [
  { id: "keep", label: "Keep", consequence: "Preserves scope", recommended: true },
  { id: "wait", label: "Wait", consequence: "Defers scope", recommended: false },
], blocking: true, blocks: "Synthetic action", meanwhile: "Read source" });
let home: string;
const closers: (() => void)[] = [];
beforeEach(() => {
  const root = resolve(".agent-bridge-test/mobile-owner-compatibility");
  mkdirSync(root, { recursive: true }); home = mkdtempSync(join(root, "run-"));
});
afterEach(() => { for (const close of closers.splice(0).reverse()) close(); });
function mobile() { const store = new OwnerQuestionStore(home, nullLogger); closers.push(() => store.close()); return store; }
function legacy() { const store = new V1Store(home, nullLogger); closers.push(() => store.close()); return store; }
function inspect() { const db = new DatabaseSync(join(home, QUESTIONS_FILE), { readOnly: true }); closers.push(() => db.close()); return db; }
function closeHandles() { for (const close of closers.splice(0).reverse()) close(); }

describe("retained owner-question v1 writers", () => {
  it("pins pre-mobile store behavior rather than substituting a version-only stub", () => {
    const fixture = readFileSync(join(import.meta.dirname, "fixtures/mobile-owner-questions-v1.ts"), "utf8")
      .replaceAll("\r\n", "\n").replaceAll('"../../src/core/', '"./');
    expect(createHash("sha256").update(fixture).digest("hex")).toBe(pinnedSha256);
  });

  it("lets a v1-expecting handle open, read and write after a mobile answer", () => {
    const current = mobile(), q = current.ask(ask("mobile-first"), home, asker, 1).question;
    const body = { expectedVersion: ownerQuestionVersion(q), option: "keep" }, key = randomUUID();
    const answered = current.answerMobile(q.id, body, "device", key, author, 2);
    const old = legacy(); // This constructor really targets v1 and rejects v2.
    expect(old.get(q.id)).toEqual(answered);
    expect(old.list()).toHaveLength(1);
    const desktop = old.ask(ask("desktop-after-mobile"), home, asker, 3).question;
    expect(old.answer(desktop.id, { text: "Written by retained v1" }, author, 4).answer?.text).toBe("Written by retained v1");
    expect(current.get(desktop.id)?.status).toBe("answered");
    expect(old.claimAlert(desktop.id, "fixture", 5, 0)).toBe(true);
    const cancelled = old.ask(ask("cancel-after-mobile"), home, asker, 6).question;
    old.dismiss(cancelled.id, "cancelled", "Fixture cancellation");
    expect(current.get(cancelled.id)?.status).toBe("cancelled");
    expect(inspect().prepare("PRAGMA user_version").get()?.user_version).toBe(1);
  });

  it("supports an already-open v1 handle while adding the independent replay table", () => {
    const old = legacy(), q = old.ask(ask("legacy-first"), home, asker, 1).question;
    const before = inspect().prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const current = mobile();
    const answered = current.answerMobile(q.id, { expectedVersion: ownerQuestionVersion(q), option: "wait" }, "device", randomUUID(), author, 2);
    expect(old.get(q.id)).toEqual(answered);
    const after = inspect().prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND tbl_name!='mobile_question_answers' ORDER BY name").all();
    expect(after).toEqual(before); // Original tables/index and their SQL survive unchanged.
    const later = old.ask(ask("still-writing"), home, asker, 3).question;
    old.answer(later.id, { option: "keep" }, author, 4);
    expect(current.get(later.id)?.answer?.option).toBe("keep");
  });

  it("retains exact replay indefinitely across reopening and legacy delivery updates", () => {
    const old = legacy(), current = mobile(), q = old.ask(ask("durable"), home, asker, 1).question;
    const body = { expectedVersion: ownerQuestionVersion(q), text: "  Exact answer\n猫  " }, key = randomUUID();
    const original = current.answerMobile(q.id, body, "device", key, author, 2);
    old.save({ ...old.get(q.id)!, deliveryComplete: true, mirror: { state: "saved", issues: ["fixture"] } });
    closeHandles();
    const reopened = mobile(), retained = legacy();
    expect(reopened.answerMobile(q.id, body, "device", key, author, 10 * 365 * 24 * 3600 * 1000)).toEqual(original);
    expect(retained.get(q.id)?.deliveryComplete).toBe(true);
    expect(retained.get(q.id)?.mirror?.state).toBe("saved");
    expect(() => reopened.answerMobile(q.id, { ...body, text: "Changed" }, "device", key, author)).toThrow(QuestionVersionConflict);
    expect(inspect().prepare("SELECT count(*) AS n FROM mobile_question_answers").get()?.n).toBe(1);
    expect(inspect().prepare("SELECT count(*) AS n FROM question_events").get()?.n).toBe(3);
  });

  it("rejects stale mobile CAS after retained writers revise terms or apply a default", () => {
    const old = legacy(), current = mobile(), q = old.ask(ask("changed-terms"), home, asker, 1).question;
    const stale = ownerQuestionVersion(q);
    old.save({ ...q, context: "Revised by retained writer" });
    expect(() => current.answerMobile(q.id, { expectedVersion: stale, option: "keep" }, "device", randomUUID(), author)).toThrow(QuestionVersionConflict);
    const defaultQuestion = old.ask({ ...ask("legacy-default"), default: { option: "wait", deadline: 3 } }, home, asker, 2).question;
    old.answer(defaultQuestion.id, { option: "wait" }, author, 3, "declared-default");
    expect(() => current.answerMobile(defaultQuestion.id, { expectedVersion: ownerQuestionVersion(defaultQuestion), option: "keep" }, "device", randomUUID(), author)).toThrow(QuestionVersionConflict);
    expect(current.get(defaultQuestion.id)?.answer?.source).toBe("declared-default");
    expect(inspect().prepare("SELECT count(*) AS n FROM mobile_question_answers").get()?.n).toBe(0);
  });

  it("serializes real simultaneous SQLite writers from independent worker handles", async () => {
    const old = legacy(), q = old.ask(ask("concurrent"), home, asker, 1).question;
    mobile();
    const moduleFile = join(home, "current-store.cjs");
    buildSync({ entryPoints: [resolve("src/core/owner-questions.ts")], outfile: moduleFile, bundle: true, platform: "node", format: "cjs", logLevel: "silent" });
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT), workers: Worker[] = [];
    let ready = 0;
    const program = `
      const { parentPort, workerData } = require('node:worker_threads');
      const { OwnerQuestionStore, QuestionVersionConflict } = require(workerData.moduleFile);
      const log = { info() {}, warn() {}, error() {}, debug() {} };
      const store = new OwnerQuestionStore(workerData.home, log);
      parentPort.postMessage({ ready: true });
      Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
      try {
        const answer = store.answerMobile(workerData.id, workerData.body, 'device', workerData.key, workerData.author, 2);
        parentPort.postMessage({ outcome: 'answered', option: answer.answer.option });
      } catch (error) {
        parentPort.postMessage({ outcome: error instanceof QuestionVersionConflict ? 'conflict' : 'error', message: error.message });
      } finally { store.close(); }
    `;
    try {
      const results = await Promise.all(["keep", "wait"].map(option => new Promise<{ outcome: string }>((resolveResult, reject) => {
        const worker = new Worker(program, { eval: true, workerData: { moduleFile, home, barrier, id: q.id, body: { expectedVersion: ownerQuestionVersion(q), option }, key: randomUUID(), author } });
        workers.push(worker);
        let finished = false;
        worker.on("message", message => {
          if (message.ready) {
            if (++ready === 2) { Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0, 2); }
          } else { finished = true; resolveResult(message); }
        });
        worker.on("error", reject);
        worker.on("exit", code => { if (!finished) reject(new Error(`Fixture writer exited before result (${code})`)); });
      })));
      expect(results.map(result => result.outcome).sort()).toEqual(["answered", "conflict"]);
      expect(old.get(q.id)?.status).toBe("answered");
      expect(inspect().prepare("SELECT count(*) AS n FROM mobile_question_answers").get()?.n).toBe(1);
      expect(inspect().prepare("SELECT count(*) AS n FROM question_events").get()?.n).toBe(2);
    } finally { await Promise.all(workers.map(worker => worker.terminate())); }
  });

  it("rolls back answer, event and replay together and reopens for both writer versions", () => {
    const old = legacy(), current = mobile(), q = old.ask(ask("rollback"), home, asker, 1).question;
    const key = randomUUID(), body = { expectedVersion: ownerQuestionVersion(q), option: "keep" };
    const fault = new DatabaseSync(join(home, QUESTIONS_FILE));
    try { fault.exec(`CREATE TRIGGER fixture_replay_failure BEFORE INSERT ON mobile_question_answers WHEN NEW.replay_key='${key}' BEGIN SELECT RAISE(ABORT,'fixture replay failure'); END;`); }
    finally { fault.close(); }
    expect(() => current.answerMobile(q.id, body, "device", key, author, 2)).toThrow("fixture replay failure");
    expect(old.get(q.id)).toEqual(q);
    closeHandles();
    const reopened = mobile(), retained = legacy();
    expect(retained.get(q.id)).toEqual(q);
    expect(inspect().prepare("SELECT count(*) AS n FROM question_events").get()?.n).toBe(1);
    expect(inspect().prepare("SELECT count(*) AS n FROM mobile_question_answers").get()?.n).toBe(0);
    const goodKey = randomUUID(), result = reopened.answerMobile(q.id, body, "device", goodKey, author, 3);
    expect(retained.get(q.id)).toEqual(result);
    closeHandles();
    expect(mobile().answerMobile(q.id, body, "device", goodKey, author, 4)).toEqual(result);
  });

  it("rejects a fresh synthetic v2 witness without downgrading, altering or recreating it", () => {
    // New witness only: previously-created v2 fixtures are never opened or changed.
    const file = join(home, QUESTIONS_FILE), db = new DatabaseSync(file);
    db.exec("CREATE TABLE retained_witness(body TEXT); INSERT INTO retained_witness VALUES('preserve'); PRAGMA user_version=2"); db.close();
    const before = readFileSync(file);
    expect(() => new OwnerQuestionStore(home, nullLogger)).toThrow("unsupported SQLite store version: 2");
    expect(() => new V1Store(home, nullLogger)).toThrow("unsupported SQLite store version: 2");
    expect(readFileSync(file)).toEqual(before);
    const witness = inspect();
    expect(witness.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
    expect(witness.prepare("SELECT body FROM retained_witness").get()?.body).toBe("preserve");
    expect(witness.prepare("SELECT name FROM sqlite_master WHERE name='mobile_question_answers'").get()).toBeUndefined();
  });
});
