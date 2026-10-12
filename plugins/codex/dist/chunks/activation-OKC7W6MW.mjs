import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  MobileDesktopAdmin,
  MobileFault,
  MobileStore,
  digest,
  listRunsResponsive,
  readDashboard,
  secret
} from "./chunk-YOEKCU3L.mjs";
import "./chunk-AJ3G2ZXC.mjs";
import "./chunk-KQJ5KQYW.mjs";
import "./chunk-HZAGME3J.mjs";
import "./chunk-RKHYK4Q2.mjs";
import "./chunk-TUS65V4Q.mjs";
import "./chunk-ANCJAUAI.mjs";
import "./chunk-GMHMYT3Q.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-2F52LJGN.mjs";
import "./chunk-D5ZW6VFT.mjs";
import "./chunk-ZBF6WTFC.mjs";
import "./chunk-JTZGNEMM.mjs";
import "./chunk-M26SH6VN.mjs";
import "./chunk-V4WDBMEN.mjs";
import "./chunk-VIBWHOHO.mjs";
import "./chunk-6WTV3HWM.mjs";
import {
  MobileActivationFault,
  privateAddress,
  readPrivateMaterial
} from "./chunk-65FHYHTF.mjs";
import "./chunk-4QXHCXBU.mjs";
import {
  QuestionVersionConflict,
  normalizeProject,
  ownerQuestionVersion
} from "./chunk-K476F6IU.mjs";
import "./chunk-TJVQ42HE.mjs";
import {
  external_exports
} from "./chunk-FDMEMG4Z.mjs";
import "./chunk-FXWD7ZJJ.mjs";
import "./chunk-IJXRM5WK.mjs";
import "./chunk-WM3QOXKL.mjs";
import "./chunk-C5TTRWRF.mjs";
import "./chunk-B5YQVBXX.mjs";
import "./chunk-BF2F5BYX.mjs";
import "./chunk-HHAVWD7J.mjs";

// src/mobile/activation.ts
import { createPrivateKey, randomUUID as randomUUID3, X509Certificate } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { join } from "node:path";

// src/mobile/expo-push.ts
var ExpoPushProvider = class {
  constructor(accessToken, transport = fetch, now = Date.now) {
    this.accessToken = accessToken;
    this.transport = transport;
    this.now = now;
    if (!accessToken || /[\r\n]/.test(accessToken)) throw new Error("Owner-provisioned Expo enhanced push security token required");
  }
  accessToken;
  transport;
  now;
  windowAt = 0;
  submitted = 0;
  async post(path, body) {
    const result = await this.transport(`https://exp.host/--/api/v2/push/${path}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(1e4),
      headers: { authorization: `Bearer ${this.accessToken}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body)
    });
    if (result.status !== 200) return void 0;
    const text = await result.text();
    if (text.length > 32 * 1024) return void 0;
    try {
      return JSON.parse(text);
    } catch {
      return void 0;
    }
  }
  async submit(registration, hint) {
    if (this.now() - this.windowAt >= 1e3) {
      this.windowAt = this.now();
      this.submitted = 0;
    }
    if (++this.submitted > 100) return { state: "retry-later" };
    const payload = { to: registration.expoPushToken, title: "agent-bridge", body: "Open the app to review an update", data: { v: 1, notificationId: hint.data.notificationId }, ttl: 300, channelId: "owner-updates" };
    if (Buffer.byteLength(JSON.stringify(payload)) > 4096) return { state: "retry-later" };
    const result = await this.post("send", payload);
    if (result?.data?.details?.error === "DeviceNotRegistered") return { state: "device-not-registered" };
    if (result?.data?.status === "ok" && typeof result.data.id === "string" && /^[\w-]{1,128}$/.test(result.data.id)) return { state: "submitted", ticketId: result.data.id };
    return { state: "retry-later" };
  }
  async receipt(ticketId) {
    if (!/^[\w-]{1,128}$/.test(ticketId)) return { state: "failed" };
    const result = await this.post("getReceipts", { ids: [ticketId] });
    const receipt = result?.data?.[ticketId];
    if (!receipt) return { state: "pending" };
    if (receipt.details?.error === "DeviceNotRegistered") return { state: "device-not-registered" };
    return { state: receipt.status === "ok" ? "provider-accepted" : "failed" };
  }
};

// src/mobile/adapter.ts
import { createHash } from "node:crypto";
var opaqueId = (kind, parts) => createHash("sha256").update(JSON.stringify([kind, ...parts])).digest("base64url");
var version = (value) => opaqueId("version", [value]);
function projectQuestion(q, pcId) {
  return {
    id: q.id,
    kind: "question",
    pcId,
    projectId: opaqueId("project", [pcId, normalizeProject(q.project)]),
    title: q.title,
    context: q.context,
    topic: q.topic,
    options: q.options.map((o) => ({ id: o.id, label: o.label, consequence: o.consequence, recommended: o.recommended })),
    links: q.links.map((l) => ({ kind: l.kind, display: l.kind === "issue" && /^[\w-]{1,100}$/.test(l.value) ? l.value : `${l.kind} reference` })),
    blocking: q.blocking,
    blocks: q.blocks,
    meanwhile: q.meanwhile,
    destructive: q.destructive,
    authorization: q.authorization,
    urgency: q.urgency,
    declaredDefault: q.default ? { option: q.default.option, deadline: q.default.deadline } : null,
    status: q.status,
    askedAt: q.askedAt,
    version: ownerQuestionVersion(q),
    answer: q.answer ? { text: q.answer.text, ...q.answer.option ? { option: q.answer.option } : {}, at: q.answer.at, source: q.answer.source, authorLabel: q.answer.source === "owner" ? "Owner" : "Declared default" } : null,
    deliveries: q.deliveries.map((d) => ({ recipientLabel: d.recipient, state: d.state, consumedAt: d.readAt })),
    dismissal: q.dismissal ? { reason: q.dismissal.reason, at: q.dismissal.at, ...q.dismissal.supersededBy ? { replacementId: q.dismissal.supersededBy } : {} } : null
  };
}
var LocalMobileSource = class {
  constructor(ctx, questions, pcId, ready, completeAnswer, listQuestions = () => questions.list()) {
    this.ctx = ctx;
    this.questions = questions;
    this.pcId = pcId;
    this.ready = ready;
    this.completeAnswer = completeAnswer;
    this.listQuestions = listQuestions;
  }
  ctx;
  questions;
  pcId;
  ready;
  completeAnswer;
  listQuestions;
  bindings = /* @__PURE__ */ new Map();
  async snapshot() {
    if (!this.ready()) throw new MobileFault(503, "source_unavailable");
    const sampledAt = Date.now();
    const peers = (await this.ctx.peers()).filter((p) => !p.name.includes("/"));
    const runs = await listRunsResponsive(this.ctx.home);
    if (!this.ready()) throw new MobileFault(503, "source_unavailable");
    const bindings = /* @__PURE__ */ new Map();
    const sessions = peers.slice(0, 1e4).map((p) => {
      const generation = opaqueId("generation", [p.id, p.sessionId ?? null]), id2 = opaqueId("session", [this.pcId, p.id, generation]), chatId = opaqueId("chat", [id2]);
      if (p.sessionId) bindings.set(chatId, { kind: "session", nativeName: p.name, generation });
      const state = {
        id: id2,
        pcId: this.pcId,
        generation,
        name: p.name.slice(0, 160),
        agent: p.agent,
        projectId: opaqueId("project", [this.pcId, normalizeProject(p.projectRoot ?? p.cwd)]),
        activity: p.activity === "busy" || p.activity === "idle" ? p.activity : "unknown",
        connection: p.unavailable ? "unavailable" : "connected",
        parentId: null,
        chatId: p.sessionId ? chatId : null,
        sendSupported: false
      };
      return { ...state, sampledAt, version: version(state) };
    });
    const jobs = runs.slice(0, 1e4).map((r) => {
      const id2 = opaqueId("job", [this.pcId, r.name, r.startedAt]), generation = opaqueId("run", [r.name, r.startedAt]), chatId = opaqueId("chat", [id2]);
      bindings.set(id2, { kind: "job", nativeName: r.name, generation });
      bindings.set(chatId, { kind: "job", nativeName: r.name, generation });
      const state = {
        id: id2,
        pcId: this.pcId,
        projectId: r.workdir ? opaqueId("project", [this.pcId, normalizeProject(r.workdir)]) : null,
        parentId: null,
        title: (r.title ?? r.job ?? r.name).slice(0, 160),
        status: r.status,
        progress: { percent: typeof r.percent === "number" ? r.percent : null, note: r.progressNote?.slice(0, 500) ?? null, at: r.updatedAt ?? null, etaAt: r.etaAt ?? null, etaReportedAt: r.etaReportedAt ?? null },
        chatId,
        hasSteps: r.hasLog !== false,
        archived: r.archived ?? false,
        recovered: r.recovered ?? false
      };
      return { ...state, sampledAt, version: version(state) };
    });
    this.bindings = bindings;
    return { sessions, jobs, questions: this.listQuestions().slice(0, 1e4).map((q) => projectQuestion(q, this.pcId)), sampledAt, sourceState: "ready" };
  }
  async read(binding, suffix, cursor) {
    if (!this.ready()) throw new MobileFault(503, "source_unavailable");
    let context = this.ctx;
    const validateRun = async () => {
      const run = (await listRunsResponsive(this.ctx.home)).find((r) => r.name === binding.nativeName);
      if (!run || opaqueId("run", [run.name, run.startedAt]) !== binding.generation) throw new MobileFault(410, "snapshot_required");
    };
    if (binding.kind === "session") {
      const peers = await this.ctx.peers(), peer = peers.find((p) => p.name === binding.nativeName && !p.name.includes("/"));
      if (!peer || opaqueId("generation", [peer.id, peer.sessionId ?? null]) !== binding.generation) throw new MobileFault(410, "snapshot_required");
      context = { ...this.ctx, peers: () => [peer] };
    } else await validateRun();
    const path = binding.kind === "session" ? `/api/sessions/${encodeURIComponent(binding.nativeName)}/chat` : `/api/runs/${encodeURIComponent(binding.nativeName)}${suffix}`;
    const result = await readDashboard(context, { path, ...cursor ? { query: { from: cursor } } : {} });
    if (!this.ready()) throw new MobileFault(503, "source_unavailable");
    if (binding.kind === "job") await validateRun();
    if (result.status !== 200) throw new MobileFault(result.status === 409 ? 409 : result.status === 404 ? 404 : 503, "source_unavailable");
    return result.body;
  }
  async chat(id2, cursor, limit) {
    const binding = this.bindings.get(id2);
    if (!binding) throw new MobileFault(404, "unsupported");
    const result = await this.read(binding, "/chat", cursor ?? "tail");
    const items = result.items.map((item, index) => ({
      id: item.id ?? opaqueId("item", [id2, binding.generation, cursor ?? "tail", index, item.at]),
      kind: item.kind,
      at: item.at,
      ...item.text !== void 0 ? { text: item.text.slice(0, 16e3) } : {},
      ...item.tool !== void 0 ? { tool: item.tool.slice(0, 160) } : {},
      ...item.summary !== void 0 ? { summary: item.summary.slice(0, 1200) } : {},
      version: version(item),
      truncated: (item.text?.length ?? 0) > 16e3 || (item.summary?.length ?? 0) > 1200
    }));
    return { items, next: result.next && result.next !== cursor ? result.next : null, generation: binding.generation, reset: false };
  }
  async steps(id2, cursor, limit) {
    const binding = this.bindings.get(id2);
    if (!binding || binding.kind !== "job") throw new MobileFault(404, "unsupported");
    const result = await this.read(binding, "", cursor ?? "0");
    if (result.recovered || typeof result.text !== "string") throw new MobileFault(404, "unsupported");
    return {
      items: [{ id: opaqueId("step", [id2, cursor ?? "0"]), text: result.text.slice(0, 128 * 1024), at: null }],
      next: result.next !== void 0 && result.next < (result.size ?? 0) ? String(result.next) : null,
      generation: binding.generation,
      reset: false
    };
  }
  async answer(id2, body, deviceId, key) {
    if (!this.ready()) throw new MobileFault(503, "source_unavailable");
    const q = this.questions.answerMobile(id2, body, deviceId, key, { id: `owner:mobile:${deviceId}`, name: "Owner (mobile)", agent: "other" });
    const latest = this.questions.get(q.id) ?? q;
    try {
      if (!latest.deliveryComplete) this.completeAnswer?.(latest);
    } catch {
    }
    return projectQuestion(this.listQuestions().find((latest2) => latest2.id === q.id) ?? q, this.pcId);
  }
};

// src/mobile/gateway.ts
import { randomUUID as randomUUID2 } from "node:crypto";

// src/mobile/push.ts
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
var MobilePush = class {
  constructor(store, provider, encryptionKey, projectId, environment) {
    this.store = store;
    this.provider = provider;
    this.encryptionKey = encryptionKey;
    this.projectId = projectId;
    this.environment = environment;
    if (encryptionKey && encryptionKey.byteLength !== 32) throw new Error("Push encryption key must be 256 bits");
  }
  store;
  provider;
  encryptionKey;
  projectId;
  environment;
  get configured() {
    return !!(this.provider && this.encryptionKey && this.projectId && this.environment);
  }
  register(device, registration) {
    if (!this.configured) throw new MobileFault(409, "push_unsupported");
    if (this.store.get("device", device.id)?.revoked !== false) throw new MobileFault(401, "device_revoked");
    if (registration.projectId !== this.projectId || registration.environment !== this.environment || registration.platform !== device.platform) throw new MobileFault(403, "push_project_mismatch");
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(device.id));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(registration)), cipher.final()]);
    this.store.put("push", device.id, { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") });
    return { state: "registered" };
  }
  remove(deviceId, reason = "unsubscribe") {
    this.store.archivePush(deviceId, reason);
  }
  async notify(question, current) {
    if (!this.configured || question.pcId !== this.store.pcId) return [];
    const results = [];
    for (const device of this.store.list("device")) {
      const q = await current();
      const active = this.store.get("device", device.id);
      if (!q || q.status !== "open" || !active || active.revoked || !this.store.can(active, "questions.read", q.pcId, { kind: "question", id: q.id, projectId: q.projectId })) continue;
      const subscription = this.store.get("push", active.id);
      if (!subscription) continue;
      const dedupe = `${active.id}:${q.id}:${q.askedAt}`;
      if (this.store.get("push-dedupe", dedupe)) continue;
      const id2 = randomUUID();
      this.store.put("hint", id2, { id: id2, deviceId: active.id, questionId: q.id, expiresAt: this.store.now() + 3e5 });
      const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(subscription.iv, "base64"));
      decipher.setAAD(Buffer.from(active.id));
      decipher.setAuthTag(Buffer.from(subscription.tag, "base64"));
      const registration = JSON.parse(Buffer.concat([decipher.update(Buffer.from(subscription.ciphertext, "base64")), decipher.final()]).toString());
      this.store.put("push-dedupe", dedupe, { state: "unconfirmed" });
      try {
        const result = await this.provider.submit(registration, { title: "agent-bridge", body: "Open the app to review an update", data: { v: 1, notificationId: id2 }, ttl: 300 });
        if (result.state === "device-not-registered") this.store.archivePush(active.id, "provider-invalid", subscription.ciphertext);
        this.store.put("push-dedupe", dedupe, { state: result.state });
        results.push({ state: result.state });
      } catch {
        results.push({ state: "unconfirmed" });
      }
    }
    return results;
  }
  resolve(device, id2, questions) {
    const hint = this.store.get("hint", id2), q = hint && questions.find((q2) => q2.id === hint.questionId);
    if (!hint || hint.deviceId !== device.id || hint.expiresAt <= this.store.now() || !q || !this.store.can(device, "questions.read", q.pcId, { kind: "question", id: q.id, projectId: q.projectId })) throw new MobileFault(410, "notification_gone");
    return { questionId: q.id };
  }
};

// src/mobile/gateway.ts
var uuid = external_exports.string().uuid();
var id = external_exports.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
var token = external_exports.string().min(40).max(256);
var answerSchema = external_exports.object({ expectedVersion: token, option: external_exports.string().min(1).max(40).optional(), text: external_exports.string().min(1).max(8e3).optional() }).strict().refine((a) => !!a.option !== !!a.text);
var pushSchema = external_exports.object({ expoPushToken: external_exports.string().regex(/^(Expo|Exponent)PushToken\[[\w-]+\]$/).max(256), platform: external_exports.enum(["android", "ios"]), projectId: uuid, environment: external_exports.enum(["development", "production"]) }).strict();
var CAPS = ["overview.read", "chat.read", "questions.read", "questions.answer"];
var MobileGateway = class {
  constructor(store, source, push = new MobilePush(store), diagnostics = (diagnostic) => console.error(diagnostic), ready = () => true) {
    this.store = store;
    this.source = source;
    this.push = push;
    this.diagnostics = diagnostics;
    this.ready = ready;
  }
  store;
  source;
  push;
  diagnostics;
  ready;
  epoch = randomUUID2();
  views = /* @__PURE__ */ new Map();
  cursors = /* @__PURE__ */ new Map();
  rates = /* @__PURE__ */ new Map();
  sampling;
  available = true;
  inFlight = /* @__PURE__ */ new Set();
  closing;
  hello() {
    return { apiVersion: 1, capabilities: CAPS, transport: "private-https", pinning: false, send: "unsupported", pairedPcWrites: "unsupported", push: this.push.configured ? "configured" : "unsupported" };
  }
  /** Owned host retirement; no registry reads or writes after it is closed. */
  deactivate() {
    this.available = false;
    this.views.clear();
    this.cursors.clear();
  }
  /** Stop admission immediately; settle owned handlers before the host retires its stores. */
  close() {
    if (this.closing) return this.closing;
    this.deactivate();
    this.closing = (async () => {
      let timer;
      try {
        const drained = await Promise.race([
          Promise.allSettled([...this.inFlight]).then(() => true),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), 5e3);
          })
        ]);
        if (!drained) {
          try {
            this.diagnostics({ requestId: randomUUID2(), errorCategory: "gateway_shutdown_timeout" });
          } catch {
          }
          throw new MobileFault(503, "gateway_shutdown_timeout");
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    return this.closing;
  }
  rate(principal, max) {
    const now = this.store.now(), prior = this.rates.get(principal);
    if (!prior || now - prior.at >= 6e4) {
      if (this.rates.size >= 1e4) this.rates.clear();
      this.rates.set(principal, { at: now, count: 1 });
      return;
    }
    if (++prior.count > max) throw new MobileFault(429, "rate_limited");
  }
  cursor(device, kind, viewCursor, payload) {
    const key = secret();
    if (this.cursors.size >= 1e4) this.cursors.delete(this.cursors.keys().next().value);
    this.cursors.set(key, { deviceId: device.id, revision: device.revision, kind, expiresAt: this.store.now() + 24 * 60 * 6e4, viewCursor, payload });
    return key;
  }
  fromCursor(device, key, kind) {
    const c = this.cursors.get(key);
    if (!c || c.deviceId !== device.id || c.revision !== device.revision || c.kind !== kind || c.expiresAt <= this.store.now()) throw new MobileFault(410, "snapshot_required");
    return c;
  }
  recordWriteProof(principal, snapshot) {
    if (snapshot.stale) return;
    const record = this.fromCursor(principal.device, snapshot.cursor, "events");
    record.writeProof = {
      epoch: this.epoch,
      sessionId: principal.session.id,
      accessHash: principal.session.accessHash,
      grantHash: digest("grants", JSON.stringify(principal.device.grants)),
      sampledAt: snapshot.sampledAt
    };
  }
  requireWriteProof(principal, cursor, snapshot) {
    const proof = cursor ? this.fromCursor(principal.device, cursor, "events").writeProof : void 0;
    const age = proof ? this.store.now() - proof.sampledAt : Infinity;
    if (!proof || snapshot.stale || proof.epoch !== this.epoch || proof.sessionId !== principal.session.id || proof.accessHash !== principal.session.accessHash || proof.grantHash !== digest("grants", JSON.stringify(principal.device.grants)) || !Number.isFinite(age) || age < 0 || age >= 15e3)
      throw new MobileFault(409, "fresh_snapshot_required");
  }
  async sample() {
    if (!this.sampling) this.sampling = this.source.snapshot().finally(() => {
      this.sampling = void 0;
    });
    return this.deadline(this.sampling);
  }
  async deadline(work) {
    let timer;
    try {
      return await Promise.race([work, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new MobileFault(503, "source_unavailable")), 5e3);
      })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  authorized(device, kind, capability, entities) {
    return entities.filter((e) => (kind !== "question" || e.pcId === this.store.pcId) && this.store.can(device, capability, e.pcId, { kind, id: e.id, projectId: e.projectId }));
  }
  collection(device, kind, items, count, viewCursor, offset = 0, generation = this.epoch) {
    const page = items.slice(offset, offset + count);
    while (page.length > 1 && Buffer.byteLength(JSON.stringify(page)) > 480 * 1024) page.pop();
    const nextOffset = offset + page.length;
    return { items: page, next: nextOffset < items.length ? this.cursor(device, kind, viewCursor, { items, offset: nextOffset, generation }) : null, generation, reset: false, sampledAt: this.store.now(), viewCursor };
  }
  async view(principal) {
    const raw = await this.sample();
    if (!this.available) throw new MobileFault(503, "source_unavailable");
    const device = this.store.get("device", principal.device.id);
    if (!device || device.revoked) throw new MobileFault(401, "device_revoked");
    if (device.revision !== principal.device.revision) throw new MobileFault(410, "authorization_changed");
    const all = {
      sessions: this.authorized(device, "session", "overview.read", raw.sessions),
      jobs: this.authorized(device, "job", "overview.read", raw.jobs),
      questions: this.authorized(device, "question", "questions.read", raw.questions),
      sampledAt: raw.sampledAt,
      sourceState: raw.sourceState
    };
    const stale = raw.sourceState !== "ready" || this.store.now() - raw.sampledAt > 15e3;
    if (stale) {
      for (const cursor2 of this.cursors.values()) if (cursor2.deviceId === device.id) cursor2.writeProof = void 0;
    }
    const signature = digest("view", JSON.stringify([all.sessions.map((s) => [s.id, s.version]), all.jobs.map((j) => [j.id, j.version]), all.questions.map((q) => [q.id, q.version, q.deliveries]), stale, all.sourceState, device.revision]));
    const old = this.views.get(device.id);
    const oldCursor = old && this.cursors.get(old.snapshot.cursor);
    const cursor = old?.signature === signature && oldCursor && oldCursor.expiresAt > this.store.now() ? old.snapshot.cursor : this.cursor(device, "events", "");
    const capabilities = [...new Set(device.grants.flatMap((g) => g.capabilities))];
    const sessions = this.collection(device, "sessions", all.sessions, 20, cursor), jobs = this.collection(device, "jobs", all.jobs, 20, cursor), questions = this.collection(device, "questions", all.questions, 20, cursor);
    const snapshot = {
      apiVersion: 1,
      pcId: this.store.pcId,
      epoch: this.epoch,
      cursor,
      sampledAt: raw.sampledAt,
      stale,
      capabilities,
      sessions: sessions.items,
      jobs: jobs.items,
      questions: questions.items,
      pages: { sessions: sessions.next, jobs: jobs.next, questions: questions.next },
      sourceState: raw.sourceState
    };
    const result = { snapshot, all, signature, deviceRevision: device.revision };
    this.views.set(device.id, result);
    return result;
  }
  require(device, capability) {
    if (!device.grants.some((g) => g.capabilities.includes(capability))) throw new MobileFault(403, "capability_required");
  }
  async content(principal, view, entityId, kind, cursor, limit) {
    const device = principal.device;
    const parent = kind === "steps" ? view.all.jobs.find((j) => j.id === entityId) : view.all.sessions.find((s) => s.chatId === entityId) ?? view.all.jobs.find((j) => j.chatId === entityId);
    if (!parent) throw new MobileFault(404, "not_found");
    const parentKind = "generation" in parent ? "session" : "job";
    if (!this.store.can(device, kind === "chat" ? "chat.read" : "overview.read", parent.pcId, { kind: parentKind, id: parent.id, projectId: parent.projectId })) throw new MobileFault(404, "not_found");
    let remaining = [], nativeNext = null, generation = "", existing = false;
    if (cursor) {
      const c = this.fromCursor(device, cursor, `${kind}:${entityId}`);
      if (c.viewCursor !== view.snapshot.cursor) throw new MobileFault(410, "snapshot_required");
      const payload = c.payload;
      remaining = payload.remaining;
      nativeNext = payload.nativeNext;
      generation = payload.generation;
      existing = true;
    }
    if (!existing || remaining.length === 0 && nativeNext) {
      const page = kind === "chat" ? await this.deadline(this.source.chat(entityId, nativeNext ?? void 0, limit)) : await this.deadline(this.source.steps(entityId, nativeNext ?? void 0, limit));
      if (existing && generation !== page.generation || page.reset) throw new MobileFault(410, "snapshot_required");
      remaining = page.items;
      generation = page.generation;
      nativeNext = page.next;
    }
    if (!this.available) throw new MobileFault(503, "source_unavailable");
    const active = this.store.get("device", device.id);
    if (!active || active.revoked) throw new MobileFault(401, "device_revoked");
    if (active.revision !== device.revision) throw new MobileFault(410, "authorization_changed");
    const items = remaining.slice(0, limit);
    while (items.length > 1 && Buffer.byteLength(JSON.stringify(items)) > 480 * 1024) items.pop();
    const rest = remaining.slice(items.length);
    return {
      items,
      next: rest.length || nativeNext ? this.cursor(device, `${kind}:${entityId}`, view.snapshot.cursor, { remaining: rest, nativeNext, generation, entityId }) : null,
      generation,
      reset: false,
      sampledAt: this.store.now(),
      viewCursor: view.snapshot.cursor
    };
  }
  handle(req) {
    if (!this.available || !this.ready()) return this.dispatch(req);
    const work = this.dispatch(req).then((response) => this.available && this.ready() ? response : this.dispatch(req));
    this.inFlight.add(work);
    void work.then(() => this.inFlight.delete(work), () => this.inFlight.delete(work));
    return work;
  }
  async dispatch(req) {
    const requestId = randomUUID2(), headers = { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" };
    try {
      if (!this.available || !this.ready()) throw new MobileFault(503, "source_unavailable");
      const configuredOrigin = this.store.origins.find((o) => new URL(o).host === req.authority);
      if (!req.tls || !configuredOrigin) throw new MobileFault(403, "authority");
      if (req.headers.cookie || req.headers.origin && req.headers.origin !== configuredOrigin || req.headers["sec-fetch-site"] === "cross-site") throw new MobileFault(403, "origin");
      const url = new URL(req.path, configuredOrigin);
      if (url.origin !== configuredOrigin || !url.pathname.startsWith("/mobile/v1/")) throw new MobileFault(404, "not_found");
      const route = url.pathname.slice("/mobile/v1".length);
      for (const [key2] of url.searchParams) if (url.searchParams.getAll(key2).length !== 1) throw new MobileFault(400, "invalid_query");
      if (req.body && Buffer.byteLength(req.body) > 32 * 1024) throw new MobileFault(413, "body_too_large");
      if (req.method === "GET" && req.body) throw new MobileFault(400, "unexpected_body");
      const write = req.method !== "GET";
      const key = write || route.startsWith("/pairing/claims/") ? uuid.parse(req.headers["idempotency-key"]) : "";
      let body;
      if (req.body !== void 0 && req.body.length) {
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "")) throw new MobileFault(400, "json_required");
        try {
          body = JSON.parse(req.body);
        } catch {
          throw new MobileFault(400, "invalid_json");
        }
      }
      const reply = (status, result) => ({ status, headers, ...result === void 0 ? {} : { body: result } });
      const allowedQuery = (keys) => {
        for (const [key2] of url.searchParams) if (!keys.includes(key2)) throw new MobileFault(400, "invalid_query");
      };
      if (req.method === "GET" && route === "/hello") {
        allowedQuery([]);
        this.rate("hello:" + req.remoteAddress, 30);
        return reply(200, this.hello());
      }
      if (req.method === "POST" && route === "/pairing/claims") {
        allowedQuery([]);
        this.rate("pair:" + req.remoteAddress, 10);
        const args = external_exports.object({ invitationId: uuid, nonce: token, platform: external_exports.enum(["android", "ios"]), deviceName: external_exports.string().trim().min(1).max(80).regex(/^[^\x00-\x1f\x7f]+$/) }).strict().parse(body);
        return reply(202, this.store.claim(args.invitationId, args.nonce, args.deviceName, args.platform, key));
      }
      const claim = /^\/pairing\/claims\/([\w-]+)$/.exec(route);
      if (req.method === "GET" && claim) {
        allowedQuery([]);
        this.rate("poll:" + req.remoteAddress, 60);
        return reply(200, this.store.pollClaim(uuid.parse(claim[1]), this.bearer(req), key));
      }
      if (req.method === "POST" && route === "/auth/refresh") {
        allowedQuery([]);
        this.rate("refresh:" + req.remoteAddress, 30);
        if (body !== void 0) external_exports.object({}).strict().parse(body);
        return reply(200, this.store.refresh(this.bearer(req), req.headers["x-mobile-csrf"] ?? "", key));
      }
      const principal = this.store.authenticate(this.bearer(req)), device = principal.device;
      this.rate("device:" + device.id, 120);
      if (write) {
        this.store.checkCsrf(principal, req.headers["x-mobile-csrf"] ?? "");
        this.rate("write:" + device.id, 30);
      }
      if (req.method === "GET" && route === "/me") {
        allowedQuery([]);
        return reply(200, { deviceId: device.id, sessionId: principal.session.id, pcId: this.store.pcId, capabilities: [...new Set(device.grants.flatMap((g) => g.capabilities))], scopes: device.grants, accessExpiresAt: principal.session.accessExpiresAt, push: this.push.configured ? "configured" : "unsupported", pairedPcReads: "unsupported" });
      }
      if (req.method === "DELETE" && ["/me/session", "/me/push"].includes(route) || req.method === "PUT" && route === "/me/push") {
        allowedQuery([]);
        const args = req.method === "PUT" ? pushSchema.parse(body) : body === void 0 ? null : external_exports.object({}).strict().parse(body);
        const result = this.store.mutate(device.id, req.method + route, key, digest("body", JSON.stringify(args)), () => {
          if (route === "/me/session") this.store.revoke(device.id, "logout");
          else if (req.method === "DELETE") this.push.remove(device.id);
          const response = req.method === "PUT" ? this.push.register(device, args) : { state: "removed" };
          return { response, replay: response };
        });
        return reply(req.method === "PUT" ? 200 : 204, req.method === "PUT" ? result : void 0);
      }
      const view = await this.view(principal);
      if (req.method === "GET" && route === "/snapshot") {
        allowedQuery([]);
        this.recordWriteProof(principal, view.snapshot);
        return reply(200, view.snapshot);
      }
      if (req.method === "GET" && route === "/events") {
        allowedQuery(["after"]);
        const after = url.searchParams.get("after");
        if (!after) throw new MobileFault(400, "cursor_required");
        this.fromCursor(device, after, "events");
        const events = after === view.snapshot.cursor ? [] : [{ apiVersion: 1, epoch: this.epoch, cursor: view.snapshot.cursor, type: "snapshot.required", resource: { kind: "snapshot", id: this.store.pcId }, version: view.signature, at: view.snapshot.sampledAt }];
        return reply(200, { events, next: view.snapshot.cursor, sampledAt: view.snapshot.sampledAt, reset: events.length > 0 });
      }
      const list = route.slice(1);
      if (req.method === "GET" && ["sessions", "jobs", "questions"].includes(list)) {
        allowedQuery(list === "questions" ? ["cursor", "limit", "status"] : ["cursor", "limit"]);
        this.require(device, list === "questions" ? "questions.read" : "overview.read");
        const limit = this.limit(url), cursor = url.searchParams.get("cursor"), status = url.searchParams.get("status");
        if (status && !["open", "answered", "cancelled", "superseded"].includes(status)) throw new MobileFault(400, "invalid_status");
        const kind = `${list}${status ? ":" + status : ""}`;
        if (cursor) {
          const c = this.fromCursor(device, cursor, kind);
          if (c.viewCursor !== view.snapshot.cursor) throw new MobileFault(410, "snapshot_required");
          const payload = c.payload;
          return reply(200, this.collection(device, kind, payload.items, limit, view.snapshot.cursor, payload.offset, payload.generation));
        }
        const items = list === "sessions" ? view.all.sessions : list === "jobs" ? view.all.jobs : view.all.questions.filter((q) => !status || q.status === status);
        return reply(200, this.collection(device, kind, items, limit, view.snapshot.cursor));
      }
      const question = /^\/questions\/([\w-]+)(\/answer)?$/.exec(route);
      if (question) {
        allowedQuery([]);
        const q = view.all.questions.find((q2) => q2.id === question[1]);
        if (!q) throw new MobileFault(404, "not_found");
        if (req.method === "GET" && !question[2]) return reply(200, q);
        if (req.method === "POST" && question[2]) {
          const args = answerSchema.parse(body);
          if (q.status === "open" && q.version === args.expectedVersion && args.option && !q.options.some((o) => o.id === args.option)) throw new MobileFault(400, "unknown_option");
          const active = this.store.authenticate(this.bearer(req));
          this.store.checkCsrf(active, req.headers["x-mobile-csrf"] ?? "");
          if (active.device.revision !== device.revision) throw new MobileFault(410, "authorization_changed");
          if (!this.store.can(active.device, "questions.answer", q.pcId, { kind: "question", id: q.id, projectId: q.projectId }) || q.pcId !== this.store.pcId) throw new MobileFault(404, "not_found");
          this.requireWriteProof(active, req.headers["x-mobile-view"], view.snapshot);
          const result = await this.deadline(this.source.answer(q.id, args, device.id, key));
          return reply(200, { question: result, replayExpiresAt: this.store.now() + 24 * 60 * 6e4 });
        }
      }
      const chat = /^\/chats\/([\w-]+)$/.exec(route), steps = /^\/jobs\/([\w-]+)\/steps$/.exec(route);
      if (req.method === "GET" && (chat || steps)) {
        allowedQuery(["cursor", "limit"]);
        const entity = id.parse(chat?.[1] ?? steps?.[1]);
        return reply(200, await this.content(principal, view, entity, chat ? "chat" : "steps", url.searchParams.get("cursor"), this.limit(url)));
      }
      const hint = /^\/notifications\/([\w-]+)$/.exec(route);
      if (req.method === "GET" && hint) {
        allowedQuery([]);
        return reply(200, this.push.resolve(device, uuid.parse(hint[1]), view.all.questions));
      }
      throw new MobileFault(404, "unsupported");
    } catch (error) {
      if (!(error instanceof MobileFault) && !(error instanceof QuestionVersionConflict) && !(error instanceof external_exports.ZodError)) {
        try {
          this.diagnostics({ requestId, errorCategory: "unexpected_gateway_exception" });
        } catch {
        }
      }
      const fault = error instanceof MobileFault ? error : error instanceof QuestionVersionConflict ? new MobileFault(409, "version_conflict", error.currentVersion) : error instanceof external_exports.ZodError ? new MobileFault(400, "invalid_request") : new MobileFault(503, "source_unavailable");
      if (fault.status === 202) return { status: 202, headers, body: { state: "pending" } };
      return { status: fault.status, headers: { ...headers, ...fault.status === 429 ? { "retry-after": "60" } : {} }, body: { code: fault.code, message: fault.code.replaceAll("_", " "), requestId, retryable: fault.status === 503 || fault.status === 429, ...fault.currentVersion ? { currentVersion: fault.currentVersion } : {} } };
    }
  }
  bearer(req) {
    const match = /^Bearer ([A-Za-z0-9_-]{40,256})$/.exec(req.headers.authorization ?? "");
    if (!match) throw new MobileFault(401, "unauthorized");
    return match[1];
  }
  limit(url) {
    const raw = url.searchParams.get("limit") ?? "20";
    if (!/^\d{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > 100) throw new MobileFault(400, "invalid_limit");
    return Number(raw);
  }
};

// src/mobile/bootstrap.ts
function provisionMobile(options) {
  if (!options.origins.length) throw new Error("Owner must provision LAN/Tailscale trusted HTTPS origins");
  const store = new MobileStore(options.registryFile, options.pcId, options.origins[0], Date.now, options.origins.slice(1));
  let closed = false, closing;
  const ready = () => !closed && options.ready();
  const source = new LocalMobileSource(
    options.local,
    options.ownerQuestions.store,
    options.pcId,
    ready,
    (q) => options.ownerQuestions.complete(q),
    () => options.ownerQuestions.list()
  );
  const push = options.push ? new MobilePush(store, options.push.provider, options.push.encryptionKey, options.push.projectId, options.push.environment) : new MobilePush(store);
  const gateway = new MobileGateway(store, source, push, void 0, ready), desktopAdmin = new MobileDesktopAdmin(store, source, options.desktopOrigin, ready);
  let hintPoll;
  return { gateway, desktopAdmin, close: () => {
    if (closing) return closing;
    closed = true;
    gateway.deactivate();
    closing = (async () => {
      try {
        const settled = await Promise.allSettled([gateway.close(), hintPoll ?? Promise.resolve()]);
        const failed = settled[0];
        if (failed.status === "rejected") throw failed.reason;
      } finally {
        store.close();
      }
    })();
    return closing;
  }, pollQuestionHints: () => {
    if (hintPoll) return hintPoll;
    hintPoll = (async () => {
      if (!push.configured || !ready()) return;
      const view = await source.snapshot();
      for (const question of view.questions.filter((q) => q.status === "open")) {
        await push.notify(question, async () => {
          if (!ready()) return void 0;
          return (await source.snapshot()).questions.find((q) => q.id === question.id);
        });
      }
    })().finally(() => {
      hintPoll = void 0;
    });
    return hintPoll;
  } };
}

// src/mobile/https.ts
import { createServer } from "node:https";
function createMobileHttpsServer(gateway, tls) {
  if (!tls.key || !tls.cert) throw new Error("Owner-provisioned trusted TLS certificate/key required");
  const server = createServer({ ...tls, minVersion: "TLSv1.2" }, (req, res) => {
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) {
        res.writeHead(400, { "cache-control": "no-store" });
        res.end();
        return;
      }
      headers[key] = value;
    }
    for (const header of ["authorization", "host", "origin", "idempotency-key", "x-mobile-csrf", "x-mobile-view", "content-type"])
      if (req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === header).length > 1) {
        res.writeHead(400);
        res.end();
        return;
      }
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 32 * 1024) {
        res.writeHead(413, { "cache-control": "no-store" });
        res.end();
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      void gateway.handle({
        method: req.method ?? "",
        path: req.url ?? "",
        headers,
        body: chunks.length ? Buffer.concat(chunks).toString("utf8") : void 0,
        authority: req.headers.host ?? "",
        tls: true,
        remoteAddress: req.socket.remoteAddress ?? "unknown"
      }).then((result) => {
        const json = result.body === void 0 ? "" : JSON.stringify(result.body);
        if (Buffer.byteLength(json) > 512 * 1024) {
          res.writeHead(413, { "cache-control": "no-store" });
          res.end(JSON.stringify({ code: "response_too_large" }));
          return;
        }
        res.writeHead(result.status, result.headers);
        res.end(json);
      }).catch(() => {
        res.writeHead(503, { "cache-control": "no-store" });
        res.end(JSON.stringify({ code: "unavailable" }));
      });
    });
  });
  server.requestTimeout = 1e4;
  server.headersTimeout = 1e4;
  server.maxConnections = 32;
  return server;
}
function createMobileHttpsListeners(gateway, configs) {
  if (configs.length < 1 || configs.length > 8) throw new Error("Supply one to eight owner-provisioned private listeners");
  return configs.map((config) => {
    if (!gateway.store.origins.includes(config.origin) || !config.bindAddress || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || ["0.0.0.0", "::"].includes(config.bindAddress)) throw new Error("Exact approved private bind address/hostname and HTTPS origin required");
    return { config, server: createMobileHttpsServer(gateway, config.tls) };
  });
}

// src/mobile/host.ts
async function prepareMobileDesktopHost(node, config) {
  const context = node.mobileHostContext();
  if (!context?.ready()) throw new MobileFault(503, "source_unavailable");
  let closed = false, closing, unregister = () => {
  };
  const ready = () => !closed && context.ready();
  const mobile = provisionMobile({ ...config, local: context.local, ownerQuestions: context.ownerQuestions, ready });
  let listeners = [];
  const close = () => {
    if (closing) return closing;
    closed = true;
    mobile.gateway.deactivate();
    closing = (async () => {
      const failures = [];
      try {
        const settled = await Promise.allSettled(listeners.map(({ server }) => new Promise((resolve, reject) => {
          server.closeAllConnections();
          if (!server.listening) {
            resolve();
            return;
          }
          server.close((error) => error ? reject(error) : resolve());
        })));
        for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
      } finally {
        try {
          await mobile.close();
        } catch (error) {
          failures.push(error);
        } finally {
          unregister();
        }
      }
      if (failures.length) throw new AggregateError(failures, "mobile_host_disposal_failed");
    })();
    return closing;
  };
  try {
    if (config.listeners?.length) listeners = createMobileHttpsListeners(mobile.gateway, config.listeners);
    for (const { server } of listeners) server.on("listening", () => {
      if (!ready()) {
        server.closeAllConnections();
        server.close();
      }
    });
    unregister = context.onDispose(close);
    if (!ready()) throw new MobileFault(503, "source_unavailable");
    return { gateway: mobile.gateway, desktopAdmin: mobile.desktopAdmin, listeners, pollQuestionHints: mobile.pollQuestionHints, ready, close };
  } catch (error) {
    await close();
    throw error;
  }
}

// src/mobile/activation.ts
function validateMobileTls(cert, key, hostname) {
  try {
    const x509 = new X509Certificate(cert), now = Date.now(), from = Date.parse(x509.validFrom), to = Date.parse(x509.validTo);
    hostname = hostname.replace(/^\[|\]$/g, "");
    if (!Number.isFinite(from) || !Number.isFinite(to) || now < from || now >= to || !x509.checkPrivateKey(createPrivateKey(key)) || !(isIP(hostname) ? x509.checkIP(hostname) : x509.checkHost(hostname, { wildcards: false }))) throw new Error();
  } catch {
    throw new MobileActivationFault("tls_invalid");
  }
}
var MobileActivation = class {
  constructor(node, config, options, deps = {}) {
    this.node = node;
    this.config = config;
    this.options = options;
    this.deps = deps;
  }
  node;
  config;
  options;
  deps;
  starting;
  closing;
  retiring;
  disposal;
  prepared;
  desktop;
  unregister;
  poll;
  retired = false;
  state = "preparing";
  status = () => this.state === "ready" && !this.prepared?.ready() ? "source_unavailable" : this.state;
  start() {
    return this.starting ??= this.open();
  }
  diagnostic(errorCategory) {
    try {
      this.options.log.warn("mobile unavailable", { requestId: randomUUID3(), errorCategory });
    } catch {
    }
  }
  async open() {
    try {
      if ("invalid" in this.config) throw new MobileActivationFault("config_invalid");
      if (!Number.isInteger(this.options.port) || this.options.port < 1 || this.options.port > 65535) throw new MobileActivationFault("config_invalid");
      if (!this.node.isBroker || this.retired) throw new MobileActivationFault("source_unavailable");
      const material = this.deps.material ?? readPrivateMaterial;
      const listeners = [];
      for (const listener of this.config.listeners) {
        const addresses = isIP(listener.bindAddress) ? [listener.bindAddress] : await (this.deps.addresses ?? (async (name) => (await lookup(name, { all: true })).map((r) => r.address)))(listener.bindAddress);
        if (!addresses.length || addresses.some((address) => !privateAddress(address))) throw new MobileActivationFault("bind_invalid");
        const cert = await material(listener.certFile), key = await material(listener.keyFile);
        (this.deps.validateTls ?? validateMobileTls)(cert, key, new URL(listener.origin).hostname);
        listeners.push({ origin: listener.origin, bindAddress: addresses[0], port: listener.port, tls: { cert, key } });
      }
      let push;
      if (this.config.push) {
        try {
          const raw = await material(this.config.push.materialRef), parsed = JSON.parse(raw.toString("utf8"));
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
          const value = parsed;
          if (Object.keys(value).sort().join(",") !== "accessToken,encryptionKey" || typeof value.accessToken !== "string" || !value.accessToken || value.accessToken.length > 4096 || /[\r\n]/.test(value.accessToken) || typeof value.encryptionKey !== "string") throw new Error();
          const encryptionKey = Buffer.from(value.encryptionKey, "base64");
          if (encryptionKey.length !== 32 || encryptionKey.toString("base64") !== value.encryptionKey) throw new Error();
          push = {
            provider: (this.deps.provider ?? ((token2) => new ExpoPushProvider(token2)))(value.accessToken),
            encryptionKey,
            projectId: this.config.push.projectId,
            environment: this.config.push.environment
          };
          raw.fill(0);
        } catch {
          throw new MobileActivationFault("material_unavailable");
        }
      }
      if (this.retired || !this.node.initializeMobileOwnerQuestions()) throw new MobileActivationFault("source_unavailable");
      this.prepared = await (this.deps.prepare ?? prepareMobileDesktopHost)(this.node, {
        registryFile: join(this.options.home, "mobile.db"),
        pcId: this.config.pcId,
        origins: this.config.origins,
        desktopOrigin: `http://127.0.0.1:${this.options.port}`,
        listeners,
        ...push ? { push } : {}
      });
      if (this.retired || !this.prepared.ready()) throw new MobileActivationFault("source_unavailable");
      const context = this.node.mobileHostContext();
      if (!context?.ready()) throw new MobileActivationFault("source_unavailable");
      this.unregister = context.onDispose(() => this.retireMobile());
      const factory = this.deps.desktop ?? ((options) => {
        throw new Error("desktop_factory_required");
      });
      this.desktop = factory({ ...this.options, mobileAdmin: this.prepared.desktopAdmin, mobileStatus: this.status });
      const info = await this.desktop.ensure();
      for (const { config, server } of this.prepared.listeners) {
        if (this.retired || !this.prepared.ready()) throw new MobileActivationFault("source_unavailable");
        await new Promise((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timer);
            server.off("error", failed);
            server.off("listening", done);
          };
          const done = () => {
            cleanup();
            resolve();
          }, failed = () => {
            cleanup();
            reject(new MobileActivationFault("restart_required"));
          };
          const timer = setTimeout(failed, 5e3);
          server.once("error", failed);
          server.once("listening", done);
          try {
            server.listen(config.port, config.bindAddress);
          } catch {
            failed();
          }
        });
        server.on("error", () => {
          this.state = "restart_required";
          this.diagnostic(this.state);
          void this.retireMobile();
        });
      }
      if (this.retired || !this.prepared.ready()) throw new MobileActivationFault("source_unavailable");
      this.state = "ready";
      if (push) {
        this.poll = setInterval(() => {
          if (this.status() === "ready") void this.prepared?.pollQuestionHints().catch(() => this.diagnostic("source_unavailable"));
        }, 2e3);
        this.poll.unref();
      }
      return info;
    } catch (error) {
      this.state = error instanceof MobileActivationFault ? error.category : "restart_required";
      this.diagnostic(this.state);
      this.retired = true;
      await this.disposeOwned();
      return void 0;
    }
  }
  close() {
    if (this.closing) return this.closing;
    void this.retireMobile();
    this.closing = this.disposeOwned();
    return this.closing;
  }
  retireMobile() {
    if (this.retiring) return this.retiring;
    this.retired = true;
    if (this.state === "ready" || this.state === "preparing") this.state = "source_unavailable";
    if (this.poll) clearInterval(this.poll);
    this.poll = void 0;
    this.prepared?.gateway.deactivate();
    this.retiring = this.disposeOwned(false);
    return this.retiring;
  }
  disposeOwned(closeDesktop = true) {
    const prepared = this.prepared, desktop = this.desktop;
    if (this.disposal && this.disposal.prepared === prepared && this.disposal.desktop === desktop && this.disposal.closeDesktop === closeDesktop) return this.disposal.work;
    const work = this.settleOwned(prepared, closeDesktop ? desktop : void 0, this.unregister);
    this.disposal = { prepared, desktop, closeDesktop, work };
    return work;
  }
  async settleOwned(prepared, desktop, unregister) {
    prepared?.gateway.deactivate();
    let timer;
    try {
      const settled = await Promise.race([
        Promise.allSettled([prepared?.close() ?? Promise.resolve(), desktop?.close() ?? Promise.resolve()]),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(void 0), 5e3);
        })
      ]);
      if (!settled || settled.some((r) => r.status === "rejected")) {
        this.state = "restart_required";
        this.diagnostic(this.state);
      }
    } finally {
      if (timer) clearTimeout(timer);
      unregister?.();
      if (this.unregister === unregister) this.unregister = void 0;
    }
  }
};
async function configuredMobileDashboard(node, config, options, deps = {}) {
  if (!config) return void 0;
  const desktop = deps.desktop ?? (await import("./dashboard-CVEW7YN6.mjs")).createConfiguredMobileDashboard;
  return new MobileActivation(node, config, options, { ...deps, desktop });
}
export {
  MobileActivation,
  configuredMobileDashboard,
  validateMobileTls
};
