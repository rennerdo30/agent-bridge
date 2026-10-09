import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  PairingStore,
  RemoteDashboard,
  commitHandoff,
  dashboardError,
  decodePairingCode,
  handoffJournal,
  handoffSchema,
  keyFingerprint,
  loadDashboardKey,
  publicIdentitySchema,
  readDashboardInfo
} from "./chunk-DGKITLFP.mjs";
import {
  ProjectGroups
} from "./chunk-3DYEFRB7.mjs";
import "./chunk-QATH7RVR.mjs";
import "./chunk-NDSL2QRY.mjs";
import "./chunk-TDDBZU3H.mjs";
import {
  agentQueueKey,
  registrationIdentity
} from "./chunk-NFIHLAEA.mjs";
import "./chunk-IOIPB67O.mjs";
import {
  FILE_STREAM_CAPABILITY,
  FILE_STREAM_WINDOW_CAPABILITY,
  MAX_STREAM_ENTRIES,
  TRANSFER_WINDOW_CHUNKS,
  TransferManager,
  cancelStoredTransfer,
  collectTransfer,
  readTransferHistory,
  receiveTransfer,
  transferResultSchema,
  transferSchema
} from "./chunk-GLRU4LAP.mjs";
import {
  isInside,
  resumeArgs
} from "./chunk-2YOSUVFR.mjs";
import "./chunk-C4QOXXP6.mjs";
import "./chunk-KNKN5CEU.mjs";
import "./chunk-IOGZQ3DT.mjs";
import {
  CONTROL_CONVERSATION_PREFIX,
  JobRunners,
  readRunnerState
} from "./chunk-B2UEDMHR.mjs";
import "./chunk-LZRVUOSK.mjs";
import "./chunk-BG6KJS4H.mjs";
import "./chunk-2K7NH5JP.mjs";
import "./chunk-4TPWQAFL.mjs";
import {
  HealthMonitor
} from "./chunk-FHJRNC7V.mjs";
import "./chunk-VMLMAYUW.mjs";
import "./chunk-RQUYBZWF.mjs";
import {
  MAX_REMOTE_JOBS,
  REMOTE_JOB_CANCELLED_CAPABILITY,
  REMOTE_JOB_CAPABILITY,
  REMOTE_JOB_FRAME,
  REMOTE_JOB_RATE_LIMIT,
  REMOTE_JOB_RATE_WINDOW_MS,
  REMOTE_JOB_REQUEST_TIMEOUT_MS,
  REMOTE_JOB_SPAWN_LIMIT,
  remoteJobRequestSchema,
  remoteJobSnapshotSchema,
  remoteJobWireSchema,
  remoteSnapshotForPeer
} from "./chunk-2B56UVWZ.mjs";
import {
  readConversation
} from "./chunk-P2Z3IUMC.mjs";
import "./chunk-UMUM47DU.mjs";
import "./chunk-EBWRANMT.mjs";
import {
  HISTORY_IO_BYTES_PER_SECOND,
  historyDbPath,
  releaseExitedHistoryLease
} from "./chunk-K2G7MFNA.mjs";
import {
  conversationPageSchema
} from "./chunk-3CXCL26P.mjs";
import {
  historySearchSchema
} from "./chunk-F7FSK2FI.mjs";
import "./chunk-4GJUIXBN.mjs";
import "./chunk-HZAGME3J.mjs";
import "./chunk-JWVT32AI.mjs";
import {
  createWorktree,
  git,
  gitDirsOutside
} from "./chunk-C4526LA5.mjs";
import {
  ReadJournal
} from "./chunk-X4B2TYR3.mjs";
import "./chunk-HFRXC4WN.mjs";
import {
  JOB_SETTING_KEYS,
  RootConcurrency,
  answerPendingApproval,
  bundledCli,
  chooseJobRecipient,
  listPendingApprovals,
  mastersFor,
  notifyOwnerQuestion,
  parseJobSettings,
  primaryFor,
  publishApproval,
  recoverJobRecordAsync
} from "./chunk-YIC6PP7C.mjs";
import "./chunk-A2SWCN6M.mjs";
import {
  bundleDirectory
} from "./chunk-D5ZW6VFT.mjs";
import "./chunk-L4M5HEV4.mjs";
import {
  COMPLETION_DEDUPE_PREFIX,
  completionMessageId
} from "./chunk-JTZGNEMM.mjs";
import {
  MAX_JOB_SEND_TARGETS,
  isJobSendTarget
} from "./chunk-7OVAI3PR.mjs";
import {
  tokensEqual
} from "./chunk-PCXGTT2Z.mjs";
import {
  findHistoryJob,
  projectAskCompletions,
  readArchivedJobSnapshot,
  selectHistoryJobs
} from "./chunk-2KLFTBBJ.mjs";
import {
  startRunFeedReady
} from "./chunk-ETHEYCLK.mjs";
import {
  transcriptPaths
} from "./chunk-CUZHUOFY.mjs";
import {
  DISCOVERY_BIND,
  DISCOVERY_GROUP,
  DISCOVERY_INTERVAL_MS,
  DISCOVERY_MULTICAST_TTL,
  DISCOVERY_PORT,
  DISCOVERY_TTL_MS,
  MAX_DISCOVERED_INSTANCES,
  MAX_DISCOVERY_BYTES,
  MAX_NETWORK_FRAME_BYTES,
  MAX_NETWORK_HOST_CHARS,
  MAX_NETWORK_LINKS,
  MAX_NETWORK_PEERS,
  MAX_NETWORK_REQUESTS,
  MAX_PAIRING_CODE_CHARS,
  MAX_PORT,
  NETWORK_HEARTBEAT_TIMEOUT_MS,
  NETWORK_NAME_PATTERN,
  NETWORK_REFRESH_MS,
  NETWORK_TIMEOUT_MS,
  NETWORK_VERSION,
  PAIRING_KEY_BYTES,
  TLS_CIPHER,
  loadConfig,
  readNetworkConfig,
  writeNetworkConfig
} from "./chunk-QI6BOSWF.mjs";
import {
  AGENT_KINDS,
  BROADCAST,
  BridgeError,
  FrameDecoder,
  SIBLING_CONVERSATION_PREFIX,
  SIBLING_NOTE_SUFFIX,
  encodeFrame,
  isQuietMessage
} from "./chunk-L3WJOWYS.mjs";
import {
  DECISION_MESSAGE_HOP,
  MAX_DECISION_TEXT_CHARS,
  MAX_DECISION_TOPIC_CHARS,
  OwnerQuestionStore,
  QUESTIONS_FILE,
  askOwnerSchema,
  decisionApplies,
  decisionScopeSchema,
  normalizeProject,
  questionAlertChannel,
  questionAnswerSchema
} from "./chunk-NSTCMPSE.mjs";
import {
  isPluginCacheCwd
} from "./chunk-JNVJDIQM.mjs";
import {
  external_exports
} from "./chunk-FDMEMG4Z.mjs";
import {
  indexedJobProjectionCurrent,
  isRecord,
  isSqliteBusy,
  readIndexedJobs,
  readJsonSnapshot,
  readJsonStore,
  recordStorePeer,
  refreshStorePeerIdentities,
  retentionLimit,
  validStoreCapabilities,
  writeJsonStore
} from "./chunk-EVPBD2NK.mjs";
import {
  atomicPluginWrite
} from "./chunk-SFW3GO73.mjs";
import {
  APP_VERSION,
  BROKER_TESTED_JOB_LOAD,
  DEFAULT_MAX_HOPS,
  MAX_BODY_CHARS,
  MAX_FRAME_BYTES,
  MESSAGE_TTL_MS,
  PROTOCOL_VERSION,
  PURGE_INTERVAL_MS,
  QUEUED_MAIL_MAX_AGE_MS
} from "./chunk-7EOIPV3B.mjs";
import "./chunk-HHAVWD7J.mjs";

// src/core/history-background.ts
import { Worker } from "node:worker_threads";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
var HistoryBackground = class {
  progress = { phase: "starting", percent: 0, etaSeconds: null, paused: false, completedRows: 0, totalRows: 0, snapshot: null, ioBytesPerSecond: HISTORY_IO_BYTES_PER_SECOND, error: null };
  worker;
  stopped = false;
  exited = false;
  restart = null;
  id = 0;
  migrationLease = null;
  reconcilingAsks = null;
  lastPressure;
  pending = /* @__PURE__ */ new Map();
  constructor(file, log) {
    let entry = pathToFileURL(join(bundleDirectory(import.meta.url), "history-worker.mjs"));
    if (import.meta.url.endsWith(".ts")) {
      const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
      const path = join(process.env.AGENT_BRIDGE_TEST_ROOT ?? join(root, ".agent-bridge-test"), "history-worker.mjs");
      const inputs = [
        "config.ts",
        "history-store.ts",
        "history-migration.ts",
        "history-schema.ts",
        "conversation-schema.ts",
        "history-worker.ts",
        "history.ts",
        "conversations.ts",
        "project-store.ts",
        "ask-completion.ts",
        "history-budget.ts",
        "savepoint.ts"
      ];
      if (!existsSync(path) || inputs.some(
        (name) => statSync(join(root, "src/core", name)).mtimeMs > statSync(path).mtimeMs
      )) {
        mkdirSync(dirname(path), { recursive: true });
        createRequire(import.meta.url)("esbuild").buildSync({
          entryPoints: [join(root, "src/core/history-worker.ts")],
          outfile: path,
          bundle: true,
          platform: "node",
          format: "esm",
          target: "node22",
          external: ["node:*"],
          logLevel: "silent"
        });
      }
      entry = pathToFileURL(path);
    }
    const start = () => {
      this.lastPressure = void 0;
      this.exited = false;
      this.worker = new Worker(entry, {
        workerData: { file: historyDbPath(file), bridge: file, home: dirname(file), paths: transcriptPaths() },
        execArgv: []
      });
      this.worker.on("message", (message) => {
        if (message.migrationProgress) {
          this.progress = message.migrationProgress;
          return;
        }
        if ("migrationLease" in message) {
          this.migrationLease = message.migrationLease;
          return;
        }
        if (message.id) {
          const pending = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) pending?.reject(new Error(message.error));
          else pending?.resolve(message.result);
        } else if (message.error)
          log.warn("history background batch deferred", { err: message.error });
      });
      this.worker.on("error", (err) => {
        log.warn("history worker failed", { err: String(err) });
        for (const p of this.pending.values())
          p.reject(err instanceof Error ? err : new Error(String(err)));
        this.pending.clear();
      });
      this.worker.on("exit", (code) => {
        this.exited = true;
        if (this.migrationLease) {
          try {
            releaseExitedHistoryLease(file, this.migrationLease);
          } catch (err) {
            log.warn("history worker lease cleanup deferred", { err: String(err) });
          }
          this.migrationLease = null;
        }
        for (const p of this.pending.values())
          p.reject(new Error(`History worker exited (${code})`));
        this.pending.clear();
        if (!this.stopped) {
          log.warn("history worker restarting", { code });
          this.restart = setTimeout(start, 2e3);
          this.restart.unref();
        }
      });
      this.worker.unref();
    };
    start();
  }
  status() {
    return { ...this.progress };
  }
  pressure(pending, lockError = false) {
    if (!this.stopped && !this.exited && (this.lastPressure !== pending || lockError)) {
      this.lastPressure = pending;
      this.worker.postMessage({ pressure: true, pending, lockError });
    }
  }
  rememberPeer(peer) {
    if (!this.stopped && !this.exited) this.worker.postMessage({ peer });
  }
  tick(reset = false) {
    if (this.stopped || this.exited)
      return Promise.reject(
        new Error("History worker unavailable; backfill will resume")
      );
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, reset });
    });
  }
  reconcileAsks() {
    if (this.reconcilingAsks) return this.reconcilingAsks;
    if (this.stopped || this.exited) return Promise.reject(new Error("Job reconciliation worker unavailable; retry later"));
    this.reconcilingAsks = new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, reconcileAsks: true });
    }).finally(() => {
      this.reconcilingAsks = null;
    });
    return this.reconcilingAsks;
  }
  async close() {
    this.stopped = true;
    if (this.restart) clearTimeout(this.restart);
    for (const p of this.pending.values())
      p.reject(new Error("History worker closed"));
    this.pending.clear();
    if (this.exited) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        void this.worker.terminate().then(() => resolve());
      }, 2e3);
      this.worker.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      this.worker.postMessage({ stop: true });
    });
  }
};

// src/core/broker.ts
import { randomUUID as randomUUID3 } from "node:crypto";
import { existsSync as existsSync4 } from "node:fs";
import { createServer as createServer2 } from "node:net";

// src/core/job-archive-background.ts
import { Worker as Worker2 } from "node:worker_threads";
import { existsSync as existsSync2, mkdirSync as mkdirSync2, statSync as statSync2 } from "node:fs";
import { createRequire as createRequire2 } from "node:module";
import { dirname as dirname2, join as join2 } from "node:path";
import { fileURLToPath as fileURLToPath2, pathToFileURL as pathToFileURL2 } from "node:url";
var JobArchiveBackground = class {
  worker;
  finished;
  constructor(path, log) {
    let entry = new URL("./job-archive-worker.mjs", import.meta.url);
    if (import.meta.url.endsWith(".ts")) {
      const root = dirname2(dirname2(dirname2(fileURLToPath2(import.meta.url))));
      const output = join2(root, ".agent-bridge-test", "job-archive-worker.mjs");
      const inputs = ["job-archive-worker.ts", "job-archive-index.ts", "job-archive-migration.ts", "archive-bundle.ts", "store-compatibility.ts", "sqlite-migrations.ts"];
      if (!existsSync2(output) || inputs.some((name) => statSync2(join2(root, "src/core", name)).mtimeMs > statSync2(output).mtimeMs)) {
        mkdirSync2(dirname2(output), { recursive: true });
        const built = createRequire2(import.meta.url)("esbuild").buildSync({
          entryPoints: [join2(root, "src/core/job-archive-worker.ts")],
          outfile: output,
          bundle: true,
          write: false,
          platform: "node",
          format: "esm",
          target: "node22",
          external: ["node:*"],
          logLevel: "silent"
        });
        try {
          atomicPluginWrite(output, built.outputFiles[0].contents);
        } catch (err) {
          if (!["EPERM", "EBUSY", "EACCES"].includes(err.code ?? "") || !existsSync2(output)) throw err;
        }
      }
      entry = pathToFileURL2(output);
    }
    this.worker = new Worker2(entry, { workerData: { path }, execArgv: [] });
    this.finished = new Promise((resolve) => {
      this.worker.on("message", (message) => message.error ? log.warn("job archive migration deferred; originals retained", { error: message.error }) : log.info("job archive migration", message.result));
      this.worker.on("error", (error) => log.warn("job archive worker failed; migration resumes next election", { error: String(error) }));
      this.worker.once("exit", () => resolve());
    });
    this.worker.unref();
  }
  async close() {
    await this.finished;
  }
};

// src/network/link.ts
import { randomBytes, randomUUID } from "node:crypto";
import { connect, createServer } from "node:tls";

// src/network/discovery.ts
import { createSocket } from "node:dgram";
import { isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";
var announcementSchema = publicIdentitySchema.extend({ service: external_exports.literal("agent-bridge"), v: external_exports.literal(NETWORK_VERSION), port: external_exports.number().int().min(1).max(MAX_PORT) });
var VIRTUAL_INTERFACE = /vethernet|hyper-v|wsl|docker|vbox|vmware|virtualbox|^virbr|^br-|^utun|^tun\d|^tap\d|^tailscale|^wg\d/i;
var IPV4_BITS = 32;
var IPV4_OCTET_BITS = 8;
var IPV4_OCTET_MASK = 255;
var MIN_BROADCAST_HOST_MASK = 3;
var ipv4Number = (address) => address.split(".").reduce((value, octet) => value << IPV4_OCTET_BITS | Number(octet), 0) >>> 0;
var ipv4Address = (value) => Array.from({ length: IPV4_BITS / IPV4_OCTET_BITS }, (_, i) => value >>> IPV4_BITS - IPV4_OCTET_BITS * (i + 1) & IPV4_OCTET_MASK).join(".");
function discoveryInterfaces(all) {
  const interfaces = [], skippedInterfaces = [];
  for (const [name, addresses] of Object.entries(all)) for (const entry of addresses ?? []) {
    if (entry.family !== "IPv4") continue;
    let reason = "";
    if (entry.internal || entry.address.startsWith("127.")) reason = "loopback";
    else if (VIRTUAL_INTERFACE.test(name)) reason = "virtual or tunnel adapter";
    else if (entry.address.startsWith("169.254.") || entry.address === "0.0.0.0") reason = "no LAN address";
    else if (!isIPv4(entry.address) || !isIPv4(entry.netmask)) reason = "invalid IPv4 subnet";
    else {
      const mask = ipv4Number(entry.netmask), hostMask = ~mask >>> 0;
      if (mask === 0 || hostMask < MIN_BROADCAST_HOST_MASK || (hostMask & hostMask + 1) !== 0) reason = "no broadcast subnet";
    }
    if (reason) skippedInterfaces.push({ name, address: entry.address, reason });
    else if (!interfaces.some((item) => item.address === entry.address)) interfaces.push({
      name,
      address: entry.address,
      netmask: entry.netmask,
      broadcast: ipv4Address(ipv4Number(entry.address) | ~ipv4Number(entry.netmask))
    });
  }
  return { interfaces, skippedInterfaces };
}
var NetworkDiscovery = class {
  constructor(opts) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }
  opts;
  socket = null;
  timer = null;
  found = /* @__PURE__ */ new Map();
  now;
  senders = /* @__PURE__ */ new Map();
  refreshing = null;
  skippedInterfaces = [];
  lastSentAt = null;
  lastReceivedAt = null;
  lastError = null;
  get port() {
    return this.socket?.address().port ?? 0;
  }
  diagnostics() {
    return {
      bind: this.opts.bind ?? DISCOVERY_BIND,
      port: this.port,
      multicastGroup: DISCOVERY_GROUP,
      multicastTTL: DISCOVERY_MULTICAST_TTL,
      interfaces: [...this.senders.values()].map(({ info }) => ({ ...info })),
      skippedInterfaces: this.skippedInterfaces.map((entry) => ({ ...entry })),
      lastSentAt: this.lastSentAt,
      lastReceivedAt: this.lastReceivedAt,
      lastError: this.lastError && { ...this.lastError }
    };
  }
  error(error) {
    this.lastError = { at: this.now(), message: error.message };
    this.opts.onError?.(error);
  }
  makeSocket() {
    const socket = this.opts.createSocket?.() ?? createSocket({ type: "udp4", reuseAddr: true });
    socket.on("error", (err) => this.error(err));
    return socket;
  }
  bind(socket, port, address) {
    return new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(port, address, () => {
        socket.off("error", reject);
        resolve();
      });
    });
  }
  async refreshInterfaces() {
    const listener = this.socket;
    if (!listener) return;
    const selection = discoveryInterfaces((this.opts.interfaces ?? networkInterfaces)());
    this.skippedInterfaces = selection.skippedInterfaces;
    for (const [address, sender] of this.senders) if (!selection.interfaces.some((entry) => entry.address === address && entry.netmask === sender.info.netmask)) {
      if (sender.info.multicast) {
        try {
          listener.dropMembership(DISCOVERY_GROUP, address);
        } catch {
        }
      }
      await this.closeSocket(sender.socket);
      this.senders.delete(address);
    }
    for (const entry of selection.interfaces) {
      if (this.senders.has(entry.address)) continue;
      const socket = this.makeSocket();
      try {
        await this.bind(socket, 0, entry.address);
        socket.setBroadcast(true);
        const info = { ...entry, announcing: true, multicast: false, lastSentAt: null };
        this.senders.set(entry.address, { socket, info });
        try {
          socket.setMulticastTTL(DISCOVERY_MULTICAST_TTL);
          socket.setMulticastInterface(entry.address);
          listener.addMembership(DISCOVERY_GROUP, entry.address);
          info.multicast = true;
        } catch (err) {
          this.error(new Error(`Discovery multicast on ${entry.name} (${entry.address}): ${err.message}`));
        }
      } catch (err) {
        this.error(new Error(`Discovery interface ${entry.name} (${entry.address}): ${err.message}`));
        await this.closeSocket(socket);
      }
    }
  }
  async start() {
    if (this.socket) throw new Error("network discovery already started");
    const socket = this.makeSocket();
    this.socket = socket;
    socket.on("message", (data, source) => this.observe(data, source.address));
    try {
      await this.bind(socket, this.opts.udpPort ?? DISCOVERY_PORT, this.opts.bind ?? DISCOVERY_BIND);
    } catch (err) {
      await this.close();
      throw err;
    }
    this.timer = setInterval(() => {
      void this.announce();
    }, DISCOVERY_INTERVAL_MS);
    this.timer.unref();
    await this.announce();
  }
  async announce(port = this.opts.udpPort === 0 ? this.port : this.opts.udpPort ?? DISCOVERY_PORT) {
    if (!this.socket) return;
    const data = Buffer.from(JSON.stringify({ service: "agent-bridge", v: NETWORK_VERSION, ...this.opts.identity, port: this.opts.port }));
    if (this.opts.destination && this.opts.destination !== DISCOVERY_GROUP) {
      this.send(this.socket, data, port, this.opts.destination);
      return;
    }
    if (!this.refreshing) this.refreshing = this.refreshInterfaces().catch((err) => this.error(err)).finally(() => {
      this.refreshing = null;
    });
    await this.refreshing;
    if (!this.socket) return;
    for (const { socket, info } of this.senders.values()) {
      this.send(socket, data, port, info.broadcast, info);
      if (info.multicast) this.send(socket, data, port, DISCOVERY_GROUP, info);
    }
  }
  send(socket, data, port, destination, info) {
    try {
      socket.send(data, port, destination, (err) => {
        if (err) this.error(new Error(`Discovery send to ${destination}: ${err.message}`));
        else {
          this.lastSentAt = this.now();
          if (info) info.lastSentAt = this.lastSentAt;
        }
      });
    } catch (err) {
      this.error(err);
    }
  }
  observe(data, host) {
    if (data.length > MAX_DISCOVERY_BYTES || !isIPv4(host)) return;
    try {
      const parsed = announcementSchema.safeParse(JSON.parse(data.toString("utf8")));
      if (!parsed.success || parsed.data.id === this.opts.identity.id) return;
      this.lastReceivedAt = this.now();
      const { id, name, fingerprint, port } = parsed.data;
      this.instances();
      if (!this.found.has(id) && this.found.size >= MAX_DISCOVERED_INSTANCES) return;
      this.found.set(id, { id, name, fingerprint, port, host, seenAt: this.now() });
    } catch {
    }
  }
  instances() {
    for (const [id, entry] of this.found) if (this.now() - entry.seenAt >= DISCOVERY_TTL_MS) this.found.delete(id);
    return [...this.found.values()].map((x) => ({ ...x }));
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    await this.refreshing;
    await Promise.all([...this.senders.values()].map((sender) => this.closeSocket(sender.socket)));
    this.senders.clear();
    if (socket) await this.closeSocket(socket);
    this.found.clear();
  }
  closeSocket(socket) {
    return new Promise((resolve) => {
      try {
        socket.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }
};

// src/network/link.ts
var MAX_METADATA_CHARS = 4096;
var MAX_ID_CHARS = 128;
var MAX_HOP_COUNT = 100;
var MAX_EXTENSION_HANDLERS = 8;
var textId = external_exports.string().min(1).max(MAX_ID_CHARS);
var peerSchema = external_exports.object({
  id: textId,
  name: external_exports.string().regex(NETWORK_NAME_PATTERN),
  agent: external_exports.enum(AGENT_KINDS),
  cwd: external_exports.string().max(MAX_METADATA_CHARS),
  pid: external_exports.number().int().nonnegative(),
  agentPid: external_exports.number().int().nonnegative().nullable(),
  sessionId: external_exports.string().max(MAX_METADATA_CHARS).nullable(),
  startedAt: external_exports.number().nonnegative(),
  autoWake: external_exports.boolean(),
  wakeOnDirect: external_exports.boolean().optional(),
  wakeAvailable: external_exports.boolean().optional(),
  wakeMaxHops: external_exports.number().int().min(0).max(MAX_HOP_COUNT).optional(),
  activity: external_exports.enum(["busy", "idle"]).nullable().optional(),
  version: external_exports.string().max(MAX_ID_CHARS).optional(),
  jobAgent: external_exports.enum(AGENT_KINDS).optional(),
  jobParent: external_exports.string().max(MAX_METADATA_CHARS).optional(),
  jobTitle: external_exports.string().max(MAX_METADATA_CHARS).optional(),
  parentJob: external_exports.string().max(MAX_METADATA_CHARS).optional(),
  rootSession: external_exports.string().max(MAX_METADATA_CHARS).optional(),
  rootName: external_exports.string().max(MAX_METADATA_CHARS).optional(),
  subagent: external_exports.boolean().optional(),
  title: external_exports.string().max(MAX_METADATA_CHARS).optional(),
  projectGroup: external_exports.string().min(1).max(MAX_METADATA_CHARS).optional(),
  projectAddress: external_exports.string().min(1).max(MAX_METADATA_CHARS).optional(),
  projectMain: external_exports.boolean().optional(),
  unavailable: external_exports.boolean().optional()
});
var peersSchema = external_exports.array(peerSchema).max(MAX_NETWORK_PEERS).refine((peers) => new Set(peers.map((p) => p.name)).size === peers.length && new Set(peers.map((p) => p.id)).size === peers.length);
var messageSchema = external_exports.object({
  id: external_exports.uuid(),
  from: external_exports.object({ id: textId, name: external_exports.string().regex(NETWORK_NAME_PATTERN), agent: external_exports.enum(AGENT_KINDS) }),
  to: external_exports.string().min(1).max(MAX_METADATA_CHARS),
  recipient: external_exports.string().regex(NETWORK_NAME_PATTERN),
  conversationId: textId,
  replyTo: textId.nullable(),
  hop: external_exports.number().int().min(0).max(MAX_HOP_COUNT),
  body: external_exports.string().min(1).max(MAX_BODY_CHARS),
  createdAt: external_exports.number().nonnegative(),
  readAt: external_exports.null()
});
var frameSchema = external_exports.discriminatedUnion("type", [
  publicIdentitySchema.extend({ type: external_exports.literal("hello"), v: external_exports.literal(NETWORK_VERSION), peers: peersSchema, echo: external_exports.boolean().optional(), receipts: external_exports.boolean().optional(), capabilities: external_exports.array(external_exports.string().min(1).max(MAX_ID_CHARS)).max(MAX_EXTENSION_HANDLERS).optional() }),
  external_exports.object({ type: external_exports.literal("file-stream"), payload: external_exports.record(external_exports.string(), external_exports.unknown()) }),
  external_exports.object({ type: external_exports.literal("remote-job"), payload: external_exports.record(external_exports.string(), external_exports.unknown()) }),
  external_exports.object({ type: external_exports.literal("dashboard-read"), payload: external_exports.record(external_exports.string(), external_exports.unknown()) }),
  external_exports.object({ type: external_exports.literal("peers"), peers: peersSchema }),
  external_exports.object({ type: external_exports.literal("send"), rid: external_exports.uuid(), message: messageSchema }),
  external_exports.object({ type: external_exports.literal("echo"), rid: external_exports.uuid() }),
  external_exports.object({ type: external_exports.literal("receipt"), rid: external_exports.uuid(), id: external_exports.uuid(), sender: textId, recipient: external_exports.string().regex(NETWORK_NAME_PATTERN).optional() }),
  external_exports.object({ type: external_exports.literal("files"), rid: external_exports.uuid(), transfer: transferSchema }),
  external_exports.object({ type: external_exports.literal("result"), rid: external_exports.uuid(), delivered: external_exports.boolean().optional(), recipient: external_exports.string().regex(NETWORK_NAME_PATTERN).optional(), readAt: external_exports.number().nonnegative().nullable().optional(), stored: external_exports.boolean().optional(), recovered: external_exports.boolean().optional(), transfer: transferResultSchema.optional(), error: external_exports.string().max(MAX_METADATA_CHARS).optional() })
]);
var Link = class {
  constructor(socket, service, key, expected) {
    this.socket = socket;
    this.service = service;
    this.key = key;
    this.expected = expected;
    socket.setKeepAlive(true, NETWORK_REFRESH_MS);
    this.deadline = setTimeout(() => this.fail(new Error("network hello timed out")), NETWORK_TIMEOUT_MS);
    void this.ready.catch(() => {
    });
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.processBuffer();
    });
    socket.on("error", (err) => this.fail(err));
    socket.on("close", () => {
      clearTimeout(this.deadline);
      this.readyReject(new Error("network link closed"));
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("network link closed"));
      }
      this.pending.clear();
      for (const reject of this.extensionWrites) reject(new Error("network link closed"));
      this.extensionWrites.clear();
      this.bulkWrites.length = 0;
      this.bulkWriteBytes = 0;
      this.incomingExtensions.length = 0;
      this.incomingExtensionBytes = 0;
      service.detach(this);
    });
    this.write({ type: "hello", v: NETWORK_VERSION, ...service.keys.identity, peers: service.localPeers(), echo: true, receipts: Boolean(service.supportsReceipts), capabilities: service.extensionCapabilities() });
  }
  socket;
  service;
  key;
  expected;
  remote = null;
  peers = [];
  echoSupported = false;
  heartbeatPending = false;
  receiptsSupported = false;
  capabilities = [];
  advertisedPeers = null;
  extensionHandlers = 0;
  incomingExtensions = [];
  incomingExtensionBytes = 0;
  bulkWrites = [];
  bulkWriteBytes = 0;
  bulkWriting = false;
  buffer = Buffer.alloc(0);
  pending = /* @__PURE__ */ new Map();
  extensionWrites = /* @__PURE__ */ new Set();
  readyResolve;
  readyReject;
  ready = new Promise((resolve, reject) => {
    this.readyResolve = resolve;
    this.readyReject = reject;
  });
  deadline;
  processBuffer() {
    if (this.socket.destroyed) return;
    try {
      let nl;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        if (nl > MAX_NETWORK_FRAME_BYTES) throw new Error("network frame too large");
        const line = this.buffer.subarray(0, nl);
        this.buffer = this.buffer.subarray(nl + 1);
        const frame = frameSchema.parse(JSON.parse(line.toString("utf8")));
        if (!this.remote) {
          if (frame.type !== "hello") throw new Error("network hello required");
          const expected = this.expected;
          if (expected && (frame.id !== expected.id || frame.name !== expected.name || frame.fingerprint !== expected.fingerprint)) throw new Error("paired identity changed");
          this.remote = expected ?? this.service.keys.accept(this.key, frame);
          this.peers = frame.peers;
          this.echoSupported = frame.echo === true;
          this.receiptsSupported = frame.receipts === true;
          this.capabilities = frame.capabilities ?? [];
          this.service.attach(this);
          clearTimeout(this.deadline);
          this.readyResolve();
        } else if (frame.type === "hello") throw new Error("duplicate network hello");
        else this.onFrame(frame);
      }
      if (this.buffer.length > MAX_NETWORK_FRAME_BYTES) throw new Error("network frame too large");
    } catch (error) {
      this.fail(error);
    }
  }
  write(frame) {
    const data = JSON.stringify(frame) + "\n";
    if (Buffer.byteLength(data) > MAX_NETWORK_FRAME_BYTES || this.socket.writableLength > MAX_NETWORK_FRAME_BYTES) throw new Error("network write limit reached");
    if (this.socket.destroyed) throw new Error("network link closed");
    this.socket.write(data);
  }
  supports(capability) {
    return this.capabilities.includes(capability);
  }
  /** Queue bulk chunks separately: control frames can pass all chunks not yet written. */
  writeExtension(type, payload) {
    const data = JSON.stringify({ type, payload }) + "\n";
    const bytes = Buffer.byteLength(data);
    const bulk = type === "file-stream" && payload.op === "chunk";
    if (bytes > MAX_NETWORK_FRAME_BYTES || this.bulkWriteBytes + bytes > 8 * MAX_NETWORK_FRAME_BYTES || !bulk && this.socket.writableLength > MAX_NETWORK_FRAME_BYTES || this.extensionWrites.size >= MAX_NETWORK_REQUESTS) return Promise.reject(new Error("network write limit reached"));
    if (this.socket.destroyed) return Promise.reject(new Error("network link closed"));
    return new Promise((resolve, reject) => {
      const failed = (error) => {
        if (!this.extensionWrites.delete(failed)) return;
        this.fail(error);
        reject(new Error("network link closed", { cause: error }));
      };
      this.extensionWrites.add(failed);
      const write = () => {
        try {
          this.socket.write(data, (error) => {
            if (error) failed(error);
            else {
              this.extensionWrites.delete(failed);
              resolve();
            }
            if (bulk) {
              this.bulkWriting = false;
              setImmediate(() => this.pumpBulkWrites());
            }
          });
        } catch (error) {
          failed(error);
        }
      };
      if (bulk) {
        this.bulkWrites.push({ data, write });
        this.bulkWriteBytes += bytes;
        setImmediate(() => this.pumpBulkWrites());
      } else write();
    });
  }
  pumpBulkWrites() {
    if (this.bulkWriting || this.socket.destroyed || !this.bulkWrites.length) return;
    if (this.socket.writableLength > MAX_NETWORK_FRAME_BYTES) {
      this.socket.once("drain", () => this.pumpBulkWrites());
      return;
    }
    const next = this.bulkWrites.shift();
    this.bulkWriteBytes -= Buffer.byteLength(next.data);
    this.bulkWriting = true;
    next.write();
  }
  refresh() {
    if (!this.remote) return;
    const peers = this.service.localPeers(), signature = JSON.stringify(peers);
    if (this.echoSupported && signature === this.advertisedPeers) return;
    this.write({ type: "peers", peers });
    this.advertisedPeers = signature;
  }
  send(message) {
    return this.request({ type: "send", rid: randomUUID(), message: messageSchema.parse(message) });
  }
  /** Detect a half-open link even when nobody sends work; activity never expires a peer. */
  heartbeat() {
    if (!this.remote || !this.echoSupported || this.heartbeatPending) return;
    this.heartbeatPending = true;
    void this.echo(this.service.timings.heartbeatTimeoutMs).catch((error) => this.fail(error)).finally(() => {
      this.heartbeatPending = false;
    });
  }
  receipt(id, sender, recipient, requireRecipient = false) {
    if (!this.receiptsSupported) return Promise.reject(new Error("Remote broker does not support read receipts. Update and reload its hosting sessions."));
    if (requireRecipient && !this.supports("recipient-receipts-v1")) return Promise.reject(new Error("Remote broker does not support per-recipient broadcast receipts. Update and reload its hosting sessions."));
    return this.request({ type: "receipt", rid: randomUUID(), id, sender, recipient });
  }
  files(transfer) {
    return this.request({ type: "files", rid: randomUUID(), transfer: transferSchema.parse(transfer) });
  }
  async echo(timeoutMs = NETWORK_TIMEOUT_MS) {
    if (!this.echoSupported) throw new Error("Remote broker does not support verification. Update and restart its hosting sessions.");
    const result = await this.request({ type: "echo", rid: randomUUID() }, timeoutMs);
    if (result !== true) throw new Error("network echo was not acknowledged");
  }
  request(frame, timeoutMs = NETWORK_TIMEOUT_MS) {
    if (this.pending.size >= MAX_NETWORK_REQUESTS) return Promise.reject(new Error("too many network requests"));
    return new Promise((resolve, reject) => {
      const rid = frame.rid;
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error("network send timed out; delivery may have occurred"));
      }, timeoutMs);
      this.pending.set(rid, { resolve, reject, timer, kind: frame.type });
      try {
        if (frame.type === "send" || frame.type === "files") this.refresh();
        this.write(frame);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(rid);
        reject(err);
      }
    });
  }
  onFrame(frame) {
    if (frame.type === "file-stream" || frame.type === "remote-job" || frame.type === "dashboard-read") {
      const bytes = Buffer.byteLength(JSON.stringify(frame));
      if (this.incomingExtensions.length >= MAX_NETWORK_REQUESTS || this.incomingExtensionBytes + bytes > 8 * MAX_NETWORK_FRAME_BYTES) throw new Error("too many queued extension frames");
      this.incomingExtensions.push(frame);
      this.incomingExtensionBytes += bytes;
      this.pumpExtensions();
      return;
    }
    if (frame.type === "peers") {
      this.peers = frame.peers;
      return;
    }
    if (frame.type === "result") {
      const pending = this.pending.get(frame.rid);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(frame.rid);
      if (frame.error) pending.reject(new Error(frame.error));
      else if (pending.kind === "send" && frame.delivered !== void 0) pending.resolve({ delivered: frame.delivered, recipient: frame.recipient, stored: frame.stored, recovered: frame.recovered, readAt: frame.readAt });
      else if (pending.kind === "echo" && frame.delivered !== void 0) pending.resolve(frame.delivered);
      else if (pending.kind === "receipt" && frame.readAt !== void 0) pending.resolve(frame.readAt);
      else if (pending.kind === "files" && frame.transfer) pending.resolve(frame.transfer);
      else pending.reject(new Error("invalid network result"));
      return;
    }
    if (frame.type === "echo") {
      this.write({ type: "result", rid: frame.rid, delivered: true });
      return;
    }
    try {
      if (frame.type === "receipt") {
        const readAt = this.service.readReceipt(frame.id, `${this.remote.id}/${frame.sender}`, frame.recipient);
        this.write({ type: "result", rid: frame.rid, readAt });
        return;
      }
      const from = frame.type === "send" ? frame.message.from : frame.transfer.from;
      const sender = this.peers.find((p) => p.id === from.id && p.name === from.name);
      if (!sender || (sender.jobAgent ?? sender.agent) !== from.agent) throw new Error("sender not advertised by paired instance");
      const remote = this.remote;
      if (frame.type === "files") {
        const result2 = this.service.receiveFiles(frame.transfer, `${remote.name}/${from.name}`, `${remote.id}/${from.id}`);
        this.write({ type: "result", rid: frame.rid, transfer: result2 });
        return;
      }
      const message = { ...frame.message, from: { ...frame.message.from, id: `${remote.id}/${frame.message.from.id}`, name: `${remote.name}/${frame.message.from.name}` } };
      const result = this.service.receive(message);
      this.refresh();
      this.write({ type: "result", rid: frame.rid, ...result });
    } catch (err) {
      this.write({ type: "result", rid: frame.rid, error: String(err.message).slice(0, MAX_METADATA_CHARS) });
    }
  }
  pumpExtensions() {
    while (!this.socket.destroyed && this.extensionHandlers < MAX_EXTENSION_HANDLERS && this.incomingExtensions.length) {
      const frame = this.incomingExtensions.shift();
      this.incomingExtensionBytes -= Buffer.byteLength(JSON.stringify(frame));
      this.extensionHandlers++;
      void Promise.resolve().then(() => this.service.receiveExtension(frame.type, frame.payload, this.remote)).catch((error) => this.fail(error)).finally(() => {
        this.extensionHandlers--;
        this.pumpExtensions();
      });
    }
  }
  fail(error) {
    this.readyReject(error);
    this.socket.destroy();
  }
};
var NetworkService = class {
  constructor(home, cfg, broker, log, timings = {}) {
    this.home = home;
    this.cfg = cfg;
    this.broker = broker;
    this.log = log;
    this.timings = { refreshMs: timings.refreshMs ?? NETWORK_REFRESH_MS, heartbeatTimeoutMs: timings.heartbeatTimeoutMs ?? NETWORK_HEARTBEAT_TIMEOUT_MS };
    for (const value of Object.values(this.timings)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error("network timings must be positive milliseconds");
    this.keys = new PairingStore(home, cfg.name);
    this.transfers = new TransferManager(home, {
      supports: (remote) => this.peerSupports(remote, FILE_STREAM_CAPABILITY),
      window: (remote) => this.peerSupports(remote, FILE_STREAM_WINDOW_CAPABILITY) ? TRANSFER_WINDOW_CHUNKS : 1,
      send: (remote, payload) => {
        if (payload.op === "offer" || payload.op === "fetch") this.instanceLink(remote).refresh();
        return this.sendExtension(remote, "file-stream", payload);
      },
      validSender: (remote, sender) => this.links.get(remote)?.peers.some((peer) => peer.id === sender.id && peer.name === sender.name && (peer.jobAgent ?? peer.agent) === sender.agent) ?? false,
      localPeer: (name) => {
        const peer = this.broker.peers().find((peer2) => peer2.name === name);
        return peer ? { id: peer.id, name: peer.name, agent: peer.jobAgent ?? peer.agent, cwd: peer.cwd } : void 0;
      },
      notify: (message) => {
        this.broker.receive(message);
      },
      legacy: (remote, transfer) => this.instanceLink(remote).files(transfer)
    }, log, { maxBytes: cfg.maxTransferBytes, fetchRoots: cfg.fetchRoots });
    this.registerExtension("file-stream", FILE_STREAM_CAPABILITY, (payload, remote) => this.transfers.handle(payload, remote.id, remote.name));
  }
  home;
  cfg;
  broker;
  log;
  timings;
  keys;
  transfers;
  server = null;
  sockets = /* @__PURE__ */ new Set();
  links = /* @__PURE__ */ new Map();
  connecting = /* @__PURE__ */ new Set();
  health = /* @__PURE__ */ new Map();
  discovery = null;
  timer = null;
  closed = false;
  extensions = /* @__PURE__ */ new Map();
  get port() {
    const address = this.server?.address();
    return address && typeof address !== "string" ? address.port : 0;
  }
  registerExtension(type, capability, handler, aliases = []) {
    if (this.server || this.extensions.has(type)) throw new Error("register extensions once before starting networking");
    this.extensions.set(type, { capability, aliases, handler });
  }
  extensionCapabilities() {
    return [...this.extensions.values()].flatMap((extension) => [extension.capability, ...extension.aliases]).concat([FILE_STREAM_WINDOW_CAPABILITY], this.broker.recipientReceipts ? ["recipient-receipts-v1"] : []);
  }
  receiveExtension(type, payload, remote) {
    const extension = this.extensions.get(type);
    if (!extension) throw new Error("unsupported network extension");
    return extension.handler(payload, remote);
  }
  instanceLink(instance) {
    const link = [...this.links.values()].find((candidate) => candidate.remote.id === instance || candidate.remote.name === instance);
    if (!link) throw new Error("paired instance is not connected");
    return link;
  }
  peerSupports(instance, capability) {
    try {
      return this.instanceLink(instance).supports(capability);
    } catch {
      return false;
    }
  }
  async sendExtension(instance, type, payload) {
    const extension = this.extensions.get(type);
    const link = this.instanceLink(instance);
    if (!extension || !link.supports(extension.capability)) return Promise.reject(new Error("remote broker does not support this extension"));
    if (type === "remote-job" && payload.kind === "request") link.refresh();
    return link.writeExtension(type, payload);
  }
  get supportsReceipts() {
    return Boolean(this.broker.receipt);
  }
  readReceipt(id, sender, recipient) {
    if (!this.broker.receipt) throw new Error("read receipts unavailable");
    return this.broker.receipt(id, sender, recipient);
  }
  async receipt(address, id, sender, requireRecipient = false) {
    const { link, target } = this.target(address);
    return link.receipt(id, sender, target, requireRecipient);
  }
  localPeers() {
    return peersSchema.parse(this.broker.peers());
  }
  receive(message) {
    return this.broker.receive(message);
  }
  async start() {
    if (!this.cfg.enabled) throw new Error("networking is disabled");
    if (this.server || this.closed) throw new Error("network service already started or closed");
    const acceptedKeys = /* @__PURE__ */ new WeakMap();
    const server = createServer({
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      ciphers: TLS_CIPHER,
      handshakeTimeout: NETWORK_TIMEOUT_MS,
      pskCallback: (socket, identity) => {
        const key = this.keys.keyFor(identity);
        if (key) acceptedKeys.set(socket, key);
        return key ? Buffer.from(key, "hex") : randomBytes(PAIRING_KEY_BYTES);
      }
    }, (socket) => {
      const key = acceptedKeys.get(socket);
      if (!key || socket.getProtocol() !== "TLSv1.3") return socket.destroy();
      try {
        new Link(socket, this, key);
      } catch (err) {
        socket.destroy();
        this.log.warn("network hello could not be sent", { message: err.message });
      }
    });
    this.server = server;
    server.maxConnections = MAX_NETWORK_LINKS;
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    server.on("tlsClientError", () => this.log.debug("network TLS authentication failed"));
    server.on("error", (err) => this.log.warn("network listener error", { message: err.message }));
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.cfg.port, this.cfg.bind, () => {
          server.off("error", reject);
          resolve();
        });
      });
      if (this.cfg.discovery) {
        this.discovery = new NetworkDiscovery({ identity: this.keys.identity, port: this.port, onError: (err) => this.log.warn("network discovery error", { message: err.message }) });
        await this.discovery.start();
      }
      this.timer = setInterval(() => {
        for (const link of this.links.values()) {
          try {
            link.refresh();
            link.heartbeat();
          } catch (err) {
            link.fail(err);
          }
        }
        for (const pair of this.keys.pairs()) if (pair.host && pair.port && !this.links.has(pair.id) && !this.connecting.has(pair.id)) void this.connectPair(pair).catch(() => {
        });
      }, this.timings.refreshMs);
      this.timer.unref();
      for (const pair of this.keys.pairs()) if (pair.host && pair.port) void this.connectPair(pair).catch(() => {
      });
    } catch (err) {
      await this.close();
      throw err;
    }
  }
  attach(link) {
    const remote = link.remote;
    if (this.closed) throw new Error("network service closed");
    const existing = this.links.get(remote.id);
    if (existing && existing !== link) throw new Error("instance already connected");
    this.links.set(remote.id, link);
    setImmediate(() => this.transfers.resume());
  }
  detach(link) {
    if (link.remote && this.links.get(link.remote.id) === link) {
      this.links.delete(link.remote.id);
      this.transfers.disconnected(link.remote.id);
    }
  }
  peers() {
    return [...this.links.values()].flatMap((link) => link.peers.map((p) => {
      const host = link.remote.name;
      const qualify = (value, prefix = host) => value && !value.includes("/") ? `${prefix}/${value}` : value;
      return {
        ...p,
        agent: p.jobAgent ?? p.agent,
        host,
        id: `${link.remote.id}/${p.id}`,
        name: `${host}/${p.name}`,
        jobParent: qualify(p.jobParent),
        parentJob: qualify(p.parentJob),
        rootName: qualify(p.rootName),
        rootSession: qualify(p.rootSession, link.remote.id)
      };
    }));
  }
  status() {
    return { enabled: true, config: this.cfg, identity: this.keys.identity, port: this.port, discovered: this.discovery?.instances() ?? [], ...this.discovery ? { discoveryDiagnostics: this.discovery.diagnostics() } : {}, paired: this.keys.pairs().map(({ id, name, fingerprint }) => ({ id, name, fingerprint, connected: this.links.has(id), ...this.health.has(id) ? { health: this.health.get(id) } : {} })) };
  }
  async verify(id) {
    const link = this.links.get(id);
    if (!link) throw new Error("paired instance is not connected");
    const start = performance.now();
    await link.echo();
    const roundTripMs = Math.round(performance.now() - start);
    this.health.set(id, { lastVerifiedAt: Date.now(), roundTripMs });
    return { peers: this.peers().filter((p) => p.id.startsWith(`${id}/`)), roundTripMs };
  }
  async link(code, host, port) {
    const decoded = decodePairingCode(code);
    const pair = this.keys.validatePair(decoded, host, port);
    await this.connectPair(pair);
    try {
      this.keys.remember(decoded, host, port);
    } catch (err) {
      this.links.get(pair.id)?.socket.destroy();
      throw err;
    }
    return { id: decoded.id, name: decoded.name, fingerprint: decoded.fingerprint };
  }
  async connectPair(pair) {
    if (this.closed || this.links.has(pair.id) || this.connecting.has(pair.id)) throw new Error("instance already connected or connecting");
    this.connecting.add(pair.id);
    let socket = null;
    try {
      socket = connect({
        host: pair.host,
        port: pair.port,
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
        ciphers: TLS_CIPHER,
        // TLS-PSK has no certificate. The PSK is mandatory; certificate-based fallbacks are rejected below.
        rejectUnauthorized: false,
        checkServerIdentity: () => void 0,
        pskCallback: () => ({ identity: keyFingerprint(pair.key), psk: Buffer.from(pair.key, "hex") })
      });
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      const secured = socket;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          secured.destroy();
          reject(new Error("network TLS handshake timed out"));
        }, NETWORK_TIMEOUT_MS);
        const onError = (err) => {
          clearTimeout(timer);
          reject(err);
        };
        secured.once("error", onError);
        secured.once("secureConnect", () => {
          clearTimeout(timer);
          secured.off("error", onError);
          resolve();
        });
      });
      if (secured.getProtocol() !== "TLSv1.3" || Object.keys(secured.getPeerCertificate()).length) throw new Error("TLS-PSK required");
      await new Link(secured, this, pair.key, pair).ready;
    } catch (err) {
      socket?.destroy();
      throw err;
    } finally {
      this.connecting.delete(pair.id);
    }
  }
  unlink(id) {
    try {
      this.keys.remove(id);
      this.health.delete(id);
    } finally {
      this.links.get(id)?.socket.destroy();
    }
  }
  async send(message) {
    const { link, target } = this.target(message.recipient);
    const result = await link.send({ ...message, recipient: target });
    const actual = result.recipient ?? target;
    const recipient = `${link.remote.name}/${actual}`;
    return {
      messages: [{ ...message, recipient }],
      deliveredTo: result.delivered ? [recipient] : [],
      queuedFor: result.delivered ? [] : [recipient],
      ...result.stored ? { storage: { id: message.id, state: "stored", recovered: result.recovered, receipts: [{ recipient, readAt: result.readAt ?? null }] } } : {},
      recipientStates: link.peers.filter((p) => p.name === actual).map((p) => ({ name: recipient, activity: p.activity, autoWake: p.autoWake, wakeOnDirect: p.wakeOnDirect, wakeAvailable: p.wakeAvailable, wakeMaxHops: p.wakeMaxHops }))
    };
  }
  /** Advertised remote project hints select an address, never grant local project authority. */
  projectPeers(address) {
    return this.peers().filter((p) => !p.jobAgent && !p.subagent && p.projectGroup && p.projectAddress === address);
  }
  projectTarget(address) {
    const peers = this.projectPeers(address);
    const groups = new Set(peers.map((p) => `${p.host}/${p.projectGroup}`));
    if (groups.size !== 1) throw new BridgeError(groups.size > 1 ? "ambiguous_target" : "unknown_target", "Use a unique paired project address or an exact host/session name.");
    const target = peers.filter((p) => !p.unavailable).sort((a, b) => Number(Boolean(b.projectMain)) - Number(Boolean(a.projectMain)) || a.startedAt - b.startedAt || a.name.localeCompare(b.name))[0];
    if (!target) throw new BridgeError("unknown_target", "No paired project session is available.");
    return target.name;
  }
  target(address) {
    const slash = address.indexOf("/");
    const host = address.slice(0, slash);
    const raw = address.slice(slash + 1);
    const link = [...this.links.values()].find((l) => l.remote.name === host || l.remote.id === host);
    let target = link?.peers.find((p) => p.name === raw || p.id === raw)?.name ?? raw;
    if (link && raw.startsWith("project:")) {
      const peers = link.peers.filter((p) => !p.jobAgent && !p.subagent && p.projectGroup && p.projectAddress === raw);
      const groups = new Set(peers.map((p) => p.projectGroup));
      if (groups.size !== 1) throw new BridgeError(groups.size > 1 ? "ambiguous_target" : "unknown_target", "Use a unique project address on the paired PC.");
      const main = peers.filter((p) => !p.unavailable).sort((a, b) => Number(Boolean(b.projectMain)) - Number(Boolean(a.projectMain)) || a.startedAt - b.startedAt || a.name.localeCompare(b.name))[0];
      if (!main) throw new BridgeError("unknown_target", "No paired project session is available.");
      target = main.name;
    }
    if (!link || !NETWORK_NAME_PATTERN.test(target)) throw new BridgeError("unknown_target", "paired instance is not connected or target is invalid");
    return { link, target };
  }
  async sendFiles(address, transfer) {
    const { link, target } = this.target(address);
    return link.files({ ...transfer, to: target });
  }
  startFiles(address, paths, cwd, from, pull = false) {
    const { link, target } = this.target(address);
    if (!link.peers.some((peer) => peer.name === target)) throw new Error("file recipient is not online");
    const streaming = link.supports(FILE_STREAM_CAPABILITY);
    if (pull && !streaming) throw new Error("remote broker does not support fetch_files; update its hosting sessions");
    return this.transfers.start(link.remote.id, `${link.remote.name}/${target}`, target, paths, cwd, from, pull, void 0, !streaming);
  }
  fileTarget(address) {
    return this.target(address).target;
  }
  receiveFiles(transfer, name, id) {
    if (!this.broker.peers().some((p) => p.name === transfer.to)) throw new Error("file recipient is not online");
    const bytes = transfer.entries.reduce((sum, entry) => sum + (entry.kind === "file" ? Buffer.byteLength(entry.data, "base64") : 0), 0);
    if (this.cfg.maxTransferBytes !== void 0 && bytes > this.cfg.maxTransferBytes) throw new Error("transfer exceeds size limit");
    const result = receiveTransfer(this.home, transfer);
    this.transfers.recordLegacy(transfer, id.split("/")[0], name);
    this.log.info("legacy files received", { ...result, sender: name });
    this.broker.receive({ id: transfer.id, from: { ...transfer.from, name, id }, to: transfer.to, recipient: transfer.to, conversationId: transfer.id, replyTo: null, hop: 0, body: `Received ${result.files} files (${result.bytes} bytes) in ${result.inbox}`, createdAt: Date.now(), readAt: null });
    return result;
  }
  async close() {
    this.closed = true;
    this.transfers.close();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.discovery?.close();
    this.discovery = null;
    for (const socket of this.sockets) socket.destroy();
    this.links.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise((resolve) => server.close(() => resolve()));
  }
};

// src/core/broker.ts
import { basename, dirname as dirname3, join as join4 } from "node:path";

// src/network/remote-jobs.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { existsSync as existsSync3, realpathSync, statSync as statSync3 } from "node:fs";
import { isAbsolute, join as join3 } from "node:path";
var REMOTE_JOBS_FILE = "remote-jobs.json";
function allowedRemoteDirectory(directory, roots) {
  if (!isAbsolute(directory)) throw new Error("Remote cwd must be an absolute path on the paired PC.");
  const canonical = realpathSync.native(directory);
  if (!statSync3(canonical).isDirectory() || !roots.some((root) => isAbsolute(root) && isInside(canonical, realpathSync.native(root)))) {
    throw new Error("Remote folder is outside network.remoteJobs.allowRoots.");
  }
  return canonical;
}
var RemoteJobs = class {
  constructor(network, home, log, control) {
    this.network = network;
    this.home = home;
    this.log = log;
    this.control = control;
    const cli = bundledCli();
    this.runners = cli ? new JobRunners({}, home, cli, log) : null;
    const stored = readJsonStore(join3(home, REMOTE_JOBS_FILE));
    if (isRecord(stored) && Array.isArray(stored.jobs)) for (const r of stored.jobs) {
      if (typeof r.pair !== "string" || typeof r.peer !== "string" || !r.job?.id || !r.args) continue;
      this.records.set(r.job.id, { ...r, job: { ...r.job, controller: new AbortController(), queue: [] } });
    }
    network.registerExtension(REMOTE_JOB_FRAME, REMOTE_JOB_CAPABILITY, (payload, pair) => this.receive(payload, pair), [REMOTE_JOB_CANCELLED_CAPABILITY]);
  }
  network;
  home;
  log;
  control;
  records = /* @__PURE__ */ new Map();
  pending = /* @__PURE__ */ new Map();
  rates = /* @__PURE__ */ new Map();
  feeds = /* @__PURE__ */ new Map();
  mirrorIntents = /* @__PURE__ */ new Map();
  mirrorTurns = /* @__PURE__ */ new Map();
  mirrorStates = /* @__PURE__ */ new Map();
  approvals = /* @__PURE__ */ new Map();
  publishingApprovals = /* @__PURE__ */ new Set();
  starting = /* @__PURE__ */ new Set();
  pendingStarts = /* @__PURE__ */ new Map();
  runners;
  closed = false;
  async request(host, peer, raw, supervisor = peer.id, localJobName) {
    const request = remoteJobRequestSchema.parse(raw);
    const mirrorKey = `${host}/${request.job}`, mirrorTurn = this.mirrorTurns.get(mirrorKey);
    if (!this.network.peerSupports(host, REMOTE_JOB_CAPABILITY)) throw new Error("Remote broker update needed or paired PC disconnected: install remote-jobs-v1 support and restart its hosting sessions.");
    if (this.pending.size >= REMOTE_JOB_RATE_LIMIT) throw new Error("Too many pending remote job requests.");
    const rid = randomUUID2();
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error("Remote job request timed out; check the paired PC before retrying a spawn."));
      }, REMOTE_JOB_REQUEST_TIMEOUT_MS);
      this.pending.set(rid, { host, resolve, reject, timer });
    });
    void response.catch(() => {
    });
    try {
      await this.network.sendExtension(host, REMOTE_JOB_FRAME, { kind: "request", rid, peer: { id: peer.id, name: peer.name, supervisor }, request });
      const snapshot = await response;
      try {
        if (request.op === "spawn" || this.mirrorTurns.get(mirrorKey) === mirrorTurn) await this.mirror(host, peer, request, snapshot, supervisor, localJobName);
      } catch (error) {
        this.log.warn("remote result retained; local run mirror unavailable", { host, job: request.job, err: String(error) });
      }
      return snapshot;
    } catch (err) {
      const p = this.pending.get(rid);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(rid);
        p.reject(err);
      }
      throw err;
    }
  }
  async receive(payload, pair) {
    const parsed = remoteJobWireSchema.safeParse(payload);
    if (!parsed.success) {
      this.log.warn("invalid remote job frame", { host: pair.name });
      return;
    }
    const frame = parsed.data;
    if (frame.kind === "response") {
      const p = this.pending.get(frame.rid);
      if (!p || p.host !== pair.id && p.host !== pair.name) return;
      clearTimeout(p.timer);
      this.pending.delete(frame.rid);
      if (frame.error) p.reject(new Error(frame.error));
      else {
        const snapshot = remoteJobSnapshotSchema.safeParse(frame.value);
        if (snapshot.success) p.resolve(snapshot.data);
        else p.reject(new Error("Invalid remote job response."));
      }
      return;
    }
    try {
      const advertised = this.network.peers().find((p) => p.id === `${pair.id}/${frame.peer.id}` && p.name === `${pair.name}/${frame.peer.name}`);
      if (!advertised || advertised.jobAgent) throw new Error("Remote job requester is not an advertised supervisor session.");
      const cfg = loadConfig(this.home, "other", this.log, {});
      const policy = cfg.network.remoteJobs;
      if (!policy.enabled || !policy.allowPeers.includes(pair.name)) throw new Error("Remote jobs are disabled for this pair; enable network.remoteJobs and explicitly allow its instance name.");
      const now = Date.now();
      let rate = this.rates.get(pair.id);
      if (!rate || now - rate.at >= REMOTE_JOB_RATE_WINDOW_MS) {
        rate = { at: now, requests: 0, spawns: 0 };
        this.rates.set(pair.id, rate);
      }
      if (++rate.requests > REMOTE_JOB_RATE_LIMIT || frame.request.op === "spawn" && ++rate.spawns > REMOTE_JOB_SPAWN_LIMIT) throw new Error("Remote job rate limit reached; try again later.");
      if (frame.request.op === "spawn" && this.starting.has(frame.request.job)) throw new Error("Remote job is already starting.");
      if (frame.request.op === "spawn") this.starting.add(frame.request.job);
      let value;
      try {
        value = await this.handle(pair, frame.peer, frame.request);
      } finally {
        if (frame.request.op === "spawn") this.starting.delete(frame.request.job);
      }
      const compatible = remoteSnapshotForPeer(value, this.network.peerSupports(pair.id, REMOTE_JOB_CANCELLED_CAPABILITY));
      await this.network.sendExtension(pair.id, REMOTE_JOB_FRAME, { kind: "response", rid: frame.rid, value: compatible });
    } catch (err) {
      await this.network.sendExtension(pair.id, REMOTE_JOB_FRAME, { kind: "response", rid: frame.rid, error: String(err.message).slice(0, 4096) });
    }
  }
  async handle(pair, peer, request) {
    let record = this.records.get(request.job);
    if (record && (record.pair !== pair.id || record.peer !== peer.supervisor)) throw new Error("Remote job belongs to another supervisor.");
    if (request.op === "spawn") {
      const cfg = loadConfig(this.home, request.target, this.log, {});
      const policy = loadConfig(this.home, "other", this.log, {}).network.remoteJobs;
      if (!policy.agents.includes(request.target)) throw new Error("Remote agent is not allowed by network.remoteJobs.agents.");
      if (record && record.job.agent !== request.target) throw new Error("Cannot change a remote job's agent.");
      if (record && this.snapshot(record).alive) throw new Error("Remote job is already running.");
      if ([...this.records.values()].filter((r) => this.snapshot(r).alive).length + this.starting.size > cfg.maxJobs) throw new Error("Remote subagent limit reached.");
      if (!record && this.records.size >= MAX_REMOTE_JOBS) throw new Error("Remote job registry is full.");
      if (!record && request.args.session_id) throw new Error("Remote session continuation requires a job owned by this supervisor.");
      const settings = Object.fromEntries(JOB_SETTING_KEYS.filter((key) => key in request.args).map((key) => [key, request.args[key]]));
      if (Object.keys(settings).length) {
        const parsed = parseJobSettings(settings, request.target);
        if (typeof parsed === "string") throw new Error(parsed);
      }
      let args = { ...request.args, ...request.target === "codex" ? { native_subagents: request.args.native_subagents ?? cfg.codexSubagents } : {} };
      let cwd = allowedRemoteDirectory(args.cwd, policy.allowRoots);
      for (const directory of await gitDirsOutside(cwd, this.log) ?? []) allowedRemoteDirectory(directory, policy.allowRoots);
      let worktree = null;
      if (record) {
        const state = this.snapshot(record).state;
        if (!state?.sessionId) throw new Error("Remote job has no session to continue.");
        cwd = allowedRemoteDirectory(state.workdir ?? cwd, policy.allowRoots);
        worktree = state.worktree ?? null;
        args = resumeArgs(args, record.job.name, args.prompt, state.sessionId, cwd, worktree, { ...args });
      } else if (args.worktree) {
        const repo = allowedRemoteDirectory(await git(["rev-parse", "--show-toplevel"], cwd, this.log), policy.allowRoots);
        if (existsSync3(join3(repo, "worktrees"))) allowedRemoteDirectory(join3(repo, "worktrees"), policy.allowRoots);
        worktree = await createWorktree({ cwd, home: repo, worktreeRoot: cfg.worktreeRoot, jobId: request.job, log: this.log });
        cwd = allowedRemoteDirectory(worktree.cwd, policy.allowRoots);
        args = { ...args, cwd, worktree: false, _worktree: worktree };
      }
      const owner = `${pair.name}/${peer.name}`;
      const job = {
        id: request.job,
        name: `${request.target}-job-${request.job}`,
        agent: request.target,
        model: args.model ?? null,
        prompt: args.prompt,
        args: { ...args },
        owner,
        supervisor: `${pair.id}/${peer.supervisor}`,
        startedAt: Date.now(),
        controller: new AbortController(),
        queue: [],
        status: "running",
        progress: null,
        sessionId: args.session_id ?? null,
        workdir: cwd,
        worktree
      };
      const previous = this.records.get(request.job);
      record = { pair: pair.id, peer: peer.supervisor, owner, job, args: { ...args, cwd, _job: job.name } };
      this.records.set(job.id, record);
      const staged = record;
      const admission = { record: staged, previous, controller: job.controller, cancelRequested: false, committed: false };
      this.pendingStarts.set(job.id, admission);
      const timeout = setTimeout(() => admission.controller.abort(new Error("Remote job not_started: store reader admission exceeded 10 seconds; no detached runner was launched")), 1e4);
      timeout.unref();
      try {
        if (this.closed) throw new Error("Remote broker closed while the job was starting.");
        const host = await this.runners?.startAsync(job, { target: request.target, args: staged.args, base: staged.args, owner, byAgent: "other", cwd, cfg }, {
          signal: admission.controller.signal,
          isCurrent: () => !this.closed && this.records.get(job.id) === staged && this.pendingStarts.get(job.id) === admission && staged.job === job && staged.owner === owner && staged.peer === peer.supervisor && staged.pair === pair.id
        });
        if (!host) throw new Error("Remote job runner is unavailable; update the remote broker's bundled CLI.");
        job.host = host;
        admission.committed = true;
        if (admission.cancelRequested) {
          this.persist();
          await this.control({ owner: staged.owner, name: job.name, id: job.id }, { type: "cancel" });
        }
      } catch (err) {
        if (!job.host && this.records.get(job.id) === staged) {
          if (previous) this.records.set(job.id, previous);
          else this.records.delete(job.id);
        }
        throw err;
      } finally {
        clearTimeout(timeout);
        if (this.pendingStarts.get(job.id) === admission) this.pendingStarts.delete(job.id);
      }
      this.persist();
      this.log.info("remote job started", { host: pair.name, owner, job: job.name, cwd });
    } else {
      if (!record) throw new Error("Unknown remote job.");
      if (request.op === "control") {
        const pending = this.pendingStarts.get(record.job.id);
        if (pending?.record === record) {
          if (request.control.type !== "cancel") throw new Error("Remote job not_started: storage admission is still queued; no runner can receive this control yet");
          pending.cancelRequested = true;
          pending.controller.abort(new Error("Remote job not_started: cancelled before detached runner startup"));
          return { state: null, alive: true, approvals: [] };
        }
        if (request.control.type === "settings") {
          const settings = parseJobSettings(request.control.settings, record.job.agent);
          if (typeof settings === "string") throw new Error(settings);
        }
        await this.control({ owner: record.owner, name: record.job.name, id: record.job.id }, request.control);
        this.log.info("remote job control", { job: record.job.name, control: request.control.type, host: pair.name });
      } else if (request.op === "approval") {
        if (!listPendingApprovals(this.home).some((a) => a.id === request.id && a.job === record.job.name && a.owner === record.owner)) throw new Error("Remote approval expired or belongs to another job.");
        const outcome = await answerPendingApproval(this.home, request.id, { decision: request.decision, reason: request.reason });
        if (outcome !== "answered") throw new Error(`Remote approval ${outcome}.`);
      }
    }
    return this.snapshot(record);
  }
  snapshot(record) {
    const state = readRunnerState(this.home, record.job.id);
    const alive = this.runners?.alive(record.job, state) ?? Boolean(state && state.status === "running");
    return { state, alive, approvals: listPendingApprovals(this.home).filter((a) => a.job === record.job.name && a.owner === record.owner) };
  }
  persist() {
    const committed = [...this.records.values()].flatMap((record) => {
      const pending = this.pendingStarts.get(record.job.id);
      return pending?.record === record && !pending.committed ? pending.previous ? [pending.previous] : [] : [record];
    });
    writeJsonStore(join3(this.home, REMOTE_JOBS_FILE), { jobs: committed.map((r) => {
      const { controller, queue, ...job } = r.job;
      return { ...r, job };
    }) }, readJsonStore(join3(this.home, REMOTE_JOBS_FILE)));
  }
  async mirror(host, peer, request, snapshot, supervisor, localJobName) {
    if (this.closed) return;
    const owner = peer.name;
    const key = `${host}/${request.job}`;
    if (request.op === "spawn") {
      this.mirrorTurns.set(key, {});
      this.mirrorStates.delete(key);
      this.mirrorIntents.get(key)?.controller?.abort(new Error("Remote mirror replaced by a new turn"));
      this.feeds.get(key)?.end("interrupted");
      this.feeds.delete(key);
      this.mirrorIntents.set(key, { snapshot, options: {
        home: this.home,
        name: `${request.target}-${request.job}`,
        header: `${request.target} on ${host}, by ${owner}
${request.args.prompt}
---`,
        meta: {
          by: owner,
          job: localJobName ?? `${request.target}-job-${request.job}`,
          title: request.args.title,
          remote: { host, name: `${request.target}-job-${request.job}` },
          model: request.args.model,
          effort: request.args.effort,
          access: request.args.access ?? (request.args.worktree ? "edit" : "default"),
          workdir: request.args.cwd,
          ...{ remoteSpawnArgs: { ...request.args } }
        }
      } });
      this.log.info("requested remote job", { host, job: request.job, owner });
    }
    const previous = this.mirrorStates.get(key);
    if (previous && (!snapshot.state || snapshot.state.updatedAt < previous.updatedAt || snapshot.state.updatedAt === previous.updatedAt && previous.status !== "running" && snapshot.state.status === "running")) snapshot = { ...snapshot, state: previous };
    const state = snapshot.state;
    if (state) this.mirrorStates.set(key, state);
    if (!this.feeds.has(key) && !this.mirrorIntents.has(key) && state?.status === "running") {
      this.mirrorIntents.set(key, { snapshot, options: {
        home: this.home,
        name: state.peer,
        header: `Reattached remote job on ${host}, by ${owner}`,
        meta: { by: owner, job: localJobName ?? state.peer, remote: { host, name: state.peer } }
      } });
    }
    const intent = this.mirrorIntents.get(key);
    if (intent) {
      intent.snapshot = snapshot;
      this.prepareMirror(key, intent);
    }
    this.updateMirror(key, snapshot);
    const active = new Set(snapshot.approvals.map((a) => `${key}/${a.id}`));
    for (const [id, close] of this.approvals) if (id.startsWith(`${key}/`) && !active.has(id)) {
      close();
      this.approvals.delete(id);
    }
    for (const approval of snapshot.approvals) {
      const id = `${key}/${approval.id}`;
      if (this.approvals.has(id) || this.publishingApprovals.has(id)) continue;
      this.publishingApprovals.add(id);
      try {
        const close = await publishApproval(this.home, { ...approval, owner, job: `${host}/${approval.job}` }, async (body) => {
          if (Date.now() >= approval.deadline) return false;
          try {
            await this.request(host, peer, { op: "approval", job: request.job, id: approval.id, decision: body.startsWith("allow") ? "allow" : "deny", reason: body.includes(":") ? body.slice(body.indexOf(":") + 1).trim() : void 0 }, supervisor);
            return true;
          } catch {
            return false;
          }
        });
        if (this.closed) close();
        else this.approvals.set(id, close);
      } finally {
        this.publishingApprovals.delete(id);
      }
    }
  }
  /** Context admission is local background work, never a second remote spawn or an RPC wait.
   * A later state poll retries a timed-out intent with its original spawn options and latest facts. */
  prepareMirror(key, intent) {
    if (intent.task || this.closed) return;
    const controller = new AbortController();
    intent.controller = controller;
    const timer = setTimeout(() => controller.abort(new Error("Local remote-run mirror metadata admission exceeded 2 seconds; retry on the next state poll")), 2e3);
    timer.unref();
    intent.task = startRunFeedReady(intent.options, controller.signal).then((feed) => {
      if (this.closed || controller.signal.aborted || this.mirrorIntents.get(key) !== intent) {
        feed.end("interrupted");
        return;
      }
      this.feeds.set(key, feed);
      this.updateMirror(key, intent.snapshot);
      this.mirrorIntents.delete(key);
    }).catch((error) => {
      if (!this.closed && this.mirrorIntents.get(key) === intent) this.log.warn("remote result retained; local run mirror context pending", { key, err: String(error) });
    }).finally(() => {
      clearTimeout(timer);
      if (intent.controller === controller) {
        intent.controller = void 0;
        intent.task = void 0;
      }
    });
  }
  updateMirror(key, snapshot) {
    const feed = this.feeds.get(key), state = snapshot.state;
    if (!feed || !state) return;
    feed.meta({ session: state.sessionId, workdir: state.workdir ?? void 0, model: state.model, percent: state.percent, progressNote: state.progressNote, etaAt: state.etaAt, etaReportedAt: state.etaReportedAt });
    if (state.progress) feed.report(state.progress);
    if (state.status !== "running") {
      feed.end(state.status, state.report);
      this.feeds.delete(key);
    }
  }
  close() {
    this.closed = true;
    for (const intent of this.mirrorIntents.values()) intent.controller?.abort(new Error("Remote mirror broker closed"));
    this.mirrorIntents.clear();
    this.mirrorTurns.clear();
    this.mirrorStates.clear();
    for (const pending of this.pendingStarts.values()) pending.controller.abort(new Error("Remote job not_started: broker closed before detached runner startup"));
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Remote jobs link closed."));
    }
    this.pending.clear();
    for (const close of this.approvals.values()) close();
    this.approvals.clear();
    for (const feed of this.feeds.values()) feed.end("interrupted");
    this.feeds.clear();
  }
};

// src/core/owner-question-service.ts
import { createHash } from "node:crypto";
var OWNER_ADDRESS = { id: "owner:dashboard", name: "you", agent: "other" };
var OwnerQuestionService = class {
  constructor(home, messages, log, peers, emit, publishDecision) {
    this.home = home;
    this.messages = messages;
    this.log = log;
    this.peers = peers;
    this.emit = emit;
    this.publishDecision = publishDecision;
    this.store = new OwnerQuestionStore(home, log);
    this.timer = setInterval(() => this.tick(), 2e3);
    this.timer.unref();
  }
  home;
  messages;
  log;
  peers;
  emit;
  publishDecision;
  store;
  tabs = /* @__PURE__ */ new Map();
  alerts = /* @__PURE__ */ new Map();
  mirrors = /* @__PURE__ */ new Set();
  timer;
  closed = false;
  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.store.close();
  }
  settings() {
    return loadConfig(this.home, "other", this.log).questionAlerts;
  }
  heartbeat(tab, visible) {
    this.tabs.set(tab, { tab, visible, at: Date.now() });
    const alerts = (this.alerts.get(tab) ?? []).filter((a) => this.store.get(a.id)?.status === "open");
    this.alerts.delete(tab);
    return { alerts, settings: this.settings() };
  }
  list() {
    return this.store.list().map((q) => ({ ...q, deliveries: q.deliveries.map((d) => ({
      ...d,
      readAt: d.messageId ? this.messages.receipts(d.messageId).find((r) => r.recipient === d.recipient)?.readAt ?? d.readAt : d.readAt
    })) }));
  }
  complete(q) {
    if (!q.answer) return q;
    if (q.answer.pin && !q.answer.decisionId) {
      const prior = this.messages.decisions.list({ history: true }).find((d) => d.sourceMessageId === q.id);
      const decision = prior ?? this.messages.decisions.record({ ...q.answer.pin, text: q.answer.text, sourceMessageId: q.id }, q.answer.author, q.answer.at);
      this.publishDecision?.(decision);
      q.answer.decisionId = decision.id;
      this.store.save(q);
    }
    const peers = this.peers();
    const mains = peers.filter((p) => !p.jobAgent && !p.subagent && !p.unavailable && normalizeProject(p.projectRoot ?? p.cwd) === normalizeProject(q.project));
    const main = mains.find((p) => p.projectMain) ?? mains[0];
    const destinations = q.askers.flatMap((a) => [{ name: a.session, sessionId: a.sessionId, peerId: a.peerId }, { name: a.main, sessionId: a.mainSessionId, peerId: a.mainPeerId }, ...a.job ? [{ name: a.job, sessionId: null, peerId: void 0 }] : []]);
    const resolveDestination = (name) => {
      const identities = destinations.filter((d) => d.name === name && (d.sessionId || d.peerId));
      return peers.find((p) => !p.unavailable && normalizeProject(p.projectRoot ?? p.cwd) === normalizeProject(q.project) && (identities.length ? identities.some((d) => d.sessionId ? p.sessionId === d.sessionId : p.id === d.peerId) : p.name === name));
    };
    const askerNames = new Set(q.askers.flatMap((a) => [resolveDestination(a.session)?.name ?? a.session, ...a.job ? [a.job] : []]));
    const mainRead = q.deliveries.some((d) => (q.askers.some((a) => (resolveDestination(a.main)?.name ?? a.main) === d.recipient) || !askerNames.has(d.recipient)) && d.messageId && this.messages.receipts(d.messageId).some((r) => r.readAt !== null));
    const recipients = new Set(destinations.map((d) => resolveDestination(d.name)?.name ?? d.name));
    if (main && !mainRead) recipients.add(main.name);
    let changed = false;
    for (const recipient of recipients) {
      const original = resolveDestination(recipient), fallback = !original && main && !mainRead && main.name === recipient ? main : void 0;
      const live = original ?? fallback;
      const before = q.deliveries.find((d) => d.recipient === recipient);
      if (before?.messageId) {
        const readAt = this.messages.receipts(before.messageId).find((r) => r.recipient === recipient)?.readAt;
        if (!readAt && before.state === "wake-requested" && Date.now() - q.answer.at >= 2e4) {
          before.state = "unconfirmed";
          before.detail = "Wake consumption unconfirmed after 20 s. Durable inbox retained; project-main fallback receives the same recorded answer.";
          changed = true;
        }
        continue;
      }
      if (!live && (destinations.some((d) => d.name === recipient && (d.sessionId || d.peerId)) || peers.some((p) => p.name === recipient))) {
        const offline = { recipient, state: "offline", detail: "Original session is absent or replaced. Answer retained on the question; current project-main fallback receives it.", readAt: null };
        if (JSON.stringify(before) !== JSON.stringify(offline)) {
          q.deliveries = [...q.deliveries.filter((d) => d.recipient !== recipient), offline];
          changed = true;
        }
        continue;
      }
      const hash = createHash("sha256").update(`owner-question:${q.id}:${recipient}`).digest("hex");
      const messageId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      const message = {
        id: messageId,
        from: q.answer.author,
        to: recipient,
        recipient,
        conversationId: `owner-question-${q.id}`,
        replyTo: q.id,
        hop: 0,
        createdAt: q.answer.at,
        readAt: null,
        body: `Owner answer to question ${q.id}: ${q.title}

${q.answer.text}

${JSON.stringify({ questionId: q.id, option: q.answer.option, author: q.answer.author, at: q.answer.at, source: q.answer.source, decisionId: q.answer.decisionId })}
An answer does not bypass native approvals, expand authorization or accept implementation.`
      };
      const inserted = this.messages.insertOnce(message);
      let failed = false;
      if (inserted && live) {
        try {
          this.emit(live, message);
        } catch {
          failed = true;
        }
      }
      const wake = Boolean(live?.wakeAvailable && (live.autoWake || live.wakeOnDirect));
      const delivery = {
        recipient,
        messageId,
        state: failed ? "failed" : !live ? "offline" : live.activity === "busy" ? "busy" : wake ? "wake-requested" : "wake-unavailable",
        detail: failed ? "Direct delivery failed. Durable inbox retained; project-main fallback receives the same answer." : !live ? `Asker offline; retained for reconnection. ${main ? "Also sent to project main " + main.name : "No available project main; fallback pending."}` : live.activity === "busy" ? "Queued for next hook or idle turn; awaiting consumption." : wake ? "Direct wake requested; awaiting consumption." : `Wake unavailable or disabled; durable inbox retained. ${main && main.name !== recipient ? "Also sent to project main " + main.name : "No alternate project main available."}`,
        readAt: null
      };
      if (fallback) delivery.detail = "Original session is absent; this answer goes to the current project main as fallback. " + delivery.detail;
      q.deliveries = [...q.deliveries.filter((d) => d.recipient !== recipient), delivery];
      changed = true;
    }
    if (changed) this.store.save(q);
    if (mainRead && !q.deliveryComplete) {
      q.deliveryComplete = true;
      this.store.save(q);
    }
    if (q.mirror?.state !== "saved" && (q.mirror?.nextAttempt ?? 0) <= Date.now() && q.links.some((l) => l.kind === "issue") && !this.mirrors.has(q.id)) {
      this.mirrors.add(q.id);
      void this.mirror(q).finally(() => this.mirrors.delete(q.id));
    }
    return q;
  }
  async mirror(q) {
    try {
      for (const link of q.links.filter((l) => l.kind === "issue")) {
        if (q.mirror?.issues?.includes(link.value)) continue;
        const issueUrl = `http://127.0.0.1:8765/api/issues/${encodeURIComponent(link.value)}`;
        const issue = await fetch(issueUrl, { signal: AbortSignal.timeout(3e3) });
        if (!issue.ok) throw new Error(`Pair Desk lookup HTTP ${issue.status}`);
        const existing = await issue.json();
        if (!existing.comments?.some((c) => c.text.includes(`Owner answer recorded (${q.id})`))) {
          const response = await fetch(`http://127.0.0.1:8765/api/issues/${encodeURIComponent(link.value)}/comments`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal: AbortSignal.timeout(3e3),
            body: JSON.stringify({ author: "owner via agent-bridge", text: `**Owner answer recorded (${q.id}).**

${q.answer.text}

**Owner:** ${q.answer.author.name}
**Time:** ${new Date(q.answer.at).toISOString()}
**Source:** ${q.answer.source}
${q.answer.decisionId ? "**Decision:** " + q.answer.decisionId + "\n" : ""}Answered is not implementation acceptance; native approvals still apply.` })
          });
          if (!response.ok) throw new Error(`Pair Desk mirror HTTP ${response.status}`);
        }
        if (this.closed) return;
        q = this.store.get(q.id);
        q.mirror = { state: "pending", issues: [...q.mirror?.issues ?? [], link.value] };
        this.store.save(q);
      }
      if (this.closed) return;
      q = this.store.get(q.id);
      q.mirror = { state: "saved" };
      this.store.save(q);
    } catch (error) {
      if (this.closed) return;
      q = this.store.get(q.id);
      q.mirror = { ...q.mirror, state: "failed", detail: String(error), nextAttempt: Date.now() + 6e4 };
      this.store.save(q);
    }
  }
  tick() {
    try {
      const at = Date.now(), settings = this.settings();
      for (const [id, t] of this.tabs) if (at - t.at > 1e4) {
        this.tabs.delete(id);
        this.alerts.delete(id);
      }
      for (const q of this.store.work()) {
        if (q.status === "answered") {
          this.complete(q);
          continue;
        }
        if (q.status !== "open") continue;
        if (q.default && at >= q.default.deadline) {
          this.complete(this.store.answer(q.id, { option: q.default.option }, { id: "declared-default", name: "Declared default (not the owner)", agent: "other" }, at, "declared-default"));
          continue;
        }
        const choice = questionAlertChannel([...this.tabs.values()], at);
        if (choice.channel === "desktop" && !settings.toast) continue;
        if (!this.store.claimAlert(q.id, choice.channel, at, q.blocking ? settings.reminderMinutes * 6e4 : 0)) continue;
        if (choice.tab) {
          const list = this.alerts.get(choice.tab) ?? [];
          list.push({ id: q.id, at });
          this.alerts.set(choice.tab, list);
        } else {
          const port = readDashboardInfo(this.home)?.port ?? loadConfig(this.home, "other", this.log).dashboardPort;
          const url = `http://127.0.0.1:${port}/?t=${loadDashboardKey(this.home)}#/approvals?question=${q.id}`;
          notifyOwnerQuestion(url, this.log, settings.sound);
        }
      }
    } catch (error) {
      this.log.warn("owner question maintenance failed", { error: String(error) });
    }
  }
};

// src/core/broker.ts
var PEER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var PENDING_DEFAULT_LIMIT = 50;
var DEDUPE_KEEP_MS = 30 * 60 * 1e3;
var DEDUPE_MAX = 5e3;
var PENDING_MAX_LIMIT = 500;
var NAME_SUFFIX_LIMIT = 100;
var MAX_FILE_ADDRESS_CHARS = 256;
var MAX_FILE_PATH_CHARS = 1024;
var SIBLING_STATUSES = /* @__PURE__ */ new Set(["running", "done", "failed", "interrupted", "cancelled"]);
var MAX_INFLIGHT_PER_CONNECTION = 128;
var PAUSE_INFLIGHT_PER_CONNECTION = 32;
var MAX_CONNECTION_BUFFER_BYTES = 4 * MAX_FRAME_BYTES;
var HANDOFF_STORE_READY_MS = 5500;
var UNAUTHENTICATED_OPS = /* @__PURE__ */ new Set(["hello", "auth", "ping"]);
var Broker = class {
  constructor(pipePath, store, log, token, now = Date.now, jobsPath, networking) {
    this.pipePath = pipePath;
    this.store = store;
    this.log = log;
    this.token = token;
    this.now = now;
    this.jobsPath = jobsPath;
    this.networking = networking;
    this.groups = new ProjectGroups(jobsPath ? dirname3(jobsPath) : void 0);
    this.handlers = {
      askOwner: (c, a) => {
        const peer = this.requirePeer(c);
        if (peer.jobAgent || peer.subagent || peer.agent === "other") throw new BridgeError("unauthorized", "Delegated jobs ask their main; only project sessions file owner questions.");
        const args = askOwnerSchema.parse(a), root = this.groups.root(peer.cwd);
        if (!root || args.project && !this.groups.same(args.project, peer.cwd)) throw new BridgeError("unauthorized", "File questions only for your own project.");
        if (args.job && !this.storedJobs().some((j) => j.name === args.job && this.groups.canControl(peer, j, this.localPeers()))) throw new BridgeError("unauthorized", "Linked job must belong to this project session.");
        const main = this.localPeers().find((p) => this.groups.same(p.cwd, peer.cwd) && this.projectPeer(p).projectMain);
        let deskProject = args.deskProject;
        try {
          const linked = readJsonSnapshot(join4(root, ".pair-desk.json")).value;
          if (isRecord(linked) && typeof linked.project === "string") deskProject = linked.project;
        } catch {
        }
        return this.ownerQuestions().store.ask(args, root, { session: peer.name, sessionId: peer.sessionId, peerId: peer.id, agent: peer.agent, main: main?.name ?? peer.name, mainSessionId: main ? main.sessionId : peer.sessionId, mainPeerId: main?.id ?? peer.id, ...args.job ? { job: args.job } : {} }, this.now(), deskProject);
      },
      ownerQuestions: () => this.ownerQuestions().list(),
      answerOwner: (c, a) => {
        if (c.peer) throw new BridgeError("unauthorized", "Only the local owner dashboard can answer questions.");
        const args = external_exports.object({ id: external_exports.uuid(), answer: questionAnswerSchema }).strict().parse(a);
        return this.ownerQuestions().complete(this.ownerQuestions().store.answer(args.id, args.answer, OWNER_ADDRESS, this.now()));
      },
      dismissOwner: (c, a) => {
        const args = external_exports.object({ id: external_exports.uuid(), status: external_exports.enum(["cancelled", "superseded"]), reason: external_exports.string().trim().min(1).max(1e3), supersededBy: external_exports.uuid().optional() }).strict().parse(a);
        const q = this.ownerQuestions().store.get(args.id);
        if (c.peer && (c.peer.jobAgent || c.peer.subagent || !q?.askers.some((asker) => asker.sessionId && c.peer.sessionId ? asker.agent === c.peer.agent && asker.sessionId === c.peer.sessionId : asker.peerId ? asker.peerId === c.peer.id : asker.session === c.peer.name))) throw new BridgeError("unauthorized", "Only an asker or the owner may dismiss this question.");
        return this.ownerQuestions().store.dismiss(args.id, args.status, args.reason, args.supersededBy);
      },
      dashboardHeartbeat: (c, a) => {
        if (c.peer) throw new BridgeError("unauthorized", "Only the local dashboard reports presence.");
        const args = external_exports.object({ tab: external_exports.string().regex(/^[\w-]{1,80}$/), visible: external_exports.boolean() }).strict().parse(a);
        return this.ownerQuestions().heartbeat(args.tab, args.visible);
      },
      projectMain: (c, a) => {
        const args = external_exports.object({ to: external_exports.string().min(1) }).strict().parse(a);
        return this.switchProjectMain(c.peer, this.connByName(args.to)?.peer ?? void 0);
      },
      projectJobs: async (c) => {
        const peer = this.requirePeer(c);
        if (this.jobsPath && this.historyBackground) {
          try {
            await this.historyBackground.reconcileAsks();
          } catch (error) {
            this.log.debug("ask reconciliation deferred; records retained", { error: String(error) });
          }
        }
        const known = new Set(this.storedJobs().map((job) => job.name));
        for (const runner of this.conns) if (runner.peer?.jobAgent && !known.has(runner.peer.name)) await this.jobForControl(peer, runner.peer.name);
        this.jobsForDispatch = null;
        let activeIds = /* @__PURE__ */ new Set();
        try {
          const data = readJsonSnapshot(this.jobsPath).value;
          const rows = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.jobs) ? data.jobs : void 0;
          if (!rows) return [];
          activeIds = new Set(rows.filter(isRecord).map((record) => record.id));
        } catch (error) {
          if (error.code !== "ENOENT") return [];
        }
        const stored = this.storedJobs();
        const jobs = this.jobsPath && !this.historyBackground ? await projectAskCompletions(this.jobsPath, stored) : stored;
        const retained = this.jobsPath ? selectHistoryJobs(dirname3(this.jobsPath), new Set(jobs.filter((job) => !activeIds.has(job.id)).map((job) => String(job.name)))) : /* @__PURE__ */ new Map();
        return jobs.map((job) => activeIds.has(job.id) ? job : { ...job, ...retained.get(String(job.name)) }).filter((job) => this.groups.canControl(peer, job, this.localPeers()));
      },
      coordinatorAvailability: (c, a) => {
        const args = external_exports.object({ name: external_exports.string().optional(), unavailable: external_exports.boolean() }).strict().parse(a);
        if (!c.peer && !args.name) throw new BridgeError("bad_request", "A coordinator name is required.");
        const target = args.name ? this.connByName(args.name) : c;
        if (!target?.peer || target.peer.jobAgent || target.peer.subagent) throw new BridgeError("bad_request", "A live local master is required.");
        if (c.peer && target !== c) throw new BridgeError("unauthorized", "A session can only change its own availability.");
        return this.onUpdatePeer(target, { unavailable: args.unavailable });
      },
      handoffSubagents: async (c, a) => {
        const parsed = handoffSchema.safeParse(a);
        if (!parsed.success) throw new BridgeError("bad_request", "Invalid handoff arguments.");
        const source = this.requirePeer(c);
        if (parsed.data.to.includes("/")) throw new BridgeError("bad_request", "Paired-PC handoff is not supported; choose an exact live local session name.");
        const targetConn = this.connByName(parsed.data.to), target = targetConn?.peer;
        if (!target || !targetConn) throw new BridgeError("unknown_target", "The target must be an exact live local session name.");
        if (!this.jobsPath) throw new BridgeError("bad_request", "The job registry is unavailable.");
        const registration = (peer) => ({ id: peer.id, name: peer.name, sessionId: peer.sessionId, cwd: peer.cwd });
        const sourceRegistration = registration(source), targetRegistration = registration(target);
        await this.awaitHandoffReaders(c, targetConn);
        this.assertHandoffRegistration(c, source, sourceRegistration);
        this.assertHandoffRegistration(targetConn, target, targetRegistration);
        this.jobsForDispatch = null;
        if (parsed.data.switch_project_main && (parsed.data.jobs !== "all" || !this.projectPeer(source).projectGroup || this.projectPeer(source).projectGroup !== this.projectPeer(target).projectGroup)) {
          throw new BridgeError("unauthorized", "Switching the project main requires all jobs and a target in the same project group.");
        }
        const receipt = commitHandoff(this.jobsPath, source, target, parsed.data, { canControl: (job) => this.groups.canControl(source, job, this.localPeers()) });
        if (parsed.data.switch_project_main) this.switchProjectMain(source, target);
        this.jobsSnapshot = null;
        this.jobsForDispatch = null;
        this.applyHandoffs();
        for (const conn of this.conns) if (conn.peer) this.emit(conn, "jobs_changed", { withdrawn: conn.peer.name === source.name ? receipt.jobs.map((j) => j.id) : [] });
        return receipt;
      },
      jobAuthority: async (c, a) => {
        const peer = this.requirePeer(c), job = this.currentJobAuthority(await this.jobForControl(peer, a.job));
        if (!job || !this.groups.canControl(peer, job, this.localPeers())) return null;
        return job;
      },
      jobRecipient: async (c, a) => {
        const peer = this.requirePeer(c), job = this.currentJobAuthority(await this.jobForControl(peer, a.job));
        if (!job || !this.groups.canControl(peer, job, this.localPeers())) throw new BridgeError("unauthorized", "Only a master can inspect the job recipient.");
        return this.jobRecipient(job);
      },
      inlineJobControl: async (c, a) => {
        const peer = this.requirePeer(c), job = this.currentJobAuthority(await this.jobForControl(peer, a.job));
        if (!job || !this.groups.canControl(peer, job, this.localPeers())) throw new BridgeError("unauthorized", "Only the current supervisor can control this job.");
        if (!a.control || !["message", "title", "settings", "effort", "cancel"].includes(a.control.type)) throw new BridgeError("bad_request", "Invalid inline control.");
        if (job.host && job.status === "running") {
          await this.onSend(c, { to: String(job.name), body: JSON.stringify(a.control), conversationId: `${CONTROL_CONVERSATION_PREFIX}${job.id}` });
          return { sent: true };
        }
        const executor = typeof (job.executionOwner ?? job.owner) === "string" ? this.connByName(String(job.executionOwner ?? job.owner)) : void 0;
        if (job.status !== "running") {
          const recipient = this.jobRecipient(job);
          const primary = this.connByName(recipient);
          if (!primary) throw new BridgeError("unknown_target", "No job master is currently connected.");
          this.emit(primary, "shared_job_control", a);
          return { sent: true };
        }
        if (!executor) throw new BridgeError("unknown_target", "The inline job's executor is offline.");
        this.emit(executor, "inline_job_control", a);
        return { sent: true };
      },
      inlineJobReport: async (c, m) => {
        const peer = this.requirePeer(c);
        await this.store.retryWrite(() => {
          const job = this.storedJobs().find((j) => `job:${j.id}` === m.from?.id);
          if (!job || job.executionOwner !== peer.name && job.owner !== peer.name && job.rootName !== peer.name || typeof job.owner !== "string" || typeof m.body !== "string" || m.body.length > MAX_BODY_CHARS) throw new BridgeError("unauthorized", "Invalid inline job delivery.");
          const recipient = this.jobRecipient(job);
          const message = { ...m, to: recipient, recipient, conversationId: this.jobConversation(job, recipient, m.conversationId) };
          if (this.store.insertJobDelivery(message)) {
            const target = this.connByName(recipient);
            if (target && !target.peer?.unavailable) this.emit(target, "message", message);
          }
        });
        return { saved: true };
      },
      auth: (c, a) => {
        this.checkAuth(a.protocol, a.token);
        c.authed = true;
        return { brokerPid: process.pid };
      },
      hello: async (c, a) => {
        const result = await this.onHello(c, a);
        const job = this.storedJobs().find((j) => `job:${j.id}` === c.peer?.id);
        if (job?.ownershipHistory) this.refreshJobPeer(job);
        void this.routePendingJobMail().catch((err) => this.log.warn("pending job reroute deferred", { err: String(err) }));
        this.store.history.rememberPeer(c.peer);
        return result;
      },
      send: (c, a) => this.onSend(c, { ...a, messageId: void 0 }),
      trackedSend: (c, a) => this.onTrackedSend(c, a),
      sendState: (c, a) => this.sendState(c, external_exports.uuid().parse(a.id).toLowerCase()),
      decide: (c, a) => this.onDecide(c, a),
      decisions: (c, a) => this.onDecisions(c, a),
      searchHistory: (_, a) => {
        const parsed = historySearchSchema.safeParse(a);
        if (!parsed.success) throw new BridgeError("bad_request", "Invalid history query or filters.");
        return this.store.history.search(parsed.data);
      },
      getConversation: (_, a) => readConversation(this.store.history.database, conversationPageSchema.parse(a)),
      reindexHistory: (_, a) => {
        const args = external_exports.object({ reset: external_exports.boolean().optional() }).strict().parse(a);
        if (this.historyBackground) return this.historyBackground.tick(args.reset);
        if (this.store.file !== ":memory:") return { work: 0, discovering: false };
        if (args.reset) this.store.history.reset();
        return this.store.history.tick();
      },
      peers: () => this.livePeers(),
      brokerLoad: () => ({ connectedJobs: [...this.conns].filter((conn) => conn.peer?.jobAgent).length, testedJobs: BROKER_TESTED_JOB_LOAD }),
      dashboardPeers: () => this.dashboardPeers().concat(this.network?.peers() ?? []),
      dashboardRead: (_, a) => this.remoteDashboard?.request(a.host, a.request) ?? dashboardError("remote_offline", "Networking is unavailable."),
      siblings: (c) => this.siblingPeers(c),
      sendSibling: (c, a) => this.onSendSibling(c, a),
      guardedSend: (c, a) => {
        if (!a.ifNoNewerThan) throw new BridgeError("bad_request", "guardedSend requires if_no_newer_than");
        return this.onSend(c, a);
      },
      messageReceipt: (c, a) => this.messageReceipt(c, a.id),
      ack: async (c, a) => ({ acked: await this.store.retryWrite(() => this.store.markRead(this.requirePeer(c).name, a.ids ?? [], this.now())) }),
      pending: (c, a) => {
        const peer = this.requirePeer(c);
        return this.queueReady(c, peer) ? this.pendingMail(peer.name, Math.min(Math.max(1, a.limit ?? PENDING_DEFAULT_LIMIT), PENDING_MAX_LIMIT)) : [];
      },
      updatePeer: async (c, a) => {
        const peer = await this.onUpdatePeer(c, a);
        const job = this.storedJobs().find((j) => `job:${j.id}` === peer.id);
        if (job?.ownershipHistory) this.refreshJobPeer(job);
        this.store.history.rememberPeer(peer);
        return peer;
      },
      claimMail: (c, a) => this.onClaimMail(c, a),
      health: () => this.healthMonitor.snapshot(APP_VERSION, this.historyBackground?.status() ?? null, this.store.backupStatus()),
      ping: () => ({
        brokerPid: process.pid,
        protocol: PROTOCOL_VERSION,
        brokerVersion: APP_VERSION,
        health: this.healthMonitor.snapshot(APP_VERSION, this.historyBackground?.status() ?? null, this.store.backupStatus())
      }),
      networkStatus: () => this.network?.status() ?? { enabled: false, config: this.networking?.config, discovered: [], paired: [] },
      remoteJob: async (c, a) => {
        const peer = this.requirePeer(c);
        if (peer.jobAgent) throw new BridgeError("bad_request", "Only supervisor sessions can request remote jobs.");
        if (!this.remoteJobs) throw new BridgeError("bad_request", "Remote broker update needed or networking unavailable.");
        const saved = this.storedJobs().find((job) => job.id === a.request.job && job.owner === peer.name);
        const supervisor = typeof saved?.supervisor === "string" ? saved.supervisor : peer.sessionId ?? peer.id;
        const snapshot = await this.remoteJobs.request(a.host, peer, a.request, supervisor, typeof saved?.name === "string" ? saved.name : void 0);
        const progress = snapshot.state?.progress;
        const key = `${a.host}/${a.request.job}`;
        if (progress && this.remoteProgress.get(key) !== progress) {
          this.remoteProgress.set(key, progress);
          const pair = this.requireNetwork().status().paired.find((p) => p.id === a.host || p.name === a.host);
          const name = snapshot.state.peer;
          this.receiveRemote({
            id: randomUUID3(),
            from: { id: `${pair?.id ?? a.host}/job:${a.request.job}`, name: `${pair?.name ?? a.host}/${name}`, agent: "other" },
            to: peer.name,
            recipient: peer.name,
            body: progress,
            conversationId: `job-${a.request.job}:note`,
            replyTo: null,
            hop: 0,
            createdAt: this.now(),
            readAt: null
          });
        }
        return snapshot;
      },
      networkConfigure: (_, a) => {
        const change = this.networkChange.then(() => this.configureNetwork(a));
        this.networkChange = change.catch(() => {
        });
        return change;
      },
      networkVerify: (_, a) => this.requireNetwork().verify(external_exports.uuid().parse(a.id)),
      networkPair: () => this.requireNetwork().keys.inviteWithExpiry(),
      networkLink: async (_, a) => {
        try {
          const args = external_exports.object({ code: external_exports.string().min(1).max(MAX_PAIRING_CODE_CHARS), host: external_exports.string().min(1).max(MAX_NETWORK_HOST_CHARS), port: external_exports.number().int().min(1).max(MAX_PORT) }).parse(a);
          return await this.requireNetwork().link(args.code, args.host, args.port);
        } catch {
          throw new BridgeError("bad_request", "Pairing failed. Check the address, code expiry, unique names and existing pairings.");
        }
      },
      networkUnlink: (_, a) => {
        const id = external_exports.uuid().parse(a.id);
        const network = this.requireNetwork();
        const removed = network.status().paired.some((p) => p.id === id);
        network.unlink(id);
        return { removed };
      },
      sendFiles: (c, a) => this.onSendFiles(c, a),
      fetchFiles: (c, a) => {
        const sender = this.requirePeer(c);
        const args = external_exports.object({ from: external_exports.string().min(1).max(MAX_FILE_ADDRESS_CHARS), paths: external_exports.array(external_exports.string().min(1).max(MAX_FILE_PATH_CHARS)).min(1).max(MAX_STREAM_ENTRIES) }).parse(a);
        return this.requireNetwork().startFiles(args.from, args.paths, sender.cwd, { id: sender.id, name: sender.name, agent: sender.jobAgent ?? sender.agent }, true);
      },
      transfers: () => ({ transfers: this.network?.transfers.list() ?? (this.networking ? readTransferHistory(this.networking.home) : []) }),
      cancelTransfer: (_, a) => {
        const id = external_exports.uuid().parse(a.id);
        if (this.network) return this.network.transfers.cancel(id);
        if (!this.networking) throw new Error("transfer inbox home is unavailable");
        return cancelStoredTransfer(this.networking.home, id);
      }
    };
  }
  pipePath;
  store;
  log;
  token;
  now;
  jobsPath;
  networking;
  questions = null;
  ownerQuestions() {
    return this.questions ??= new OwnerQuestionService(dirname3(this.store.file), this.store, this.log, () => this.localPeers().map((p) => this.projectPeer(p)), (peer, message) => {
      const c = this.connByName(peer.name);
      if (c) this.emit(c, "message", message);
    }, (decision) => {
      for (const c of this.conns) if (c.peer && !c.peer.jobAgent && decisionApplies(decision, c.peer)) {
        const message = this.queueDecision(decision, c.peer);
        if (message) this.emit(c, "message", message);
      }
    });
  }
  groups;
  /** Live role selection, recomputed after broker restart; no durable ownership is rewritten. */
  projectMains = /* @__PURE__ */ new Map();
  projectRoutes = /* @__PURE__ */ new Map();
  server = null;
  conns = /* @__PURE__ */ new Set();
  historyBackground = null;
  jobArchiveBackground = null;
  healthMonitor = new HealthMonitor();
  historyPendingRequests = 0;
  purgeTimer = null;
  pendingJobMailRoute = null;
  pendingJobMailRouteAgain = false;
  pendingJobMailRetry = null;
  closing = false;
  requestTurn = Promise.resolve();
  network = null;
  remoteJobs = null;
  remoteDashboard = null;
  remoteProgress = /* @__PURE__ */ new Map();
  networkChange = Promise.resolve();
  handlers;
  jobsSnapshot = null;
  jobsForDispatch = null;
  recoveredJobs = /* @__PURE__ */ new Map();
  /** Bind the endpoint. Rejects with the socket error (EADDRINUSE when another broker owns it). */
  listen() {
    return new Promise((resolve, reject) => {
      const server = createServer2((socket) => this.accept(socket));
      const onError = (err) => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = async () => {
        server.removeListener("error", onError);
        server.on("error", (err) => this.log.error("broker server error", { err }));
        this.server = server;
        if (this.jobsPath && this.store.file !== ":memory:") this.jobArchiveBackground = new JobArchiveBackground(this.jobsPath, this.log);
        this.store.startBackups();
        this.healthMonitor.start();
        this.applyHandoffs();
        this.purgeTimer = setInterval(() => this.purge(), PURGE_INTERVAL_MS);
        this.purgeTimer.unref();
        if (this.store.file !== ":memory:" && !["false", "0"].includes(process.env.AGENT_BRIDGE_HISTORY_INGEST ?? "")) {
          this.historyBackground = new HistoryBackground(this.store.file, this.log);
          this.store.historyPeerSink = (peer) => this.historyBackground?.rememberPeer(peer);
          void this.historyBackground.reconcileAsks().catch((error) => this.log.debug("startup ask reconciliation deferred", { error: String(error) }));
        }
        this.purge();
        this.log.info("broker listening", { pipe: this.pipePath });
        if (this.store.file !== ":memory:" && existsSync4(join4(dirname3(this.store.file), QUESTIONS_FILE))) this.ownerQuestions();
        if (this.networking) this.networking.config = readNetworkConfig(this.networking.home, this.networking.config);
        if (this.networking?.config.enabled) {
          try {
            this.network = new NetworkService(this.networking.home, this.networking.config, {
              peers: () => this.dashboardPeers(),
              receive: (message) => this.receiveRemote(message),
              receipt: (id, sender, recipient) => this.remoteReceipt(id, sender, recipient),
              recipientReceipts: true
            }, this.log);
            this.installRemoteJobs(this.network);
            await this.network.start();
          } catch (err) {
            this.remoteDashboard?.close();
            this.remoteDashboard = null;
            this.remoteJobs?.close();
            this.remoteJobs = null;
            await this.network?.close();
            this.network = null;
            this.log.warn("networking could not start; local broker remains available", { message: err.message });
          }
        }
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.pipePath);
    });
  }
  async close() {
    this.healthMonitor.close();
    this.closing = true;
    this.questions?.close();
    this.questions = null;
    this.store.stopWrites();
    if (this.pendingJobMailRetry) clearTimeout(this.pendingJobMailRetry);
    this.pendingJobMailRetry = null;
    await this.historyBackground?.close();
    await this.jobArchiveBackground?.close();
    this.jobArchiveBackground = null;
    this.historyBackground = null;
    await this.store.closeBackups();
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    await this.networkChange;
    this.remoteDashboard?.close();
    this.remoteDashboard = null;
    this.remoteJobs?.close();
    this.remoteJobs = null;
    await this.network?.close();
    this.network = null;
    for (const c of this.conns) c.socket.destroy();
    this.conns.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise((r) => server.close(() => r()));
    await this.pendingJobMailRoute?.catch((err) => this.log.warn("pending mail route stopped", { err: String(err) }));
    this.store.close();
    this.log.info("broker closed");
  }
  /** Serialize listener changes and let the elected broker remain the sole network writer. */
  async configureNetwork(value) {
    if (!this.networking) throw new BridgeError("bad_request", "Restart all agent-bridge hosting sessions to load this wizard-capable broker.");
    const config = writeNetworkConfig(this.networking.home, value);
    this.remoteDashboard?.close();
    this.remoteDashboard = null;
    this.remoteJobs?.close();
    this.remoteJobs = null;
    await this.network?.close();
    this.network = null;
    this.networking.config = config;
    if (config.enabled) {
      const service = new NetworkService(this.networking.home, config, {
        peers: () => this.dashboardPeers(),
        receive: (message) => this.receiveRemote(message),
        receipt: (id, sender, recipient) => this.remoteReceipt(id, sender, recipient),
        recipientReceipts: true
      }, this.log);
      this.installRemoteJobs(service);
      try {
        await service.start();
        this.network = service;
      } catch (err) {
        await service.close();
        throw err;
      }
    }
    return this.network?.status() ?? { enabled: false, config, discovered: [], paired: [] };
  }
  installRemoteJobs(service) {
    this.remoteDashboard = new RemoteDashboard(service, { home: this.networking.home, log: this.log, peers: () => this.dashboardPeers() });
    this.remoteJobs = new RemoteJobs(service, this.networking.home, this.log, async (record, control) => {
      this.receiveRemote({
        id: randomUUID3(),
        from: { id: record.owner, name: record.owner, agent: "other" },
        to: record.name,
        recipient: record.name,
        conversationId: `${CONTROL_CONVERSATION_PREFIX}${record.id}`,
        replyTo: null,
        hop: 0,
        body: JSON.stringify(control),
        createdAt: this.now(),
        readAt: null
      });
    });
  }
  purge() {
    try {
      const ttl = retentionLimit("AGENT_BRIDGE_MESSAGE_TTL_MS", MESSAGE_TTL_MS);
      if (ttl) this.store.schedulePurgeOlderThan(this.now() - ttl);
    } catch (err) {
      this.log.warn("purge failed", { err });
    }
  }
  accept(socket) {
    const conn = { socket, peer: null, authed: false, inFlight: 0, mailGeneration: 0 };
    this.conns.add(conn);
    socket.setEncoding("utf8");
    const decoder = new FrameDecoder(MAX_FRAME_BYTES);
    this.log.debug("connection accepted");
    socket.on("data", (chunk) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        this.log.warn("dropping connection after undecodable frame", { err });
        socket.destroy();
        return;
      }
      for (const f of frames) {
        if (f.t === "req") {
          if (++conn.inFlight > MAX_INFLIGHT_PER_CONNECTION) {
            this.log.warn("closing overloaded client connection", { peer: conn.peer?.name });
            socket.destroy();
            break;
          }
          if (conn.inFlight >= PAUSE_INFLIGHT_PER_CONNECTION) socket.pause();
          void this.dispatch(conn, f).catch((err) => {
            this.log.warn("client request transport failed", { err: String(err) });
            socket.destroy();
          }).finally(() => {
            conn.inFlight--;
            if (conn.inFlight < PAUSE_INFLIGHT_PER_CONNECTION && !socket.destroyed) socket.resume();
          });
        } else this.log.debug("ignoring non-request frame from client", { t: f.t });
      }
    });
    socket.on("error", (err) => this.log.debug("connection error", { err: err.message }));
    socket.on("close", () => {
      this.conns.delete(conn);
      if (conn.peer) {
        if (!this.closing && !conn.peer.jobAgent && !conn.peer.subagent) {
          const name = conn.peer.name, at = this.now();
          void this.store.retryWrite(() => {
            if (!this.closing) this.store.markPeerSeen(name, at);
          }).catch((err) => this.log.warn("offline last-seen update deferred", { err: String(err) }));
        }
        void this.routePendingJobMail().catch((err) => this.log.warn("pending job reroute deferred", { err: String(err) }));
        this.log.info("peer left", { name: conn.peer.name, agent: conn.peer.agent });
        if (!conn.peer.jobAgent) this.broadcastEvent("peer_left", conn.peer, conn);
      }
    });
  }
  async dispatch(conn, frame) {
    this.healthMonitor.start();
    const countsPressure = !["reindexHistory", "health", "ping"].includes(frame.op);
    if (countsPressure) this.historyPendingRequests++;
    this.historyBackground?.pressure(this.historyPendingRequests > 0);
    this.store.backupPressure(this.historyPendingRequests > 0);
    const handler = this.handlers[frame.op];
    try {
      if (!handler) throw new BridgeError("bad_request", `unknown op: ${String(frame.op)}`);
      const turn = this.requestTurn.then(() => new Promise((resolve) => setImmediate(resolve)));
      this.requestTurn = turn;
      await turn;
      if (this.closing) return;
      if (!conn.authed && !UNAUTHENTICATED_OPS.has(frame.op)) throw new BridgeError("unauthorized", "authenticate first");
      this.log.debug("request", { op: frame.op, peer: conn.peer?.name });
      const result = await handler(conn, frame.args ?? {});
      this.write(conn, { t: "res", id: frame.id, ok: true, result });
    } catch (err) {
      if (isSqliteBusy(err)) {
        this.historyBackground?.pressure(true, true);
        this.store.backupPressure(true, true);
      }
      const be = err instanceof BridgeError ? err : new BridgeError("internal", String(err?.message ?? err));
      if (be.code === "internal" || isSqliteBusy(err)) this.healthMonitor.error(frame.op, isSqliteBusy(err) ? "store_busy" : be.code);
      if (be.code === "internal") this.log.error("request failed", { op: frame.op, err });
      else this.log.debug("request rejected", { op: frame.op, code: be.code, message: be.message });
      this.write(conn, { t: "res", id: frame.id, ok: false, error: be.toPayload() });
    } finally {
      if (countsPressure) this.historyPendingRequests--;
      this.historyBackground?.pressure(this.historyPendingRequests > 0);
      this.store.backupPressure(this.historyPendingRequests > 0);
    }
  }
  write(conn, frame) {
    if (conn.socket.destroyed) return false;
    try {
      const data = encodeFrame(frame);
      if (conn.socket.writableLength + Buffer.byteLength(data) > MAX_CONNECTION_BUFFER_BYTES) {
        this.log.warn("closing slow client connection; unread mail remains stored", { peer: conn.peer?.name });
        conn.socket.destroy();
        return false;
      }
      return conn.socket.write(data);
    } catch (err) {
      this.log.warn("client write failed; unread mail remains stored", { err: String(err) });
      conn.socket.destroy();
      return false;
    }
  }
  /** Deferred replay is outside dispatch: storage faults must not become uncaught exceptions.
   * Honour stream backpressure so a large retained inbox is not repeatedly disconnected on replay.
   */
  replayMail(conn, peer, before) {
    const registration = { id: peer.id, name: peer.name, sessionId: peer.sessionId, generation: conn.mailGeneration };
    const current = () => this.queueReady(conn, peer) && conn.mailGeneration === registration.generation && !conn.socket.destroyed && conn.peer === peer && peer.id === registration.id && peer.name === registration.name && peer.sessionId === registration.sessionId && this.connByName(registration.name) === conn;
    setImmediate(() => {
      if (!current()) return;
      try {
        before?.();
        const mail = this.unreadMail(peer.name, PENDING_MAX_LIMIT);
        let at = 0;
        const pump = () => {
          if (!current()) return;
          while (at < mail.length) {
            const m = mail[at++];
            if (peer.unavailable && m.from.id.startsWith("job:") && !m.conversationId.startsWith(SIBLING_CONVERSATION_PREFIX)) continue;
            if (!this.write(conn, { t: "evt", ev: "message", data: m })) {
              if (!conn.socket.destroyed) conn.socket.once("drain", pump);
              return;
            }
          }
        };
        pump();
      } catch (err) {
        this.log.warn("mail replay deferred after storage failure", { peer: peer.name, err: String(err) });
      }
    });
  }
  emit(conn, ev, data) {
    const publicData = ev === "peer_joined" || ev === "peer_left" ? this.publicPeer(data) : data;
    const frame = { t: "evt", ev, data: publicData };
    this.write(conn, frame);
  }
  broadcastEvent(ev, data, except) {
    for (const c of this.conns) if (c !== except && c.peer) this.emit(c, ev, data);
  }
  requirePeer(conn) {
    if (!conn.peer) throw new BridgeError("not_registered", "send hello first");
    return conn.peer;
  }
  /** Local sessions and paired remote peers; local job runners stay hidden (see job-host.ts). */
  livePeers() {
    return this.localPeers().filter((p) => !p.jobAgent).map((p) => this.projectPeer(p)).concat(this.network?.peers() ?? []).filter((p) => !isPluginCacheCwd(p.cwd)).map((peer) => this.publicPeer(peer));
  }
  /** The node's own registration is authoritative. Legacy observers must not
   * concurrently republish foreign explicit records without creation identity.
   */
  publicPeer(peer) {
    const { storeCapabilities: _privateCapabilities, ...publicPeer } = peer;
    return publicPeer;
  }
  localPeers() {
    return [...this.conns].flatMap((c) => c.peer ? [c.peer] : []);
  }
  projectPeer(peer) {
    const decorated = this.groups.decorate(peer), key = decorated.projectGroup;
    if (!key || peer.jobAgent || peer.subagent) return decorated;
    const members = this.localPeers().filter((p) => !p.jobAgent && !p.subagent && this.groups.decorate(p).projectGroup === key).sort((a, b) => a.startedAt - b.startedAt || a.name.localeCompare(b.name));
    let main = this.projectMains.get(key);
    if (!members.some((p) => p.name === main)) {
      main = members[0]?.name;
      if (main) this.recordProjectMain(key, `project:${basename(decorated.projectRoot)}`, main);
    }
    return { ...decorated, projectMain: main === peer.name, projectAddress: `project:${basename(decorated.projectRoot)}`, projectRoute: this.projectRoutes.get(key) };
  }
  switchProjectMain(source, target) {
    if (!target || target.jobAgent || target.subagent || target.host) throw new BridgeError("bad_request", "Choose a live local project master.");
    const peer = this.projectPeer(target);
    if (!peer.projectGroup || source && (source.jobAgent || this.projectPeer(source).projectGroup !== peer.projectGroup)) throw new BridgeError("unauthorized", "Only a master of this project may switch its main session.");
    this.recordProjectMain(peer.projectGroup, peer.projectAddress, peer.name);
    return this.projectPeer(target);
  }
  recordProjectMain(key, address, main) {
    const previous = this.projectMains.get(key);
    if (previous === main) return;
    const route = { address, main, since: this.now(), previous };
    this.projectMains.set(key, main);
    this.projectRoutes.set(key, route);
    if (previous) void this.notifyProjectMainChange(route).catch((err) => this.log.warn("project main notice deferred", { err: String(err) }));
  }
  async notifyProjectMainChange(route) {
    const recipients = /* @__PURE__ */ new Set([route.previous, ...this.store.recentProjectSenders(route.address, route.previous, route.since - 24 * 60 * 60 * 1e3)]);
    for (const recipient of recipients) {
      if (this.closing) return;
      if (!PEER_NAME_PATTERN.test(recipient) || this.connByName(recipient)?.peer?.jobAgent) continue;
      const message = {
        id: randomUUID3(),
        from: { id: "bridge-project-routing", name: "agent-bridge", agent: "other" },
        to: recipient,
        recipient,
        conversationId: `project-main-${randomUUID3()}`,
        replyTo: null,
        hop: 0,
        body: `${route.address} main changed from ${route.previous} to ${route.main} at ${new Date(route.since).toISOString().slice(11, 16)} UTC. Future project-address mail routes to ${route.main}; exact session names keep direct routing.`,
        createdAt: route.since,
        readAt: null
      };
      await this.store.retryWrite(() => this.store.insert(message));
      const conn = this.recipientConn(recipient);
      if (conn) this.emit(conn, "message", message);
    }
  }
  sameJobFamily(a, b, jobs = this.storedJobs()) {
    if (this.jobSupervisor(a, jobs) !== this.jobSupervisor(b, jobs)) return false;
    const left = jobs.find((j) => `job:${j.id}` === a.id), right = jobs.find((j) => `job:${j.id}` === b.id);
    const l = left && this.groups.jobRoot(left, this.localPeers()), r = right && this.groups.jobRoot(right, this.localPeers());
    return !(l && r) || this.groups.root(l) === this.groups.root(r);
  }
  sharedJobs(a, b, jobs = this.storedJobs()) {
    const left = jobs.find((j) => `job:${j.id}` === a.id), right = jobs.find((j) => `job:${j.id}` === b.id);
    if (!left || !right || !this.groups.shareable(left) || !this.groups.shareable(right)) return false;
    const peers = this.localPeers(), l = this.groups.jobRoot(left, peers), r = this.groups.jobRoot(right, peers);
    return Boolean(l && r && this.groups.same(l, r));
  }
  /** Project local runner lineage from durable jobs; do not alter broker routing identities. */
  dashboardPeers() {
    const jobs = this.storedJobs();
    return [...this.conns].flatMap((c) => {
      const peer = c.peer;
      if (!peer) return [];
      const job = jobs.find((j) => j.name === peer.name || `job:${j.id}` === peer.id);
      const field = (key) => typeof job?.[key] === "string" ? job[key] : void 0;
      return [{
        ...this.projectPeer(peer),
        agent: peer.jobAgent ?? peer.agent,
        parentJob: field("parentJob") ?? peer.parentJob,
        rootSession: field("rootSession") ?? peer.rootSession ?? peer.jobOwner,
        rootName: field("rootName") ?? peer.rootName ?? peer.jobParent,
        title: peer.jobTitle,
        subagent: Boolean(peer.jobAgent)
      }];
    });
  }
  connByName(name) {
    for (const c of this.conns) if (c.peer?.name === name) return c;
    return void 0;
  }
  /** Replay every effect after the registry commit, including a crash between stores. */
  applyHandoffs() {
    if (!this.jobsPath) return;
    const records = this.storedJobs();
    for (const receipt of handoffJournal(this.jobsPath)) {
      const current = receipt.jobs.map((j) => records.find((r) => r.id === j.id)).filter(isRecord);
      for (const job of current) {
        const old = receipt.jobs.find((j) => j.id === job.id);
        const budget = new RootConcurrency(dirname3(this.jobsPath), String(job.rootSession));
        try {
          budget.moveJobs([old.name]);
        } finally {
          budget.close();
        }
        this.refreshJobPeer(job);
      }
      const body = `Inherited subagents from ${receipt.from}:
` + receipt.jobs.map((j) => `- ${j.name}: ${j.title} (${j.status})`).join("\n") + (receipt.note ? `

Handoff note: ${receipt.note}` : "") + "\n\nYou are their supervisor. Use message_subagent or cancel_subagent to control them.";
      for (const [recipient, text, suffix] of [[receipt.to, body, "inherited"], [receipt.from, `Handed off ${receipt.jobs.length} subagent(s) to ${receipt.to}.`, "confirmed"]]) {
        const m = {
          id: `${receipt.id}-${suffix}`,
          from: { id: "handoff", name: "agent-bridge", agent: "other" },
          to: recipient,
          recipient,
          body: text,
          conversationId: `handoff-${receipt.id}`,
          hop: 0,
          replyTo: null,
          createdAt: receipt.at,
          readAt: null
        };
        if (this.store.insertOnce(m)) {
          const conn = this.connByName(recipient);
          if (conn) this.emit(conn, "message", m);
        }
      }
    }
    void this.routePendingJobMail().catch((err) => this.log.warn("pending job reroute deferred", { err: String(err) }));
  }
  routePendingJobMail() {
    if (this.closing) return Promise.resolve();
    this.pendingJobMailRouteAgain = true;
    this.pendingJobMailRoute ??= this.reroutePendingJobMail().catch((err) => {
      if (isSqliteBusy(err) && !this.closing && !this.pendingJobMailRetry) {
        this.pendingJobMailRetry = setTimeout(() => {
          this.pendingJobMailRetry = null;
          void this.routePendingJobMail().catch((error) => this.log.warn("pending job mail retry deferred", { err: String(error) }));
        }, 1e3);
        this.pendingJobMailRetry.unref();
      }
      throw err;
    }).finally(() => {
      this.pendingJobMailRoute = null;
    });
    return this.pendingJobMailRoute;
  }
  async reroutePendingJobMail() {
    do {
      this.pendingJobMailRouteAgain = false;
      let processed = 0;
      let pending = this.store.pendingJobSenders();
      for (const snapshot of this.storedJobs()) {
        if (++processed % 16 === 0) {
          await new Promise((resolve) => setImmediate(resolve));
          pending = this.store.pendingJobSenders();
        }
        if (snapshot.remote || !primaryFor(snapshot)) continue;
        if ((!Array.isArray(snapshot.deliveryHistory) || !snapshot.deliveryHistory.length) && !pending.has(`job:${snapshot.id}`)) continue;
        await this.store.retryWrite(() => {
          if (this.closing) return;
          const job = this.storedJobs().find((record) => record.id === snapshot.id);
          if (!job || job.remote || !primaryFor(job)) return;
          if ((!Array.isArray(job.deliveryHistory) || !job.deliveryHistory.length) && !this.store.pendingJobRecipients(String(job.id)).length) return;
          const recipient = this.jobRecipient(job), target = this.connByName(recipient);
          if (Array.isArray(job.deliveryHistory)) for (const envelope of job.deliveryHistory) {
            if (!isRecord(envelope) || !isRecord(envelope.from) || envelope.from.id !== `job:${job.id}` || typeof envelope.id !== "string" || typeof envelope.body !== "string") continue;
            const message = { ...envelope, to: recipient, recipient, conversationId: this.jobConversation(job, recipient, String(envelope.conversationId)) };
            const inserted = this.store.insertJobDelivery(message);
            const names = /* @__PURE__ */ new Set([recipient, envelope.to, envelope.recipient, ...mastersFor(job)]);
            const consumed = this.jobsPath && [...names].some((name) => typeof name === "string" && new ReadJournal(dirname3(this.jobsPath)).read(`name:${name}`).includes(message.id));
            if (consumed) this.store.markRead(recipient, [message.id], this.now());
            else if (inserted && target && !target.peer?.unavailable) this.emit(target, "message", message);
          }
          if (!target || target.peer?.unavailable) return;
          for (const from of this.store.pendingJobRecipients(String(job.id))) {
            if (this.jobsPath) this.store.markRead(from, new ReadJournal(dirname3(this.jobsPath)).read(`name:${from}`), this.now());
            const moved = this.store.handoffMail(from, recipient, String(job.id), this.now(), recipient !== job.parentJob && recipient !== primaryFor(job));
            const previous = this.connByName(from);
            if (previous && moved.length) this.emit(previous, "mail_retracted", { ids: moved.map((m) => m.id) });
            for (const m of moved) this.emit(target, "message", m);
          }
        });
      }
    } while (this.pendingJobMailRouteAgain && !this.closing);
  }
  jobRecipient(job) {
    if (typeof job.parentJob === "string" && this.connByName(job.parentJob)?.peer?.jobAgent) return job.parentJob;
    return chooseJobRecipient(job, this.localPeers(), this.groups.members(job, this.localPeers()));
  }
  jobConversation(job, recipient, conversationId) {
    if (recipient === job.parentJob || recipient === primaryFor(job) || isQuietMessage({ conversationId })) return conversationId;
    return conversationId.replace(/:note$/, "") + (conversationId.endsWith(":fallback") ? "" : ":fallback");
  }
  refreshJobPeer(job) {
    const peer = this.connByName(String(job.name))?.peer;
    if (!peer?.jobAgent) return;
    peer.jobParent = String(job.owner);
    peer.jobOwner = String(job.supervisor);
    peer.rootSession = String(job.rootSession);
    peer.rootName = String(job.rootName);
    peer.parentJob = typeof job.parentJob === "string" ? job.parentJob : void 0;
    if (isRecord(job.args) && Array.isArray(job.args.send_to)) peer.jobSendTo = job.args.send_to;
  }
  siblingConns(conn, target) {
    const peer = this.requirePeer(conn);
    if (!peer.jobAgent || !peer.jobOwner) throw new BridgeError("bad_request", "not a linked job");
    const jobs = this.storedJobs();
    const supervisor = this.jobSupervisor(peer, jobs);
    return [...this.conns].filter((c) => c !== conn && c.peer?.jobAgent && (!target || c.peer.name === target) && (this.sameJobFamily(peer, c.peer, jobs) || this.sharedJobs(peer, c.peer, jobs) || peer.jobSendTo?.includes(c.peer.name)));
  }
  async jobForControl(peer, ref) {
    let known = this.storedJobs().find((j) => j.name === ref || j.id === ref);
    let active = false;
    if (known && this.jobsPath) {
      try {
        if (indexedJobProjectionCurrent(this.jobsPath)) {
          const selected = readIndexedJobs(this.jobsPath, { ids: /* @__PURE__ */ new Set([String(known.id)]), active: true }).jobs[0];
          active = Boolean(selected);
          if (selected) known = selected;
        } else {
          const data = readJsonSnapshot(this.jobsPath).value;
          const rows = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.jobs) ? data.jobs : [];
          active = rows.some((record) => isRecord(record) && record.id === known.id);
        }
      } catch {
      }
    }
    if (active && (known?.remote || isRecord(known?.host) && Date.now() - Number(known.host.startedAt) < 3e4)) return known;
    if (active && known?.status === "running" && !known.host && this.connByName(String(known.executionOwner ?? known.owner))) return known;
    const recovered = this.jobsPath ? await recoverJobRecordAsync(dirname3(this.jobsPath), ref) : void 0;
    const current = this.storedJobs().find((j) => j.name === ref || j.id === ref);
    if (!recovered) return typeof current?.prompt === "string" && typeof current.owner === "string" ? current : void 0;
    if (!this.groups.canControl(peer, recovered, this.localPeers())) return current;
    this.recoveredJobs.set(recovered.id, recovered);
    this.jobsSnapshot = null;
    this.jobsForDispatch = null;
    return recovered;
  }
  /** Synchronous authorization fence after the handler's final await. Never use
   * an earlier generation or stale grants for a control/routing side effect. */
  currentJobAuthority(job) {
    if (!job || typeof job.id !== "string" || !this.jobsPath) return void 0;
    let active;
    try {
      if (indexedJobProjectionCurrent(this.jobsPath)) {
        active = readIndexedJobs(this.jobsPath, { ids: /* @__PURE__ */ new Set([job.id]), active: true }).jobs[0];
      } else {
        const data = readJsonSnapshot(this.jobsPath).value;
        const rows = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.jobs) ? data.jobs : void 0;
        if (!rows) return void 0;
        active = rows.filter(isRecord).findLast((record) => record.id === job.id);
      }
    } catch (error) {
      if (error.code !== "ENOENT") return void 0;
    }
    this.jobsForDispatch = null;
    const current = active ?? findHistoryJob(dirname3(this.jobsPath), String(job.name), job.id) ?? this.storedJobs().find((record) => record.id === job.id);
    if (!current) return void 0;
    for (const key of ["id", "name", "agent", "startedAt", "sessionId", "threadId"]) {
      if (current[key] !== void 0 && current[key] !== null && current[key] !== job[key]) return void 0;
    }
    const latest = { ...job };
    for (const key of ["owner", "supervisor", "executionOwner", "rootName", "rootSession", "parentJob", "masters", "ownershipHistory", "remote", "projectRoot", "args"]) {
      if ((key === "owner" || key === "args") && current[key] === void 0) continue;
      if (!active && !(key in current)) continue;
      latest[key] = current[key];
    }
    if (typeof current.prompt === "string") latest.prompt = current.prompt;
    return latest;
  }
  storedJobs() {
    if (!this.jobsPath) return [];
    if (this.jobsForDispatch) return this.jobsForDispatch;
    try {
      const archive = readArchivedJobSnapshot(this.jobsPath, { metadata: true });
      if (indexedJobProjectionCurrent(this.jobsPath)) return [...this.recoveredJobs.values(), ...archive.jobs];
      const active = readJsonSnapshot(this.jobsPath);
      if (this.jobsSnapshot?.active === active && this.jobsSnapshot.archive === archive.signature) {
        this.jobsForDispatch = this.jobsSnapshot.records;
        queueMicrotask(() => {
          this.jobsForDispatch = null;
        });
        return this.jobsForDispatch;
      }
      const data = active.value;
      const jobs = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.jobs) ? data.jobs : [];
      const merged = /* @__PURE__ */ new Map();
      for (const [id, job] of this.recoveredJobs) merged.set(id, job);
      for (const job of [...archive.jobs, ...jobs.filter(isRecord)]) {
        if (typeof job.id === "string") {
          merged.set(job.id, job);
          this.recoveredJobs.delete(job.id);
        }
      }
      const records = [...merged.values()];
      this.jobsSnapshot = { active, archive: archive.signature, records };
      this.jobsForDispatch = records;
      queueMicrotask(() => {
        this.jobsForDispatch = null;
      });
      return records;
    } catch {
      return [...this.recoveredJobs.values()];
    }
  }
  /** A restored legacy runner may still advertise its old owner name until its next turn. */
  jobSupervisor(peer, jobs = this.storedJobs()) {
    const job = jobs.find((j) => `job:${j.id}` === peer.id);
    return typeof job?.supervisor === "string" ? job.supervisor : peer.jobOwner;
  }
  storedSiblings(peer, target) {
    if (!this.jobsPath || !peer.jobOwner) return [];
    try {
      const records = this.storedJobs();
      const supervisor = this.jobSupervisor(peer, records);
      return records.flatMap((j) => j && (!target || j.name === target) && (this.sameJobFamily(peer, { id: `job:${j.id}`, jobOwner: String(j.supervisor) }, records) || this.sharedJobs(peer, { id: `job:${j.id}` }, records) || peer.jobSendTo?.includes(String(j.name))) && typeof j.id === "string" && typeof j.name === "string" && j.name !== peer.name && `job:${j.id}` !== peer.id && AGENT_KINDS.includes(j.agent) && SIBLING_STATUSES.has(j.status) ? [{ id: `job:${j.id}`, name: j.name, title: isRecord(j.args) && typeof j.args.title === "string" ? j.args.title : "", agent: j.agent, status: j.status, ...typeof j.finishedAt === "number" ? { finishedAt: j.finishedAt } : {}, report: typeof j.report === "string" ? j.report : null }] : []);
    } catch {
      return [];
    }
  }
  siblingPeers(conn) {
    const live = this.siblingConns(conn);
    const stored = this.storedSiblings(this.requirePeer(conn));
    const peers = new Map(stored.map(({ id, report, ...s }) => [s.name, s]));
    for (const c of live) {
      const p = c.peer;
      const previous = stored.find((s) => s.id === p.id);
      if (previous) peers.delete(previous.name);
      peers.set(p.name, {
        name: p.name,
        title: p.jobTitle ?? "",
        agent: p.jobAgent,
        status: previous?.status ?? "running",
        ...previous?.finishedAt !== void 0 ? { finishedAt: previous.finishedAt } : {}
      });
    }
    return [...peers.values()];
  }
  async onSendSibling(conn, args) {
    const sender = this.requirePeer(conn);
    const dedupeKey = args.dedupeKey ? `${SIBLING_CONVERSATION_PREFIX}${args.dedupeKey}` : void 0;
    const key = dedupeKey ? `${sender.id}:${dedupeKey}` : null;
    const seen = key ? this.sentByKey.get(key) : void 0;
    if (seen) return seen.result;
    const target = this.siblingConns(conn, args.to).find((c) => c.peer.name === args.to);
    const stored = this.storedSiblings(sender, args.to).find((s) => s.name === args.to);
    if (!target && !stored) {
      if (!isJobSendTarget(args.to) || !sender.jobSendTo?.includes(args.to) || args.to.includes("-job-") || args.to.includes("-ask-") || this.connByName(args.to)?.peer?.jobAgent) {
        throw new BridgeError("unknown_target", "no sibling with that job name or explicit send_to grant");
      }
      if (args.replyTo) {
        const parent2 = this.store.byId(args.replyTo);
        const own = this.storedJobs().find((j) => `job:${j.id}` === sender.id);
        const ownerNames = /* @__PURE__ */ new Set([sender.name, sender.jobParent, own?.owner]);
        if (!parent2 || !(parent2.from.name === args.to && ownerNames.has(parent2.recipient) || parent2.from.id === sender.id && parent2.recipient === args.to)) {
          throw new BridgeError("bad_request", "reply_to must refer to a message exchanged with the granted session or supervisor");
        }
      }
      return this.onSend(conn, { ...args, dedupeKey });
    }
    const targetId = target?.peer.id ?? stored.id;
    const parent = args.replyTo ? this.store.byId(args.replyTo) : null;
    if (args.replyTo && (!parent || !parent.conversationId.startsWith(SIBLING_CONVERSATION_PREFIX) || !(parent.from.id === targetId && parent.recipient === sender.name || parent.from.id === sender.id && parent.recipient === args.to))) {
      throw new BridgeError("bad_request", "reply_to must refer to a message exchanged with this sibling");
    }
    if (!Number.isInteger(args.maxHops) || args.maxHops < 1 || (parent ? parent.hop + 1 : 0) >= args.maxHops) {
      if (typeof args.body !== "string" || !args.body.trim() || args.body.length > MAX_BODY_CHARS) {
        throw new BridgeError("bad_request", "invalid sibling message body");
      }
      const id = randomUUID3();
      const notice = {
        id,
        from: { id: sender.id, name: sender.name, agent: sender.jobAgent ?? sender.agent },
        to: sender.jobParent ?? sender.name,
        recipient: sender.name,
        conversationId: `sibling-drop-${id}`,
        replyTo: parent?.id ?? null,
        hop: 0,
        body: `Sibling delivery blocked: ${sender.name} to ${args.to} reached the ${args.maxHops}-message hop limit. The target did not receive this message. Stop this thread and resolve remaining work with the supervisor.

Undelivered text:
${args.body}`,
        createdAt: this.now(),
        readAt: null
      };
      await this.store.retryWrite(() => this.store.insert(notice));
      this.emit(conn, "message", notice);
      if (sender.jobParent && sender.jobParent !== sender.name) {
        const copy = { ...notice, recipient: sender.jobParent };
        await this.store.retryWrite(() => this.store.insert(copy));
        const supervisor = this.connByName(sender.jobParent);
        if (supervisor) this.emit(supervisor, "message", copy);
      }
      throw new BridgeError("bad_request", `sibling conversation reached its ${args.maxHops}-message hop limit; message was not delivered. Durable notice ${id} saved for sender and supervisor, including the undelivered text`);
    }
    const conversationId = parent?.conversationId ?? `${SIBLING_CONVERSATION_PREFIX}${randomUUID3()}`;
    const result = await this.onSend(conn, { ...args, dedupeKey, conversationId });
    const message = result.messages[0];
    const recipientOwner = target?.peer?.jobParent ?? this.storedJobs().find((j) => j.name === args.to)?.owner;
    const observers = new Set([sender.jobParent, recipientOwner].filter((owner) => typeof owner === "string"));
    for (const owner of observers) {
      const note = {
        ...message,
        id: randomUUID3(),
        recipient: owner,
        conversationId: `${conversationId}${SIBLING_NOTE_SUFFIX}`,
        body: `Sibling message to ${message.recipient}:

${message.body}`
      };
      await this.store.retryWrite(() => this.store.insert(note));
      const supervisor = this.connByName(owner);
      if (supervisor) this.emit(supervisor, "message", note);
    }
    if (stored && stored.status !== "running") {
      result.finishedRecipient = {
        name: stored.name,
        status: stored.status,
        report: stored.report,
        ...stored.finishedAt !== void 0 ? { finishedAt: stored.finishedAt } : {}
      };
    }
    return result;
  }
  uniqueName(requested) {
    if (!this.connByName(requested)) return requested;
    for (let i = 2; i < NAME_SUFFIX_LIMIT; i++) {
      const candidate = `${requested}-${i}`;
      if (!this.connByName(candidate)) return candidate;
    }
    return `${requested}-${randomUUID3().slice(0, 8)}`;
  }
  onDecide(conn, value) {
    const peer = this.requirePeer(conn);
    const parsed = external_exports.object({
      topic: external_exports.string().trim().min(1).max(MAX_DECISION_TOPIC_CHARS),
      text: external_exports.string().trim().min(1).max(MAX_DECISION_TEXT_CHARS),
      scope: decisionScopeSchema.optional(),
      sourceMessageId: external_exports.string().min(1).optional()
    }).strict().safeParse(value);
    if (!parsed.success) throw new BridgeError("bad_request", "Invalid decision topic, text or scope.");
    if (parsed.data.sourceMessageId && !this.store.byId(parsed.data.sourceMessageId)) throw new BridgeError("bad_request", "Source message does not exist.");
    const decision = this.store.decisions.record({ ...parsed.data, scope: parsed.data.scope ?? { project: peer.cwd } }, { id: peer.id, name: peer.name, agent: peer.agent }, this.now());
    const deliveredTo = [];
    for (const c of this.conns) {
      if (!c.peer || c.peer.jobAgent || !decisionApplies(decision, c.peer)) continue;
      const message = this.queueDecision(decision, c.peer);
      if (message) {
        this.emit(c, "message", message);
        deliveredTo.push(c.peer.name);
      }
    }
    return { decision, deliveredTo };
  }
  onDecisions(conn, value) {
    const parsed = external_exports.object({
      query: external_exports.string().max(MAX_DECISION_TEXT_CHARS).optional(),
      scope: decisionScopeSchema.optional(),
      history: external_exports.boolean().optional(),
      topic: external_exports.string().max(MAX_DECISION_TOPIC_CHARS).optional(),
      session: external_exports.string().optional()
    }).strict().safeParse(value);
    if (!parsed.success) throw new BridgeError("bad_request", "Invalid decisions query or scope.");
    const scope = parsed.data.scope ?? (conn.peer ? { project: conn.peer.cwd } : void 0);
    return this.store.decisions.list({ ...parsed.data, scope }, conn.peer ?? void 0);
  }
  decisionSessionKey(peer) {
    return `${peer.agent}:${peer.sessionId ?? peer.id}`;
  }
  queueDecision(decision, peer) {
    const message = {
      id: randomUUID3(),
      from: decision.author,
      to: peer.name,
      recipient: peer.name,
      conversationId: `decision-${decision.id}`,
      replyTo: decision.sourceMessageId,
      hop: DECISION_MESSAGE_HOP,
      body: `Pinned owner decision: ${decision.topic}

${decision.text}

Call decisions to look up current decisions or their history.`,
      createdAt: this.now(),
      readAt: null
    };
    return this.store.decisions.enqueue(decision, this.decisionSessionKey(peer), message, () => this.store.insert(message)) ? message : null;
  }
  queueCurrentDecisions(peer) {
    if (peer.jobAgent || !peer.sessionId) return [];
    return this.store.decisions.list().filter((d) => decisionApplies(d, peer)).flatMap((d) => {
      const message = this.queueDecision(d, peer);
      return message ? [message] : [];
    });
  }
  checkAuth(protocol, token) {
    if (protocol !== PROTOCOL_VERSION) {
      throw new BridgeError("protocol_mismatch", `broker speaks protocol ${PROTOCOL_VERSION}, client ${protocol}`, {
        brokerProtocol: PROTOCOL_VERSION
      });
    }
    if (typeof token !== "string" || !tokensEqual(token, this.token)) {
      this.log.warn("rejected connection with a wrong or missing token");
      throw new BridgeError("unauthorized", "wrong agent-bridge token");
    }
  }
  async onHello(conn, args) {
    this.checkAuth(args.protocol, args.token);
    conn.authed = true;
    const p = args.peer;
    if (!p || !PEER_NAME_PATTERN.test(p.name ?? "") || !AGENT_KINDS.includes(p.agent)) {
      throw new BridgeError("bad_request", "invalid peer info");
    }
    if (conn.peer) throw new BridgeError("bad_request", "already registered");
    if (isPluginCacheCwd(String(p.cwd ?? ""))) throw new BridgeError("bad_request", "Plugin-cache processes cannot register as sessions.");
    const name = this.uniqueName(p.name);
    const peer = {
      id: String(p.id),
      name,
      agent: p.agent,
      cwd: String(p.cwd ?? ""),
      pid: Number(p.pid),
      agentPid: p.agentPid ?? null,
      agentStartedAt: typeof p.agentStartedAt === "string" && p.agentStartedAt.length <= 128 ? p.agentStartedAt : null,
      sessionId: p.sessionId ?? null,
      startedAt: Number(p.startedAt) || this.now(),
      autoWake: Boolean(p.autoWake),
      wakeOnDirect: Boolean(p.wakeOnDirect),
      wakeAvailable: Boolean(p.wakeAvailable),
      wakeMaxHops: typeof p.wakeMaxHops === "number" ? p.wakeMaxHops : void 0,
      activity: p.activity === "busy" || p.activity === "idle" ? p.activity : null,
      unavailable: p.unavailable === true,
      version: typeof p.version === "string" ? p.version.slice(0, 32) : void 0,
      ...validStoreCapabilities(p.storeCapabilities) ? { storeCapabilities: p.storeCapabilities } : {},
      ...p.subagent === true ? { subagent: true } : {},
      ...p.jobAgent && AGENT_KINDS.includes(p.jobAgent) ? { jobAgent: p.jobAgent } : {},
      ...p.jobAgent && typeof p.jobOwner === "string" && p.jobOwner ? {
        parentJob: typeof p.parentJob === "string" ? p.parentJob : void 0,
        rootSession: typeof p.rootSession === "string" ? p.rootSession : void 0,
        rootName: typeof p.rootName === "string" ? p.rootName : void 0,
        jobOwner: p.jobOwner,
        jobParent: typeof p.jobParent === "string" ? p.jobParent : void 0,
        jobTitle: typeof p.jobTitle === "string" ? p.jobTitle : void 0,
        jobSendTo: Array.isArray(p.jobSendTo) ? p.jobSendTo.filter(isJobSendTarget).slice(0, MAX_JOB_SEND_TARGETS) : []
      } : {}
    };
    if (!peer.sessionId) peer.sessionId = this.store.recoverSession(peer);
    this.store.rememberSession(peer, this.now());
    conn.peer = peer;
    const aliases = this.replaceStale(conn, peer);
    aliases.push(...this.restoreNames(peer, true));
    if (this.jobsPath) recordStorePeer(dirname3(this.jobsPath), peer, { authoritative: true });
    const registration = { id: peer.id, name: peer.name, sessionId: peer.sessionId, generation: ++conn.mailGeneration };
    conn.mailReady = void 0;
    await this.expireStaleQueue(peer.name);
    this.assertQueueRegistration(conn, peer, registration);
    await this.claimQueueAliases(conn, peer, registration, aliases);
    let claimed = 0;
    if (!peer.jobAgent) {
      await this.expireStaleQueue(agentQueueKey(peer.agent));
      claimed = await this.store.retryWrite(() => {
        this.assertQueueRegistration(conn, peer, registration);
        return this.store.claim(agentQueueKey(peer.agent), peer.name);
      });
    }
    this.assertQueueRegistration(conn, peer, registration);
    conn.mailReady = registration;
    this.log.info("peer joined", { name, agent: peer.agent, jobAgent: peer.jobAgent, cwd: peer.cwd, claimed });
    if (!peer.jobAgent) this.broadcastEvent("peer_joined", peer, conn);
    this.replayMail(conn, peer, () => {
      this.queueCurrentDecisions(peer);
    });
    return { brokerPid: process.pid, brokerVersion: APP_VERSION, name: peer.name, sessionId: peer.sessionId, peers: this.livePeers().filter((x) => x.id !== peer.id) };
  }
  /**
   * Mail sent to a "-N" stand-in of this peer's name (a reload ran the session under it briefly) moves to the
   * peer. Only names of that form, and only while no one holds them: another session's mail stays its own.
   */
  async onClaimMail(conn, args) {
    const peer = this.requirePeer(conn);
    const registration = conn.mailReady;
    if (!registration || !this.queueReady(conn, peer)) throw new BridgeError("unauthorized", "Queued mail registration is not ready; retry after registration completes.");
    const base = peer.name.replace(/-\d+$/, "");
    let moved = 0;
    for (const name of new Set(args.names ?? [])) {
      const standIn = name !== peer.name && (name === base || name.startsWith(`${base}-`) && /^\d+$/.test(name.slice(base.length + 1)));
      if (!standIn || this.connByName(name)) continue;
      await this.expireStaleQueue(name);
      moved += await this.store.retryWrite(() => {
        this.assertQueueRegistration(conn, peer, registration);
        return this.connByName(name) ? 0 : this.store.claim(name, registration.name);
      });
    }
    this.assertQueueRegistration(conn, peer, registration);
    if (moved) {
      this.log.info("mail of a stand-in name moved to its session", { to: peer.name, moved });
      this.replayMail(conn, peer);
    }
    return { moved };
  }
  async onUpdatePeer(conn, args) {
    if (typeof args.cwd === "string" && isPluginCacheCwd(args.cwd)) throw new BridgeError("bad_request", "Plugin-cache processes cannot register as sessions.");
    const peer = this.requirePeer(conn);
    const previousName = peer.name;
    const aliases = [];
    let replay = args.unavailable === false;
    if (args.unavailable !== void 0) {
      if (peer.jobAgent || typeof args.unavailable !== "boolean") throw new BridgeError("bad_request", "Only masters can change availability.");
      peer.unavailable = args.unavailable;
      void this.routePendingJobMail().catch((err) => this.log.warn("pending job reroute deferred", { err: String(err) }));
    }
    if (peer.jobOwner) {
      if (typeof args.jobParent === "string") peer.jobParent = args.jobParent;
      if (typeof args.jobTitle === "string") peer.jobTitle = args.jobTitle;
    }
    if (args.sessionId !== void 0) {
      const previousKey = this.decisionSessionKey(peer);
      peer.sessionId = args.sessionId;
      this.store.decisions.linkSession(previousKey, this.decisionSessionKey(peer));
      if (peer.sessionId) aliases.push(...this.replaceStale(conn, peer));
    }
    if (args.autoWake !== void 0) peer.autoWake = Boolean(args.autoWake);
    if (args.wakeOnDirect !== void 0) peer.wakeOnDirect = Boolean(args.wakeOnDirect);
    if (args.wakeAvailable !== void 0) peer.wakeAvailable = Boolean(args.wakeAvailable);
    if (typeof args.wakeMaxHops === "number") peer.wakeMaxHops = args.wakeMaxHops;
    if (typeof args.cwd === "string" && args.cwd) peer.cwd = args.cwd;
    if (args.activity === "busy" || args.activity === "idle") peer.activity = args.activity;
    if (typeof args.name === "string" && args.name !== peer.name) {
      if (!PEER_NAME_PATTERN.test(args.name)) throw new BridgeError("bad_request", "invalid peer name");
      const old = peer.name;
      this.store.rememberName(peer, this.now());
      peer.name = this.uniqueName(args.name);
      this.log.info("peer renamed", { from: old, to: peer.name });
      replay = true;
    }
    this.log.debug("peer updated", { name: peer.name, sessionId: peer.sessionId, autoWake: peer.autoWake, cwd: peer.cwd });
    this.store.rememberSession(peer, this.now());
    this.store.rememberName(peer, this.now());
    aliases.push(...this.restoreNames(peer, args.sessionId !== void 0));
    replay ||= previousName !== peer.name || aliases.length > 0;
    if (replay || args.sessionId !== void 0) {
      const registration = { id: peer.id, name: peer.name, sessionId: peer.sessionId, generation: ++conn.mailGeneration };
      conn.mailReady = void 0;
      await this.expireStaleQueue(peer.name);
      this.assertQueueRegistration(conn, peer, registration);
      await this.claimQueueAliases(conn, peer, registration, aliases);
      this.assertQueueRegistration(conn, peer, registration);
      conn.mailReady = registration;
    }
    if (replay) this.replayMail(conn, peer);
    for (const message of this.queueCurrentDecisions(peer)) this.emit(conn, "message", message);
    return peer;
  }
  /**
   * One agent session, two servers: Claude Code's /reload-plugins (or a restart of the MCP server) starts a new
   * agent-bridge server while the old one may still be connected. The old one would keep the name and receive
   * mail the session no longer sees. So the newest server of a session wins: the old connection is told it was
   * replaced (it stops instead of reconnecting) and the new one takes over its name and waiting mail.
   */
  replaceStale(conn, peer) {
    const aliases = [];
    for (const c of [...this.conns]) {
      const old = c.peer;
      if (c === conn || !old || old.agent !== peer.agent) continue;
      const sameSession = peer.sessionId && old.sessionId === peer.sessionId;
      const identity = registrationIdentity(peer);
      const sameProcess = (old.pid !== peer.pid || old.id === peer.id) && identity && identity === registrationIdentity(old) && (!old.sessionId || !peer.sessionId || old.sessionId === peer.sessionId);
      if (!sameSession && !sameProcess) continue;
      this.store.rememberName(old, this.now());
      this.log.info("session connected again from a new server; replacing the old connection", { name: old.name, by: peer.name, sessionId: peer.sessionId });
      this.emit(c, "replaced", { by: peer.name });
      this.conns.delete(c);
      c.peer = null;
      this.broadcastEvent("peer_left", old, c);
      c.socket.end();
      if (peer.name !== old.name && !this.connByName(old.name)) {
        const oldName = old.name;
        if (peer.name.startsWith(`${oldName}-`) && /^\d+$/.test(peer.name.slice(oldName.length + 1))) peer.name = oldName;
        aliases.push(oldName);
      }
    }
    return aliases;
  }
  restoreNames(peer, reclaim) {
    const names = this.store.namesFor(peer);
    if (reclaim) {
      const base = peer.name.replace(/-\d+$/, "");
      const original = names.find((name) => name.replace(/-\d+$/, "") === base && (name === peer.name || !this.connByName(name)));
      if (original) peer.name = original;
    }
    this.store.rememberName(peer, this.now());
    return names.filter((name) => name !== peer.name && !this.connByName(name));
  }
  async claimQueueAliases(conn, peer, registration, aliases) {
    for (const alias of new Set(aliases)) {
      if (alias === registration.name || this.connByName(alias)) continue;
      await this.expireStaleQueue(alias);
      await this.store.retryWrite(() => {
        this.assertQueueRegistration(conn, peer, registration);
        if (!this.connByName(alias)) this.store.claim(alias, registration.name);
      });
    }
  }
  /** Exact registrations win; an unoccupied retained alias must identify one live session. */
  recipientConn(name) {
    const exact = this.connByName(name);
    if (exact) return exact;
    const matches = [...this.conns].filter((c) => c.peer && this.store.namesFor(c.peer).includes(name));
    return matches.length === 1 ? matches[0] : void 0;
  }
  /**
   * Before a peer takes over queued mail. Names are derived from the project folder and reused by every
   * later session there, so a name alone does not identify the session that mail was meant for. Mail that
   * waited longer than QUEUED_MAIL_MAX_AGE_MS most likely belongs to a session that is gone; recent mail
   * still reaches a session that restarted or reconnected after a broker hand-over.
   */
  async expireStaleQueue(key) {
    try {
      const maxAge = retentionLimit("AGENT_BRIDGE_QUEUED_MAIL_MAX_AGE_MS", QUEUED_MAIL_MAX_AGE_MS);
      if (maxAge) await this.store.expireQueuedAsync(key, this.now() - maxAge);
    } catch (err) {
      this.log.warn("expiring queued mail failed", { key, err });
      throw err;
    }
  }
  /** An expiry retry must not grant queued mail to a changed or replaced session. */
  assertQueueRegistration(conn, peer, registration) {
    if (conn.socket.destroyed || conn.peer !== peer || peer.id !== registration.id || peer.name !== registration.name || peer.sessionId !== registration.sessionId || conn.mailGeneration !== registration.generation || this.connByName(registration.name) !== conn) {
      throw new BridgeError("unauthorized", "Session changed while queued mail was archived; reconnect to claim retained mail.");
    }
  }
  queueReady(conn, peer) {
    const ready = conn.mailReady;
    return Boolean(ready && conn.peer === peer && ready.generation === conn.mailGeneration && ready.id === peer.id && ready.name === peer.name && ready.sessionId === peer.sessionId && this.connByName(peer.name) === conn);
  }
  async awaitHandoffReaders(source, target) {
    const controller = new AbortController();
    const closed = () => controller.abort(new BridgeError("unauthorized", "A handoff session disconnected during store reader verification; no job ownership was changed."));
    const timer = setTimeout(() => controller.abort(new BridgeError("timeout", "Store reader verification timed out before handoff; no job ownership was changed.")), HANDOFF_STORE_READY_MS);
    source.socket.once("close", closed);
    target.socket.once("close", closed);
    let aborted;
    const interrupted = new Promise((_, reject) => {
      aborted = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", aborted, { once: true });
    });
    try {
      await Promise.race([refreshStorePeerIdentities(dirname3(this.jobsPath), controller.signal), interrupted]);
    } finally {
      clearTimeout(timer);
      source.socket.off("close", closed);
      target.socket.off("close", closed);
      controller.signal.removeEventListener("abort", aborted);
    }
  }
  assertHandoffRegistration(conn, peer, registration) {
    if (this.closing || !conn.authed || !this.conns.has(conn) || conn.socket.destroyed || conn.peer !== peer || peer.id !== registration.id || peer.name !== registration.name || peer.sessionId !== registration.sessionId || peer.cwd !== registration.cwd || this.connByName(registration.name) !== conn) {
      throw new BridgeError("unauthorized", "Session identity or project changed while store readers were verified; retry from the current sessions. No job ownership was changed.");
    }
  }
  /** Turns a sender-supplied target into live connections and/or offline queue keys. */
  resolveTargets(to, sender) {
    const all = [...this.conns].filter((c) => c.peer && c.peer.id !== sender.id);
    const others = all.filter((c) => !c.peer.jobAgent);
    if (to.startsWith("project:")) {
      const members = this.localPeers().filter((p) => !p.jobAgent && !p.subagent).map((p) => this.projectPeer(p)).filter((p) => p.projectAddress === to);
      const keys = new Set(members.map((p) => p.projectGroup));
      if (keys.size !== 1) throw new BridgeError(keys.size > 1 ? "ambiguous_target" : "unknown_target", "Use a unique live local project address from peers.");
      const target = members.filter((p) => !p.unavailable).sort((a, b) => Number(Boolean(b.projectMain)) - Number(Boolean(a.projectMain)) || a.startedAt - b.startedAt || a.name.localeCompare(b.name))[0];
      if (!target) throw new BridgeError("unknown_target", "No project master is available; use an exact session name to queue mail.");
      const recipients = members.filter((p) => !p.unavailable && p.id !== sender.id);
      if (!recipients.length) throw new BridgeError("unknown_target", "No other available project session; use an exact name to queue mail.");
      return { live: recipients.sort((a, b) => Number(Boolean(b.projectMain)) - Number(Boolean(a.projectMain))).map((p) => this.connByName(p.name)), queued: [] };
    }
    if (to === BROADCAST) {
      if (sender.jobAgent) throw new BridgeError("unauthorized", "job runners cannot broadcast to independent sessions");
      const ownNames = /* @__PURE__ */ new Set([sender.name, ...this.store.namesFor(sender)]);
      const masters = new Set([...this.projectMains.values(), ...this.storedJobs().filter((job) => !job.parentJob && job.status === "running").map(primaryFor)].filter((name) => PEER_NAME_PATTERN.test(name)));
      const eligible = this.store.broadcastRecipients(this.now(), masters);
      const offline = (name) => !ownNames.has(name) && !this.recipientConn(name);
      const queued = eligible.queued.filter(offline), skipped = eligible.skipped.filter(offline);
      if (others.length === 0 && queued.length === 0 && skipped.length === 0 && !this.network?.peers().some((p) => !p.jobAgent)) {
        throw new BridgeError("unknown_target", "no other known sessions; send to an exact name to create an offline queue");
      }
      return { live: others, queued, skipped };
    }
    const recipient = this.recipientConn(to);
    const exact = all.find((c) => c.peer.id === to || c === recipient);
    if (exact) return { live: [exact], queued: [] };
    if (recipient?.peer?.id === sender.id || to === sender.name || to === sender.id) throw new BridgeError("bad_request", "cannot send a message to yourself");
    if (AGENT_KINDS.includes(to)) {
      const ofKind = others.filter((c) => c.peer.agent === to);
      if (ofKind.length === 1) return { live: ofKind, queued: [] };
      if (ofKind.length > 1) {
        throw new BridgeError("ambiguous_target", `several ${to} peers are online`, {
          candidates: ofKind.map((c) => c.peer.name)
        });
      }
      return { live: [], queued: [agentQueueKey(to)] };
    }
    if (!PEER_NAME_PATTERN.test(to)) throw new BridgeError("unknown_target", `invalid target: ${to}`);
    return { live: [], queued: [to] };
  }
  /** Results of recent sends by dedupe key (see SendArgs.dedupeKey), so a retry is not sent twice. */
  sentByKey = /* @__PURE__ */ new Map();
  sendingByKey = /* @__PURE__ */ new Map();
  trackedSending = /* @__PURE__ */ new Map();
  sendState(conn, id) {
    const sender = this.requirePeer(conn), message = this.store.byId(id), pending = this.trackedSending.get(id);
    if (message && message.from.name !== sender.name || pending && pending.sender !== sender.name) {
      throw new BridgeError("unauthorized", "Only the original sender can inspect or retry this message id.");
    }
    return {
      id,
      state: message ? "stored" : pending ? "pending" : "not_stored",
      checkedAt: this.now(),
      message,
      receipts: message ? this.store.receipts(id) : []
    };
  }
  async onTrackedSend(conn, args) {
    const id = external_exports.uuid().parse(args.messageId).toLowerCase(), sender = this.requirePeer(conn);
    const state = this.sendState(conn, id);
    if (state.message) {
      const message = state.message;
      const bodyMatches = message.body === args.body || message.body.startsWith(args.body + "\n\n[agent-bridge routing hint:");
      if (!bodyMatches || !sender.jobAgent && message.to !== args.to.trim() || message.replyTo !== (args.replyTo?.trim() || null) || args.conversationId && message.conversationId !== args.conversationId.trim() && !(sender.jobAgent && message.conversationId === args.conversationId.trim() + ":fallback")) {
        throw new BridgeError("bad_request", "Message id already stored with different content; use a new id for a new message.");
      }
      const receipts = message.recipient.includes("/") ? await this.messageReceipt(conn, id).catch(() => state.receipts) : state.receipts;
      return { messages: this.store.messagesById(id), deliveredTo: [], queuedFor: [], storage: { id, state: "stored", recovered: true, receipts } };
    }
    const fingerprint = JSON.stringify([args.to, args.body, args.replyTo, args.conversationId, args.ifNoNewerThan]);
    const pending = this.trackedSending.get(id);
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw new BridgeError("bad_request", "Message id already pending with different content.");
      return pending.result;
    }
    const result = this.routeSend(conn, sender, { ...args, messageId: id }).then((sent) => ({
      ...sent,
      storage: { ...sent.storage, id, state: this.store.byId(id) ? "stored" : "not_stored", receipts: sent.storage?.receipts ?? this.store.receipts(id) }
    }));
    this.trackedSending.set(id, { sender: sender.name, fingerprint, result });
    try {
      return await result;
    } catch (error) {
      const state2 = this.store.byId(id) ? "stored" : "unknown";
      throw new BridgeError(
        error instanceof BridgeError ? error.code : "internal",
        `Message ${id} storage state is ${state2}; routing failed: ${error.message}. Query send_status or retry with the same message_id; remote storage may precede its acknowledgement.`,
        { ...error instanceof BridgeError ? error.details : {}, messageId: id, state: state2 }
      );
    } finally {
      this.trackedSending.delete(id);
    }
  }
  async onSend(conn, args) {
    const sender = this.requirePeer(conn);
    const key = typeof args.dedupeKey === "string" && args.dedupeKey ? `${sender.id}:${args.dedupeKey}` : null;
    const seen = key ? this.sentByKey.get(key) : void 0;
    if (seen) return seen.result;
    const inFlight = key ? this.sendingByKey.get(key) : void 0;
    if (inFlight) return inFlight;
    const sending = this.routeSend(conn, sender, args);
    if (key) this.sendingByKey.set(key, sending);
    let result;
    try {
      result = await sending;
    } finally {
      if (key) this.sendingByKey.delete(key);
    }
    if (key) {
      const now = this.now();
      this.sentByKey.set(key, { at: now, result });
      for (const [k, v] of this.sentByKey) {
        if (now - v.at < DEDUPE_KEEP_MS && this.sentByKey.size <= DEDUPE_MAX) break;
        this.sentByKey.delete(k);
      }
    }
    return result;
  }
  /** Reverse permissions use the current durable record, not stale runner registration. */
  replyRestriction(sender, name) {
    const jobs = this.storedJobs(), peer = this.connByName(name)?.peer;
    const stored = jobs.find((j) => j.name === name);
    if (!stored && !peer?.jobAgent) return null;
    const job = stored ?? {
      id: peer.id.replace(/^job:/, ""),
      name,
      owner: peer.jobParent,
      supervisor: peer.jobOwner,
      rootName: peer.rootName,
      parentJob: peer.parentJob,
      workdir: peer.cwd,
      args: { send_to: peer.jobSendTo }
    };
    const recipient = { ...peer, id: `job:${job.id}`, name, jobOwner: typeof job.supervisor === "string" ? job.supervisor : peer?.jobOwner };
    const grants = isRecord(job.args) && Array.isArray(job.args.send_to) ? job.args.send_to : [];
    if (sender.name === name || grants.includes(sender.name) || this.groups.canControl(sender, job, this.localPeers()) || sender.jobAgent && (this.sameJobFamily(recipient, sender, jobs) || this.sharedJobs(recipient, sender, jobs))) return null;
    return { name, supervisor: this.jobRecipient(job) || peer?.jobParent || "the project's main session" };
  }
  async routeSend(conn, sender, args) {
    const body = typeof args.body === "string" ? args.body : "";
    if (!body.trim()) throw new BridgeError("bad_request", "message body is empty");
    if (body.length > MAX_BODY_CHARS) throw new BridgeError("too_large", `message body exceeds ${MAX_BODY_CHARS} characters`);
    let to = String(args.to ?? "").trim();
    if (!to) throw new BridgeError("bad_request", "missing target");
    const own = sender.jobAgent ? this.storedJobs().find((j) => `job:${j.id}` === sender.id) : void 0;
    const supervisorMail = Boolean(own && (to === sender.jobParent || mastersFor(own).includes(to)));
    if (own) {
      if (to === sender.jobParent || mastersFor(own).includes(to)) to = this.jobRecipient(own);
      else if (Array.isArray(own.ownershipHistory) && own.ownershipHistory.some((h) => isRecord(h) && h.fromRootName === to)) to = String(own.rootName);
      this.refreshJobPeer(own);
    }
    const controlled = this.storedJobs().find((j) => j.name === to);
    if ((controlled || this.connByName(to)?.peer?.jobAgent) && !args.conversationId?.startsWith(CONTROL_CONVERSATION_PREFIX) && !args.conversationId?.startsWith(SIBLING_CONVERSATION_PREFIX)) {
      throw new BridgeError(
        "bad_request",
        "Ordinary direct mail to a job is not supported. Ask its supervisor to use message_subagent, or use the granted sibling channel. No message was stored.",
        { state: "not_stored", recipient: to }
      );
    }
    if (args.conversationId?.startsWith(CONTROL_CONVERSATION_PREFIX) && controlled && !this.groups.canControl(sender, controlled, this.localPeers())) {
      throw new BridgeError("unauthorized", "Only the current supervisor can control this job runner.");
    }
    let conversationId = args.conversationId?.trim() || "";
    let hop = 0;
    const replyTo = args.replyTo?.trim() || null;
    if (replyTo) {
      const parent = this.store.byId(replyTo);
      if (parent) {
        hop = parent.hop + 1;
        conversationId ||= parent.conversationId;
      } else {
        this.log.debug("replyTo refers to an unknown message", { replyTo });
      }
    }
    const anchor = args.ifNoNewerThan ? this.store.byId(args.ifNoNewerThan) : null;
    if (args.ifNoNewerThan && (!anchor || anchor.from.id !== sender.id && !this.store.receipts(anchor.id).some((r) => r.recipient === sender.name))) {
      throw new BridgeError("bad_request", "if_no_newer_than must identify a message exchanged by this session.");
    }
    conversationId ||= anchor?.conversationId || args.messageId || randomUUID3();
    if (own && (to === own.rootName || to === own.owner || this.groups.members(own, this.localPeers()).some((p) => p.name === to) || mastersFor(own).includes(to))) conversationId = this.jobConversation(own, to, conversationId);
    const id = args.messageId ?? (sender.jobAgent && args.dedupeKey?.startsWith(COMPLETION_DEDUPE_PREFIX) ? completionMessageId(sender.id, args.dedupeKey.slice(COMPLETION_DEDUPE_PREFIX.length)) : randomUUID3());
    const createdAt = this.now();
    const base = {
      id,
      // A job runner speaks for its job: from the subagent's agent, like a job run inside the session's server.
      from: { id: sender.id, name: sender.name, agent: sender.jobAgent ?? sender.agent },
      to,
      conversationId,
      replyTo,
      hop,
      body,
      createdAt,
      readAt: null
    };
    let remoteAddress = to.includes("/") ? to : void 0;
    if (to.startsWith("project:")) {
      const local = this.localPeers().filter((p) => !p.jobAgent && !p.subagent).map((p) => this.projectPeer(p)).filter((p) => p.projectAddress === to);
      const remote = this.network?.projectPeers(to) ?? [];
      const groups = /* @__PURE__ */ new Set([...local.map((p) => `local/${p.projectGroup}`), ...remote.map((p) => `${p.host}/${p.projectGroup}`)]);
      if (groups.size > 1) throw new BridgeError("ambiguous_target", "Several projects use this address; use an exact session or host/project address.");
      if (!local.length && remote.length) remoteAddress = this.requireNetwork().projectTarget(to);
    }
    if (remoteAddress) {
      if (anchor && this.store.replyConflicts(sender.name, [to], conversationId, anchor).length) {
        throw new BridgeError("bad_request", "Stale reply refused: newer unread mail exists. Read inbox before replying.");
      }
      const result2 = await this.requireNetwork().send({ ...base, recipient: remoteAddress });
      for (const message of result2.messages) await this.store.retryWrite(() => this.store.insert(message));
      return result2;
    }
    const remoteTargets = to === BROADCAST ? this.network?.peers().filter((p) => !p.jobAgent).map((p) => p.name) ?? [] : [];
    let { live, queued, skipped } = this.resolveTargets(to, sender);
    const unreadBeforeSend = conversationId.startsWith(CONTROL_CONVERSATION_PREFIX) || isQuietMessage({ conversationId }) ? [] : this.store.replyConflicts(sender.name, [...live.map((c) => c.peer.name), ...queued], conversationId);
    const checkReply = () => {
      if (!anchor) return;
      const newer = this.store.replyConflicts(sender.name, [...live.map((c) => c.peer.name), ...queued], conversationId, anchor);
      if (newer.length) throw new BridgeError("bad_request", `Stale reply refused: ${newer.length} newer unread message(s). Read inbox before replying.`, { messageIds: newer.map((m) => m.id) });
    };
    checkReply();
    if (own && to === this.jobRecipient(own)) {
      for (let i = live.length - 1; i >= 0; i--) {
        if (live[i].peer?.unavailable) queued.push(live.splice(i, 1)[0].peer.name);
      }
    }
    if (conversationId.startsWith(SIBLING_CONVERSATION_PREFIX) && (queued.some((name) => !sender.jobAgent || !this.storedSiblings(sender, name).some((s) => s.name === name)) || live.some((c) => c.peer.jobAgent && (!sender.jobAgent || !sender.jobOwner || !this.sameJobFamily(sender, c.peer) && !this.sharedJobs(sender, c.peer) && !sender.jobSendTo?.includes(c.peer.name))))) {
      throw new BridgeError("unauthorized", "sibling chat requires the same supervisor or an explicit send_to job grant");
    }
    let replyRestrictions = conversationId.startsWith(CONTROL_CONVERSATION_PREFIX) ? [] : [...live.map((c) => c.peer.name), ...queued].flatMap((name) => {
      const restriction = this.replyRestriction(sender, name);
      return restriction ? [restriction] : [];
    });
    const envelope = (recipient) => {
      const restriction = replyRestrictions.find((r) => r.name === recipient);
      return { ...base, recipient, body: restriction ? base.body + `

[agent-bridge routing hint: this sender can't receive your direct reply; answer via your supervisor ${restriction.supervisor} if needed.]` : base.body };
    };
    const messages = [];
    let inserted = true;
    if (supervisorMail) {
      await this.store.retryWrite(() => {
        checkReply();
        const current = this.storedJobs().find((job) => `job:${job.id}` === sender.id);
        if (!current) throw new BridgeError("unauthorized", "Job ownership is unavailable.");
        this.refreshJobPeer(current);
        to = this.jobRecipient(current);
        ({ live, queued } = this.resolveTargets(to, sender));
        for (let i = live.length - 1; i >= 0; i--) {
          if (live[i].peer?.unavailable) queued.push(live.splice(i, 1)[0].peer.name);
        }
        const recipient = live[0]?.peer.name ?? queued[0];
        const restriction = this.replyRestriction(sender, recipient);
        replyRestrictions = restriction ? [restriction] : [];
        const message = { ...envelope(recipient), to, conversationId: this.jobConversation(current, to, base.conversationId) };
        inserted = this.store.insertJobDelivery(message);
        messages.splice(0, messages.length, message);
      });
    } else {
      for (const c of live) messages.push(envelope(c.peer.name));
      for (const key of queued) messages.push(envelope(key));
      await this.store.retryWrite(() => this.store.insertBatch(messages, checkReply));
    }
    if (inserted) live.forEach((c, i) => this.emit(c, "message", messages[i]));
    this.log.info("message routed", {
      id,
      from: sender.name,
      to,
      hop,
      deliveredTo: live.map((c) => c.peer.name),
      queuedFor: queued
    });
    const result = { messages, ...skipped ? { skippedFor: skipped } : {}, deliveredTo: live.map((c) => c.peer.name), queuedFor: queued, recipientStates: live.map((c) => ({ name: c.peer.name, activity: c.peer.activity, autoWake: c.peer.autoWake, wakeOnDirect: c.peer.wakeOnDirect, wakeAvailable: c.peer.wakeAvailable, wakeMaxHops: c.peer.wakeMaxHops })) };
    if (to.startsWith("project:") && live[0]?.peer) result.projectRoute = this.projectPeer(live[0].peer).projectRoute;
    if (replyRestrictions.length) result.replyRestrictions = replyRestrictions;
    if (unreadBeforeSend.length) result.unreadBeforeSend = unreadBeforeSend.map((m) => ({ id: m.id, from: m.from.name, conversationId: m.conversationId }));
    for (const recipient of remoteTargets) {
      try {
        const remote = await this.requireNetwork().send({ ...base, recipient });
        for (const message of remote.messages) await this.store.retryWrite(() => this.store.insert(message));
        result.messages.push(...remote.messages);
        result.deliveredTo.push(...remote.deliveredTo);
        result.queuedFor.push(...remote.queuedFor);
        result.recipientStates.push(...remote.recipientStates ?? []);
      } catch (err) {
        const message = { ...base, recipient };
        await this.store.retryWrite(() => this.store.insert(message));
        result.messages.push(message);
        (result.failedFor ??= []).push({ name: recipient, reason: err.message });
        this.log.warn("broadcast recipient delivery failed", { id, recipient, err: String(err) });
      }
    }
    result.wakeRequestedFor = (result.recipientStates ?? []).filter((peer) => {
      const message = result.messages.find((m) => m.recipient === peer.name);
      return Boolean(message && peer.wakeAvailable && (peer.autoWake || peer.wakeOnDirect && (message.to === BROADCAST || message.to === peer.name || message.recipient === peer.name && !AGENT_KINDS.includes(message.to))) && message.hop < (peer.wakeMaxHops ?? DEFAULT_MAX_HOPS) && !isQuietMessage(message) && !message.conversationId.endsWith(":note"));
    }).map((peer) => peer.name);
    return result;
  }
  /** A pending response is one frame, unlike streamed replay events. Bound it by bytes as well as rows. */
  pendingMail(recipient, limit) {
    const result = [];
    const unavailable = this.connByName(recipient)?.peer?.unavailable;
    let bytes = 1024;
    for (const message of this.unreadMail(recipient, limit)) {
      if (unavailable && message.from.id.startsWith("job:") && !message.conversationId.startsWith("siblings-")) continue;
      const size = Buffer.byteLength(JSON.stringify(message)) + 1;
      if (bytes + size > MAX_FRAME_BYTES) break;
      result.push(message);
      bytes += size;
    }
    return result;
  }
  unreadMail(recipient, limit) {
    const messages = this.store.unread(recipient, limit);
    if (!this.jobsPath) return messages;
    const noteSenders = new Set(messages.filter((m) => !isQuietMessage(m) && m.conversationId.endsWith(SIBLING_NOTE_SUFFIX)).map((m) => m.from.id));
    if (!noteSenders.size) return messages;
    const finished = new Set(this.storedJobs().filter((j) => noteSenders.has(`job:${j.id}`) && j.status && j.status !== "running" && (!primaryFor(j) || !j.projectRoot && !j.deliveryHistory && !j.ownershipHistory && !this.groups.jobRoot(j, this.localPeers()))).map((j) => `job:${j.id}`));
    const obsolete = messages.filter((m) => !isQuietMessage(m) && m.conversationId.endsWith(SIBLING_NOTE_SUFFIX) && finished.has(m.from.id));
    this.store.markRead(recipient, obsolete.map((m) => m.id), this.now());
    return messages.filter((m) => !obsolete.includes(m));
  }
  remoteReceipt(id, sender, recipient) {
    const message = this.store.byId(id);
    const current = this.network?.peers().find((p) => p.id === sender);
    const sameSender = message && (message.from.id === sender || sender.includes("/") && message.from.id.split("/")[0] === sender.split("/")[0] && current?.name === message.from.name && current.agent === message.from.agent);
    if (!message || !sameSender) throw new BridgeError("unauthorized", "receipt is only available to the sender");
    const receipts = this.store.receipts(id);
    const receipt = recipient ? receipts.find((r) => r.recipient === recipient) : receipts[0];
    const addressedAlias = recipient && message.to !== BROADCAST && message.to.split("/").at(-1) === recipient;
    return (receipt ?? (addressedAlias ? receipts.find((r) => r.recipient === message.recipient) : void 0))?.readAt ?? null;
  }
  async messageReceipt(conn, id) {
    const sender = this.requirePeer(conn);
    const message = this.store.byId(external_exports.uuid().parse(id));
    if (!message || message.from.name !== sender.name) throw new BridgeError("unauthorized", "receipt is only available to the sender");
    const receipts = this.store.receipts(id);
    return Promise.all(receipts.map(async (r) => r.recipient.includes("/") ? { ...r, readAt: await this.requireNetwork().receipt(
      r.recipient,
      id,
      message.from.id,
      receipts.filter((other) => other.recipient.startsWith(`${r.recipient.split("/")[0]}/`)).length > 1
    ) } : r));
  }
  requireNetwork() {
    if (!this.network) throw new BridgeError("bad_request", "networking is disabled or unavailable; enable it and restart the broker");
    return this.network;
  }
  async onSendFiles(conn, args) {
    const sender = this.requirePeer(conn);
    const parsed = external_exports.object({ to: external_exports.string().min(1).max(MAX_FILE_ADDRESS_CHARS), paths: external_exports.array(external_exports.string().min(1).max(MAX_FILE_PATH_CHARS)).min(1).max(MAX_STREAM_ENTRIES) }).parse(args);
    const remote = parsed.to.includes("/");
    if (remote) return this.requireNetwork().startFiles(parsed.to, parsed.paths, sender.cwd, { id: sender.id, name: sender.name, agent: sender.jobAgent ?? sender.agent });
    const target = parsed.to;
    const transfer = collectTransfer(parsed.paths, sender.cwd, target, { id: sender.id, name: sender.name, agent: sender.jobAgent ?? sender.agent });
    if (!this.connByName(target)) throw new BridgeError("unknown_target", "file recipient must be online");
    const home = this.networking?.home;
    if (!home) throw new BridgeError("bad_request", "file inbox home is unavailable");
    const result = receiveTransfer(home, transfer);
    this.receiveRemote({ id: transfer.id, from: transfer.from, to: target, recipient: target, conversationId: transfer.id, replyTo: null, hop: 0, body: `Received ${result.files} files (${result.bytes} bytes) in ${result.inbox}`, createdAt: this.now(), readAt: null });
    return result;
  }
  receiveRemote(message) {
    const target = this.recipientConn(message.recipient);
    if (target?.peer) message = { ...message, recipient: target.peer.name };
    const existing = this.store.byId(message.id);
    if (existing) {
      const broadcastCopy = existing.to === BROADCAST && message.to === BROADCAST;
      const sameSender = existing.from.id === message.from.id || message.from.id.includes("/") && existing.from.id.split("/")[0] === message.from.id.split("/")[0] && existing.from.name === message.from.name;
      const projectRetry = message.to.startsWith("project:") || /^[^/]+\/project:/.test(message.to);
      const sameRecipient = existing.recipient === message.recipient || projectRetry || !broadcastCopy && target?.peer && this.recipientConn(existing.recipient) === target;
      if (!sameSender || existing.from.name !== message.from.name || existing.from.agent !== message.from.agent || !broadcastCopy && !sameRecipient || existing.to !== message.to || existing.body !== message.body || existing.conversationId !== message.conversationId || existing.replyTo !== message.replyTo || existing.hop !== message.hop) throw new BridgeError("bad_request", "Message id already stored with different content; use a new id for a new message.");
      const receipt = this.store.receipts(message.id).find((r) => !broadcastCopy && r.recipient === existing.recipient || r.recipient === message.recipient);
      if (receipt) return { delivered: Boolean(this.recipientConn(receipt.recipient)), recipient: receipt.recipient, stored: true, recovered: true, readAt: receipt.readAt };
    }
    this.store.insert(message);
    if (target) this.emit(target, "message", message);
    return { delivered: Boolean(target), recipient: message.recipient, stored: true, readAt: null };
  }
};
export {
  Broker,
  PEER_NAME_PATTERN
};
