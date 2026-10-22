import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageStore } from "../src/core/store.js";
import { NativeChildren } from "../src/core/native-children.js";
import { NativeLifecycleReader } from "../src/core/native-lifecycle-reader.js";
import { readProcessIdentity } from "../src/core/process-identity.js";
import { nullLogger } from "../src/core/logger.js";
import type { PeerInfo } from "../src/core/protocol.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";
import { nativeOwner } from "../src/core/recipient-ownership.js";

let env: TestEnv, store: MessageStore, children: NativeChildren, ownedChild: ChildProcess | undefined, childCreation: string | null;
const parent: PeerInfo = { id: "fixture-parent", name: "claude-fixture", agent: "claude", cwd: "", pid: process.pid,
  agentPid: null, sessionId: "fixture-session", startedAt: 1, autoWake: false };
const deadline = () => performance.now() + 1000;
beforeEach(async () => { mailOwners.clear(); env = makeEnv(); store = new MessageStore(env.db, nullLogger); children = new NativeChildren(store); await children.recover(); childCreation = null; });
afterEach(async () => {
  vi.restoreAllMocks();
  // Terminate only the direct fixture child via its own IPC handle after exact creation proof.
  if (ownedChild && ownedChild.exitCode === null && ownedChild.signalCode === null) {
    expect(await readProcessIdentity(ownedChild.pid!)).toBe(childCreation);
    const exited = once(ownedChild, "exit"); ownedChild.send("fixture-stop"); await exited;
  }
  ownedChild = undefined;
  await until(() => store.nativeLifecyclePendingReaders() === 0); store.close(); await env.cleanup();
});
const mailOwners = new Map<string, string>();
function readMail(address: string, limit: number) { return store.unread(address, limit, undefined, mailOwners.get(address) ?? nativeOwner(parent)); }
async function retainMail(address: string) {
  let owner: string;
  try { owner = children.target(address).identity; }
  catch {
    // Build retained/orphan evidence through actual native-child creation, then
    // discard only this in-memory fixture manager, never a durable route or mail.
    const fixture = new NativeChildren(store), split = address.lastIndexOf("/sub:");
    await fixture.start({ ...parent, name: address.slice(0, split), cwd: env.home }, address.slice(split + 5));
    owner = fixture.target(address).identity;
  }
  mailOwners.set(address, owner);
  store.insert({ id: "fixture-mail", from: { id: "sender", name: "codex-fixture", agent: "codex" }, to: address, recipient: address, recipientNative: owner,
    conversationId: "fixture-thread", replyTo: null, hop: 0, body: "Accepted fixture bytes", createdAt: 1, readAt: null });
}
async function deferredWrite() {
  const original = store.retryWrite.bind(store); let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(store, "retryWrite").mockImplementation(async operation => { enter(); await gate; return original(operation); });
  return { entered, release, spy };
}

describe("native active-route refusal subguard (not whole-core restart acceptance)", () => {
  it("refuses an active route and preserves retained bytes, grants, ownership and a real fixture child", async () => {
    ownedChild = spawn(process.execPath, ["-e", "process.on('message',m=>{if(m==='fixture-stop')process.exit(0)});process.send('fixture-ready')"],
      { cwd: env.home, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    await once(ownedChild, "message"); childCreation = await readProcessIdentity(ownedChild.pid!); expect(childCreation).toBeTruthy();
    const route = await children.start(parent, "native-one"); children.grant(parent, "native-one", ["codex-fixture"]); await retainMail(route.address);
    const rows = readMail(route.address, 100), routes = store.nativeChildRoutes(), owned = children.list(parent);
    children.freezeLifecycleAdmission();
    const observed = await children.settleLifecycleWrites(deadline());
    expect(observed).toMatchObject({ blocker: "native_routes_active", memoryActive: 1, durableActive: 1, pending: 0 });
    expect(await children.zeroLifecycleWitnessCurrent(observed, deadline())).toBe(false);
    expect(readMail(route.address, 100)).toEqual(rows); expect(store.nativeChildRoutes()).toEqual(routes); expect(children.list(parent)).toEqual(owned);
    expect(ownedChild.exitCode).toBeNull(); expect(await readProcessIdentity(ownedChild.pid!)).toBe(childCreation);
    await expect(children.start(parent, "late")).rejects.toHaveProperty("code", "bad_request");
    expect(() => children.grant(parent, "native-one", [])).toThrow(/draining/);
    await expect(children.end(parent, "native-one")).rejects.toThrow(/draining/);
    children.resumeLifecycleAdmission();
    expect(children.list(parent)).toEqual(owned); expect(readMail(route.address, 100)).toEqual(rows);
    expect(await children.start(parent, "after-abort")).toHaveProperty("parent", parent.name);
  });
  it("memory cleared before delayed actual end persistence is never a zero proof; settling preserves the normal mail return", async () => {
    const route = await children.start(parent, "native-one"); await retainMail(route.address); const delay = await deferredWrite();
    const ending = children.end(parent, "native-one"); await delay.entered;
    expect(children.list(parent)).toEqual([]); expect(store.nativeChildRoutes()).toHaveLength(1);
    children.freezeLifecycleAdmission();
    const timedOut = await children.settleLifecycleWrites(performance.now() + 10);
    expect(timedOut.pending).toBe(1); expect(timedOut.blocker).toBeTruthy(); expect(await children.zeroLifecycleWitnessCurrent(timedOut, deadline())).toBe(false);
    expect(readMail(route.address, 100)).toHaveLength(1);
    const settling = children.settleLifecycleWrites(deadline()); delay.release(); await ending;
    const settled = await settling; expect(settled).toMatchObject({ blocker: null, memoryActive: 0, durableActive: 0, pending: 0 });
    expect(await children.zeroLifecycleWitnessCurrent(settled, deadline())).toBe(true);
    expect(readMail(parent.name, 100)).toContainEqual(expect.objectContaining({ id: "fixture-mail", body: "Accepted fixture bytes", readAt: null, to: route.address }));
    children.resumeLifecycleAdmission();
    expect(await children.start(parent, "after-end")).toHaveProperty("parent", parent.name);
  });
  it("committed orphan mismatch after recovery refuses without running orphan recovery or retiring any row", async () => {
    store.retainNativeChild("claude-orphan/sub:one", "claude-orphan"); await retainMail("claude-orphan/sub:one");
    const fallback = vi.spyOn(store, "returnNativeChild"); children.freezeLifecycleAdmission();
    expect(await children.settleLifecycleWrites(deadline())).toMatchObject({ blocker: "native_state_unknown", memoryActive: 0, durableActive: 1 });
    expect(fallback).not.toHaveBeenCalled(); expect(store.nativeChildRoutes()).toHaveLength(1); expect(readMail("claude-orphan/sub:one", 100)).toHaveLength(1);
  });
  it("actual failed durable end latches unknown even though its memory map is empty", async () => {
    await children.start(parent, "native-one"); vi.spyOn(store, "retryWrite").mockRejectedValue(new Error("injected native persistence failure"));
    await expect(children.end(parent, "native-one")).rejects.toThrow("injected native persistence failure");
    children.freezeLifecycleAdmission();
    expect(await children.settleLifecycleWrites(deadline())).toMatchObject({ blocker: "native_state_unknown", memoryActive: 0 });
    expect(store.nativeChildRoutes()).toHaveLength(1); children.resumeLifecycleAdmission();
    expect(children.lifecycleOwnerManifest().unknown).toBe(true);
  });
  it("retained unsupported INTEGER2 cannot become a zero witness or retire its accepted mail", async () => {
    const address = "claude-retained/sub:one";
    store.retainNativeChild(address, "claude-retained"); await retainMail(address);
    const db = Reflect.get(store, "db"); db.prepare("UPDATE native_child_routes SET active=2 WHERE address=?").run(address);
    const before = db.prepare("SELECT address,parent,active,typeof(active) kind FROM native_child_routes WHERE address=?").get(address),
      mail = readMail(address, 100), fallback = vi.spyOn(store, "returnNativeChild");
    const fresh = new NativeChildren(store); await fresh.recover(); fresh.freezeLifecycleAdmission();
    const unknown = await fresh.settleLifecycleWrites(deadline());
    expect(unknown.blocker).toBe("native_state_unknown"); expect(await fresh.zeroLifecycleWitnessCurrent(unknown, deadline())).toBe(false);
    expect(fallback).not.toHaveBeenCalled(); expect(db.prepare("SELECT address,parent,active,typeof(active) kind FROM native_child_routes WHERE address=?").get(address)).toEqual(before);
    expect(readMail(address, 100)).toEqual(mail);
  });
  it("paired retained inactive INTEGER0 permits zero history without deleting or returning any mail", async () => {
    const address = "claude-retained/sub:one";
    store.retainNativeChild(address, "claude-retained"); await retainMail(address);
    const db = Reflect.get(store, "db"); db.prepare("UPDATE native_child_routes SET active=0 WHERE address=?").run(address);
    const fallback = vi.spyOn(store, "returnNativeChild"); children.freezeLifecycleAdmission();
    const zero = await children.settleLifecycleWrites(deadline()); expect(zero).toMatchObject({ blocker: null, memoryActive: 0, durableActive: 0 });
    expect(await children.zeroLifecycleWitnessCurrent(zero, deadline())).toBe(true); expect(fallback).not.toHaveBeenCalled();
    expect(db.prepare("SELECT active FROM native_child_routes WHERE address=?").get(address)?.active).toBe(0);
    expect(readMail(address, 100)).toContainEqual(expect.objectContaining({ id: "fixture-mail", body: "Accepted fixture bytes", readAt: null }));
  });
  it.each(["view", "unsupported_table"])("same-name %s is unknown, never proven object absence or writable repair", async kind => {
    const db = Reflect.get(store, "db");
    if (kind === "view") db.exec("CREATE VIEW native_child_routes AS SELECT 'claude-retained/sub:one' address,'claude-retained' parent,0 active");
    else db.exec("CREATE TABLE native_child_routes (address TEXT PRIMARY KEY,parent TEXT NOT NULL,active TEXT NOT NULL)");
    const object = db.prepare("SELECT type,sql FROM sqlite_master WHERE name='native_child_routes'").get(), fallback = vi.spyOn(store, "returnNativeChild");
    children.freezeLifecycleAdmission(); const unknown = await children.settleLifecycleWrites(deadline());
    expect(unknown.blocker).toBe("native_state_unknown"); expect(await children.zeroLifecycleWitnessCurrent(unknown, deadline())).toBe(false);
    expect(db.prepare("SELECT type,sql FROM sqlite_master WHERE name='native_child_routes'").get()).toEqual(object); expect(fallback).not.toHaveBeenCalled();
  });
  it("uppercase SQL-equivalent active table is observed after prior empty recovery, never false absence or a new fallback", async () => {
    // beforeEach completed normal recovery on an empty store. Add this retained
    // fixture afterward; no recovery operation is run against the active row.
    const address = "claude-retained/sub:one", db = Reflect.get(store, "db");
    store.retainNativeChild(address, "claude-retained"); await retainMail(address);
    db.exec("ALTER TABLE native_child_routes RENAME TO fixture_case_routes; ALTER TABLE fixture_case_routes RENAME TO NATIVE_CHILD_ROUTES");
    const row = db.prepare("SELECT address,parent,active FROM native_child_routes WHERE address=?").get(address), mail = readMail(address, 100),
      fallback = vi.spyOn(store, "returnNativeChild");
    const direct = await store.committedNativeChildRoutes(randomUUID(), 1, deadline()); expect(direct.active).toBe(1);
    children.freezeLifecycleAdmission(); const unknown = await children.settleLifecycleWrites(deadline());
    expect(unknown).toMatchObject({ blocker: "native_state_unknown", memoryActive: 0, durableActive: 1 });
    expect(await children.zeroLifecycleWitnessCurrent(unknown, deadline())).toBe(false); expect(fallback).not.toHaveBeenCalled();
    expect(db.prepare("SELECT address,parent,active FROM native_child_routes WHERE address=?").get(address)).toEqual(row); expect(readMail(address, 100)).toEqual(mail);
  });
  it("uppercase inactive history permits zero; a generated fourth column refuses instead of hiding schema extensions", async () => {
    const address = "claude-retained/sub:one", db = Reflect.get(store, "db");
    store.retainNativeChild(address, "claude-retained"); db.prepare("UPDATE native_child_routes SET active=0 WHERE address=?").run(address);
    db.exec("ALTER TABLE native_child_routes RENAME TO fixture_case_routes; ALTER TABLE fixture_case_routes RENAME TO NATIVE_CHILD_ROUTES");
    children.freezeLifecycleAdmission(); const zero = await children.settleLifecycleWrites(deadline()); expect(zero.blocker).toBeNull();
    expect(await children.zeroLifecycleWitnessCurrent(zero, deadline())).toBe(true);
    db.exec("ALTER TABLE native_child_routes ADD COLUMN fixture_extension INTEGER GENERATED ALWAYS AS (active + 1) VIRTUAL");
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name='NATIVE_CHILD_ROUTES'").get();
    const unknown = await children.settleLifecycleWrites(deadline()); expect(unknown.blocker).toBe("native_state_unknown");
    expect(await children.zeroLifecycleWitnessCurrent(unknown, deadline())).toBe(false);
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name='NATIVE_CHILD_ROUTES'").get()).toEqual(schema);
    expect(db.prepare("SELECT active,fixture_extension FROM native_child_routes WHERE address=?").get(address)).toMatchObject({ active: 0, fixture_extension: 1 });
  });
  it("an accepted implicit disconnect invalidates the frozen zero witness without suppressing normal parent-end behavior", async () => {
    children.freezeLifecycleAdmission(); const zero = await children.settleLifecycleWrites(deadline()); expect(zero.blocker).toBeNull();
    await expect(children.endParent(parent)).rejects.toThrow(/draining/);
    await children.endParent(parent, true);
    expect(await children.zeroLifecycleWitnessCurrent(zero, deadline())).toBe(false);
    children.resumeLifecycleAdmission(); await expect(children.start(parent, "late")).rejects.toThrow(/ended/);
  });
  it("the real readonly worker finds active routes among many retained inactive rows and exports only bounded counts/digest", async () => {
    store.retainNativeChild("claude-inactive/sub:one", "claude-inactive"); await store.retryWrite(() => store.returnNativeChild("claude-inactive/sub:one", "claude-inactive"));
    const db = Reflect.get(store, "db"); db.exec("BEGIN");
    try { const insert = db.prepare("INSERT INTO native_child_routes(address,parent,active) VALUES (?,?,0)"); for (let i = 0; i < 20000; i++) insert.run(`claude-inactive/sub:n${i}`, "claude-inactive"); db.exec("COMMIT"); }
    catch (error) { db.exec("ROLLBACK"); throw error; }
    await children.start(parent, "native-one"); children.freezeLifecycleAdmission();
    expect(await children.settleLifecycleWrites(deadline())).toMatchObject({ blocker: "native_routes_active", durableActive: 1 });
    const snapshot = await store.committedNativeChildRoutes(randomUUID(), 1, deadline());
    expect(Object.keys(snapshot).sort()).toEqual(["active", "digest", "generation", "ownerInstance", "requestNonce"]); expect(snapshot.active).toBe(1);
  });
  it("reader timeout retains the actual worker until exit, late results do not become eligibility, and no worker is terminated", async () => {
    const reader = new NativeLifecycleReader(), owner = randomUUID();
    const observation = reader.read(env.db, owner, 1, performance.now() + 50), worker = Reflect.get(reader, "worker");
    const emit = worker.emit.bind(worker); let publishExit: (() => void) | undefined, actualExitCode: unknown, deliveries = 0;
    // Controlled late observation only: the worker executes real SQLite and exits
    // normally. Delay delivery of its real exit event, never its execution/SQL.
    const spy = vi.spyOn(worker, "emit").mockImplementation((...args: unknown[]) => {
      if (args[0] === "exit") {
        actualExitCode = args[1];
        // Node removes these immediately after emit returns. Preserve the real
        // once wrappers, not an event replay after their removal.
        const listeners = worker.rawListeners("exit");
        publishExit = () => {
          if (deliveries++) throw new Error("fixture exit observer delivered twice");
          for (const listener of listeners) listener.call(worker, actualExitCode);
        };
        return true;
      }
      return emit(...args);
    });
    try {
      await expect(observation).rejects.toThrow("native_state_unknown");
      expect(reader.pending()).toBe(1);
      await expect(reader.read(env.db, owner, 2, deadline())).rejects.toThrow("native_state_unknown");
      await until(() => !!publishExit); expect(actualExitCode).toBe(0); expect(reader.pending()).toBe(1);
      spy.mockRestore(); publishExit!(); expect(deliveries).toBe(1); expect(reader.pending()).toBe(0);
    } finally { spy.mockRestore(); if (publishExit && !deliveries) publishExit(); }
    const fresh = await reader.read(env.db, owner, 3, deadline()); expect(fresh).toMatchObject({ active: 0, generation: 3, ownerInstance: owner });
  });
  it("actual authenticated native RPCs obey the freeze and ordinary admission returns after pre-abort", async () => {
    store.close(); const host = env.node("fixture-broker", "other"); await host.start();
    const node = env.node("claude-parent"); await node.setSessionId("fixture-native-session"); await node.start();
    const broker = Reflect.get(host, "broker"), actual: NativeChildren = Reflect.get(broker, "nativeChildren");
    await node.nativeChild({ agentId: "native-one", action: "start" }); actual.freezeLifecycleAdmission();
    expect(await actual.settleLifecycleWrites(deadline())).toMatchObject({ blocker: "native_routes_active" });
    await expect(node.nativeChild({ agentId: "late", action: "start" })).rejects.toHaveProperty("code", "bad_request");
    await expect(node.nativeChild({ agentId: "native-one", action: "grant", sendTo: [] })).rejects.toHaveProperty("code", "bad_request");
    await expect(node.nativeChild({ agentId: "native-one", action: "end" })).rejects.toHaveProperty("code", "bad_request");
    actual.resumeLifecycleAdmission(); await node.nativeChild({ agentId: "native-one", action: "end" });
    expect(await node.nativeChildren()).toEqual([]);
  });
});
