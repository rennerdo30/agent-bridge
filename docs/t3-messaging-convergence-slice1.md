# AB-458 convergence slice1 WIP receipt

**Parent design hold on nonmutating inspection. This is not a completed slice1 candidate, independent acceptance, merge, release or installed migration.**

Checkout: `E:/AgentData/claude-codex-comm/t3-6416720d`, branch `t3/ab458-slice1-migration`. Keep this same candidate for later slices.

- Starting main: `5e3fa8aa17d22d57cb5d24549c16381c5843edeb`, tree `099261e3f7c378f38bf2ecb2dcf4ca4479d9fabf`.
- Reviewed design: `24a650e1fda1d10b9cb99d9495e0c815d23c9cd9`. Read in full before source edits; attributed documentation cherry-picks `2ba6e32c` then `4d2c0ba3`.
- Source/test freeze: `0f4d4d45025b587604f17c4eac420b3e8b532fd4`, tree `553018b6bb378b51a9948bd36d0e6925da13769f`. Both checks below ran on this exact clean tracked tree; their final commit/tree observations match.
- This receipt is a later artifact-only commit. No corrected production/test freeze exists. A receipt commit does not inherit a new test pass. Its final artifact commit/tree is reported by the parent-facing handoff, avoiding a self-referential tree hash inside this file.
- Preserved PR141 remains `c94cf75602c53e7949d68066071c2b05f11df986`; its writer checkout `C:/Users/renne/.t3/worktrees/claude-codex-comm/t3-c91ee5ff` was not modified. No integration, new PR, reset, force push or history rewrite.

## Implemented source scope, not runtime acceptance

- p12/m7/s15 admission tuple, additive envelope/grant tables and candidate marker; shipping originals receive ambiguous proof rows without guessed owner/direction. Pairing1/JSON4/runner-ledger-v2 semantics remain for subsequent slices. No messaging-handler/runner/backup redesign or native-port enablement.
- Ordinary synchronous initializer with owned construction cleanup, remaining busy-timeout restoration, exact prior endpoints p2..p11, asynchronous identity preparation, original outer10s budget and separate aggregate2s connection observation. No bootstrap Worker, external journal, ancestor/home publication, directory barrier or custom VFS. SQLite WAL/FULL is verified per ordinary authority writer; archive destination commits and exact copy verification precede source retirement.
- Exact-home `migrateMessagingHome` API in metadata-db.ts and `agent-bridge storage migrate-messaging --source <absolute-home> --destination <absolute-isolated-home> --check`; apply requires `--yes --offline-isolated`. Optional `--mailbox <exact-basename>` declares alternate data roles. Early dispatch in main.ts precedes ambient-home resolution/logger/token work. These are source-only implementations; no owner home was inspected, copied or migrated.
- Apply retains source and protected input snapshots; immutable input/attempt identity and SQL phase/CAS live in existing bridge_metadata. Source draft schemas10..14/metadata2..6 refuse, and an interrupted destination cannot serve. Unknown/private input remains retained and explicitly listed; it is never guessed empty or certified as a complete full backup. Copy interruption/changed bytes/unknown COMMIT remain held rather than receiving an external callback retry. The finite migration and CAS regressions are written but **NOT RUN** because the selection stopped earlier.
- Parent approved exactly two timeout/busy_timeout sites in history-store.ts plus the necessary import. They share the existing admission budget and restore normal3000ms policy; no history/schema/import changes. Exact delta below.

## Red inspection evidence and parent hold

The unchanged assertion at test/messaging-convergence-slice1.test.ts:147 failed in `refuses namespace before metadata, snapshots or schema repair`. The fixture first creates a synthetic current home, closes the store and metadata handles, removes its namespace, closes that synthetic writer, and captures all file hashes. Both expected API refusals occurred. Their preflight inspection nonetheless created sidecars.

Exact call graph on the source freeze:

1. Test lines138–147: `metadataDb(path)` then `new MessageStore(bridge.db, ...)`; final complete-file hash comparison is unchanged.
2. metadata-db.ts:179–181 calls `preflightMessagingHome(home)` before metadata initialization/cache return.
3. mailbox-layout.ts:46–57 constructs `new DatabaseSync(file, {readOnly:true, timeout:storageAdmissionTimeout(0)})`; effective timeout0. It calls `assertMailboxVersion`, whose first PRAGMA reads user_version and invokes `assertCurrentMailboxEnvelope` for schema15.
4. The current-layout guard finds the missing namespace and refuses. The red run establishes that native read-open/first-page inspection created WAL/SHM; it does not isolate creation to one specific C++ constructor/PRAGMA/VFS syscall. No instrumented native trace was run.
5. The MessageStore constructor at store.ts:442–449 delegates to `openMessageStore`; its preflight at1143 (and constructor459) repeats this defective boundary. The second refusal does not undo files already created.

SQLite options: ordinary bundled Node26.4.0 node:sqlite; readOnly=true, timeout=0; no immutable URI, alternate/no-lock VFS, repair, checkpoint or explicit WAL pragma in this early inspection. Node's [v26.4.0 opener](https://github.com/nodejs/node/blob/v26.4.0/src/node_sqlite.cc#L895-L903) passes ordinary read-only/URI open flags to SQLite. [SQLite WAL documentation](https://www.sqlite.org/wal.html#read_only_databases) distinguishes read-only WAL access and shared-memory setup. These source reads are not a new native verification.

Observed synthetic directory: `E:/AgentData/claude-codex-comm/t3-6416720d/.agent-bridge-test/slice1-fixtures/aa54570b-ac82-404b-b527-a347e171be55`.

| File | SHA256 from red diff | Observation |
| --- | --- | --- |
| bridge.db | 5fde6b026ca5491b159bebf0a04fb17cbd3d9eba9119b4a2280edc976d9bcdcb | Original database hash unchanged |
| bridge.db-wal | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 | Newly created, empty |
| bridge.db-shm | fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb | Newly created |

The parent explicitly holds this correction as WIP. No scratch copy, custom VFS, immutable bypass, bare-header authority, assertion weakening or new subsystem was implemented. Immutable/main-file-only reads cannot be treated as authoritative over live WAL/hot-journal data. Parent is investigating whether supported existing sidecars or proven closed isolated inputs permit a narrow consistent nonmutating path. Unknown/racy input must refuse. The allowed corrected focused selection and noEmit are **both unspent**, each with an external60s deadline after a corrected source freeze. A timeout/failure ends that allowance.

## Verification and exact process receipts

| Check | Source | Own wrapper / shell / check PID | JST start–end | External deadline / result |
| --- | --- | --- | --- | --- |
| noEmit | 0f4d4d45 / 553018b6 | 41444 / 53944 / 21548 | 2026-10-24 09:09:40.546–09:09:41.967 | 60000ms; 1421ms elapsed; exit0; no timeout |
| Focused mocked/offline | Same | 33920 / 78408 / 69248 | 2026-10-24 09:09:46.817–09:09:49.315 | 60000ms; 2498ms elapsed; exit1; no timeout |

Vitest5.0.2 reported **19 passed, 1 failed, 38 total** and stopped with bail1. Remaining18 are unaccepted, including migration/interruption/CAS/final mocked recovery schedules after the failure. This is not a focused pass. No corrected run or wrapper retry occurred. Original noEmit is a source-freeze typing pass, not a claim that every runtime contract works.

Raw first headers (same first line in each stdout/stderr pair):

```json
{"kind":"noEmit","commit":"0f4d4d45025b587604f17c4eac420b3e8b532fd4","tree":"553018b6bb378b51a9948bd36d0e6925da13769f","wrapperPID":41444,"parentPID":53944,"childPID":21548,"start":"2026-10-24T00:09:40.546Z","externalDeadlineMs":60000,"command":"C:\\Program Files\\nodejs\\node.exe node_modules/typescript/bin/tsc --noEmit"}
```

```json
{"kind":"focused","commit":"0f4d4d45025b587604f17c4eac420b3e8b532fd4","tree":"553018b6bb378b51a9948bd36d0e6925da13769f","wrapperPID":33920,"parentPID":78408,"childPID":69248,"start":"2026-10-24T00:09:46.817Z","externalDeadlineMs":60000,"command":"C:\\Program Files\\nodejs\\node.exe node_modules/vitest/vitest.mjs run test/messaging-convergence-slice1.test.ts --maxWorkers=1 --pool=threads --no-file-parallelism --reporter=dot --bail=1"}
```

Commands:

```text
C:\Program Files\nodejs\node.exe node_modules/typescript/bin/tsc --noEmit
C:\Program Files\nodejs\node.exe node_modules/vitest/vitest.mjs run test/messaging-convergence-slice1.test.ts --maxWorkers=1 --pool=threads --no-file-parallelism --reporter=dot --bail=1
```

Only synthetic temporary data was used. Node modules were reused via a local ignored junction to `E:/Development/claude-codex-comm/node_modules`; no dependency install/update/cache wipe, application/daemon/provider/production Worker/helper/TLS/full-suite/build/native/installed migration/restore/release launch. Test subprocess/production Worker/server paths were guarded; the Vitest thread runner was allowed. Recorded check processes exited normally with their stated codes; no termination by name/title/timing or foreign process cleanup.

NOT RUN: corrected checks; protected pin test; full/lifecycle/provider/TLS/native/actual-worker checks; all-platform runtime acceptance; full restore; installed migration; native connector; actual two-PC delivery/consumption; release/update. No new guarantee equivalent to whole-home power-loss publication.

## Protected source delta, no pin amendments

The exact unchanged methodBody normalizer from mobile-wiring.test.ts was copied into a static artifact utility and TypeScript syntax was stripped only for evaluation. Normalizer source hash `93ca63b8638622cc790c0d776b544af0840133e4c144ce792836e718a93b664a`. No normalizer/baseline/test assertion was edited. Static extraction's two initial syntax failures and subsequent corrected extraction are retained separately; they were not test/noEmit runs.

| Method | Exact normalized before SHA256 | Exact normalized after SHA256 |
| --- | --- | --- |
| src/core/broker.ts:constructor | e7c1745f8b8e42bc9859fb663bfe091b629905bc20a30471711f266df7fbef7b | e7c1745f8b8e42bc9859fb663bfe091b629905bc20a30471711f266df7fbef7b |
| src/core/broker.ts:listen | bd39e0afecb5a74d76161f26d5923f2c1e41da8cc490ed1448a9260b850ce4b0 | 1d11f6c6f50df2eb1146622a9d098b681e5472e9a7c5df74a7e07eafa51db883 |
| src/core/broker.ts:startServices | 07bc9bdb56bea9ae2c5c3f0c89639469f7fa5ccfb0d8e5bc97fc1efbfd93fe2f | 4f247c185cc8922a37705b47d4d798ed6ab68b780019df20c86c7f07f946997d |
| src/core/broker.ts:abortStartup | 6132967fa78fd39cff064a581f4f49bb9c1c75b644fba78b291708c58733118c | 6132967fa78fd39cff064a581f4f49bb9c1c75b644fba78b291708c58733118c |
| src/core/broker.ts:close | fb5a92326cac082ae181f38208c0af708a2b342297038d021f67a13bcd8b9b27 | fb5a92326cac082ae181f38208c0af708a2b342297038d021f67a13bcd8b9b27 |
| src/core/node.ts:constructor | 0094b2611e538459faa5577274f1a9b2437e7a3c1f6e9361cbe2c02428f0dd07 | c67f1d31ca97c17d3c6871b7d88df7428ed9a82da8395ee8b23ffdbb37ca30cd |
| src/core/node.ts:start | c2444cc1c41903a2489d3142952a79d2d562b37cea8bf617ae4db5a2b2e10299 | 71eaf40e79c02ad1d60723b6ae8af18198a60179b2f116842356178b6e8c36cc |
| src/core/node.ts:stop | b98b5631cf7643be62bce61fac172fc79c0da09db2c7720abf14502736b57359 | b98b5631cf7643be62bce61fac172fc79c0da09db2c7720abf14502736b57359 |
| src/core/node.ts:tryBecomeBroker | 54662336fe5017d38e0ea9cfd79638255e9f2860c3a7aa0cda2a8c5408dfb5a3 | e7d246d01f97f8cef845523edf76d198244a07c600216a18cb1420e4fa78fee0 |
| src/cli/dashboard.ts:constructor | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a |
| src/cli/dashboard.ts:open | 6eacbb835304e2a5d3c303c54c3c674910cbf4f9a5411b3af62a7747fe2d211b | 6eacbb835304e2a5d3c303c54c3c674910cbf4f9a5411b3af62a7747fe2d211b |
| src/cli/dashboard.ts:ensure | d19ca8a9485ccc07d588997e3497bc11545e730a264e9a6f59bf1ceb0dfcda49 | d19ca8a9485ccc07d588997e3497bc11545e730a264e9a6f59bf1ceb0dfcda49 |
| src/cli/dashboard.ts:close | 534d315c24ff13f59aa4082abf2fb66906e6bee9b979a6348979cbaef89ec7b4 | 534d315c24ff13f59aa4082abf2fb66906e6bee9b979a6348979cbaef89ec7b4 |

Five bodies changed: broker.listen, broker.startServices, node.constructor, node.start, node.tryBecomeBroker. Other eight, including broker constructor/abortStartup/close, node.stop and all four dashboard methods, are exact unchanged normalized bodies. UI, baseline, normalizers and retention guard remain unchanged. Parent must review these exact deltas before any separate pin amendment. No pin acceptance is claimed.

- Raw exact normalized JSON patch SHA256: `cf7a1cb046629eb08204fab366b736fac0336032b90fd1ccf1927a0c1ccc7e01`.
- Readable normalized method patch SHA256: `785c96ae4cfefcb9f9c04414e87b8df40a7a4fbdd33cdc1c2d05e89f2f83eac3`.
- Raw baseline SHA256: `6f2fdccc956f041f96e12c1ef3658026fcfa6aaf9be5dcd211aeeaad3876c137`; actual UI file SHA256: `dff4d25a71aeb728ab6ea6cbc5d00ed01ba50e5ef14a25fc2bbfca1c8ba4ab38`; retention guard SHA256: `7e2e1b964de51ded5257fd1c66b610374d90041026a91c8b37280851d5e2cbc5`. These raw file hashes differ from any separately normalized UI-baseline hash by design.

Readable exact normalized method delta:

```diff
diff --git a/.agent-bridge-test/slice1-review/before/src_core_broker.ts_listen.txt b/.agent-bridge-test/slice1-review/after/src_core_broker.ts_listen.txt
index 98a0e6d5..9492922e 100644
--- a/.agent-bridge-test/slice1-review/before/src_core_broker.ts_listen.txt
+++ b/.agent-bridge-test/slice1-review/after/src_core_broker.ts_listen.txt
@@ -1,23 +1,32 @@
 {
-if (reservation) return this.listenReserved(reservation);
-return new Promise((resolve, reject) => {
-const server = createServer((socket) => this.accept(socket));
+const budget = startup ?? new StartupBudget();
+if (reservation) return this.listenReserved(reservation,budget).finally(()=>{if (!startup) budget.close();});
+this.networkAuthorityDeferred = true;
+let admitted = false;
+return new Promise<void>((resolve, reject) => {
+const server = createServer((socket) => { if (admitted) this.accept(socket); else socket.destroy(); });
 const onError = (err: Error) => {
 server.removeListener("listening", listening);
 reject(err);
 };
 /** Optional services: a failure is logged and the broker keeps serving without them (AB-223, AB-239). */
 const optional = (what: string, step: () => void) => {
-try { step(); } catch (err) { this.log.warn(`broker startup: ${what} failed; continuing without it`, { err: String(err) }); }
+try { budget.remaining(); step(); budget.remaining(); } catch (err) { budget.remaining(); this.log.warn(`broker startup: ${what} failed; continuing without it`, { err: String(err) }); }
 };
 const onListening = async () => {
 server.removeListener("error", onError);
 server.on("error", (err) => this.log.error("broker server error", { err }));
 this.server = server;
 try {
-await this.startServices(optional);
-this.tcpReady = this.startTcpFallback();
+budget.remaining();
+await this.startServices(optional,budget);
+await this.checkStartupAdmission(budget);
+this.tcpReady = this.startTcpFallback(budget);
 await this.tcpReady.catch(err => this.log.warn("broker TCP fallback unavailable", { err: String(err) }));
+budget.remaining();
+await this.checkStartupAdmission(budget);
+this.network?.activateAuthority(); this.networkAuthorityDeferred=false;
+admitted = true;
 resolve();
 } catch (err) {
 // Never leave a bound, half-started broker behind or an unhandled rejection: release the endpoint and let
@@ -31,6 +40,6 @@ const listening = () => { void onListening(); };
 server.once("error", onError);
 server.once("listening", listening);
 ensurePrivateSocketDirectory(this.pipePath);
-server.listen(this.pipePath);
-});
+budget.remaining(); server.listen(this.pipePath);
+}).finally(()=>{if (!startup) budget.close();});
 }
diff --git a/.agent-bridge-test/slice1-review/before/src_core_broker.ts_startServices.txt b/.agent-bridge-test/slice1-review/after/src_core_broker.ts_startServices.txt
index ee7ece7d..86349d1b 100644
--- a/.agent-bridge-test/slice1-review/before/src_core_broker.ts_startServices.txt
+++ b/.agent-bridge-test/slice1-review/after/src_core_broker.ts_startServices.txt
@@ -1,6 +1,8 @@
 {
-if (this.jobsPath) void startBrokerJobRunIndex(dirname(this.jobsPath)).catch(error => this.log.warn("job run index preparing", { err: String(error) }));
+budget?.remaining();
 await this.nativeChildren.recover();
+if (budget) await this.checkStartupAdmission(budget);
+if (this.jobsPath) void startBrokerJobRunIndex(dirname(this.jobsPath)).catch(error => this.log.warn("job run index preparing", { err: String(error) }));
 if (this.jobsPath && this.store.file !== ":memory:") optional("job archive worker", () => { this.jobArchiveBackground = new JobArchiveBackground(this.jobsPath!, this.log); });
 optional("backups", () => this.store.startBackups());
 this.healthMonitor.start();
diff --git a/.agent-bridge-test/slice1-review/before/src_core_node.ts_constructor.txt b/.agent-bridge-test/slice1-review/after/src_core_node.ts_constructor.txt
index b659345b..e2b7da52 100644
--- a/.agent-bridge-test/slice1-review/before/src_core_node.ts_constructor.txt
+++ b/.agent-bridge-test/slice1-review/after/src_core_node.ts_constructor.txt
@@ -5,8 +5,7 @@ this.currentName = opts.name;
 this.currentCwd = opts.cwd;
 this.autoWake = opts.autoWake;
 this.log = opts.log.child("node");
-if (opts.dbPath !== ":memory:") this.recordStorePresence();
+if (opts.dbPath !== ':memory:') preflightMessagingHome(dirname(opts.dbPath));
 if (opts.dbPath !== ":memory:") this.releaseMetadata = retainMetadataReader(dirname(opts.dbPath));
 this.readJournal = new ReadJournal(opts.dbPath === ":memory:" ? ":memory:" : dirname(opts.dbPath), this.log);
-this.restoreReadState(`name:${this.currentName}`);
 }
diff --git a/.agent-bridge-test/slice1-review/before/src_core_node.ts_start.txt b/.agent-bridge-test/slice1-review/after/src_core_node.ts_start.txt
index ee7c22f3..95a31fcc 100644
--- a/.agent-bridge-test/slice1-review/before/src_core_node.ts_start.txt
+++ b/.agent-bridge-test/slice1-review/after/src_core_node.ts_start.txt
@@ -2,6 +2,6 @@
 if (!this.releaseMetadata && this.opts.dbPath !== ":memory:") this.releaseMetadata = retainMetadataReader(dirname(this.opts.dbPath));
 // Registration needs the host CLI's creation identity (a PowerShell query on Windows). Start the shared,
 // memoized read now so it overlaps discovery and daemon creation instead of following broker readiness.
-if (!this.opts.jobAgent) void parentProcessIdentity();
 await this.ensureConnected();
+if (this.opts.dbPath !== ':memory:') this.recordStorePresence();
 }
diff --git a/.agent-bridge-test/slice1-review/before/src_core_node.ts_tryBecomeBroker.txt b/.agent-bridge-test/slice1-review/after/src_core_node.ts_tryBecomeBroker.txt
index d2080aa9..e089875b 100644
--- a/.agent-bridge-test/slice1-review/before/src_core_node.ts_tryBecomeBroker.txt
+++ b/.agent-bridge-test/slice1-review/after/src_core_node.ts_tryBecomeBroker.txt
@@ -3,8 +3,8 @@ if (this.broker) return true;
 if (this.stopping) return false;
 // The store's migration lock and the TCP fallback record need this process's identity; read it without
 // blocking the session's event loop (a synchronous PowerShell query on Windows otherwise).
-const identity = this.opts.dbPath === ":memory:" ? undefined : ownProcessIdentity();
-const [{ Broker }, { MessageStore }] = await Promise.all([import("./broker.js"), import("./store.js")]);
+const budget = this.startupBudget!; budget.remaining();
+const { Broker } = await import("./broker.js");
 const { EndpointReservation } = await import("./endpoint-reservation.js");
 let reservation: import("./endpoint-reservation.js").EndpointReservation;
 try { reservation = await EndpointReservation.bind(this.opts.pipePath); }
@@ -13,15 +13,17 @@ if (errCode(error) !== "EADDRINUSE") throw error;
 if (!this.opts.daemon && (this.opts.platform ?? process.platform) !== "win32") await this.clearStaleSocket();
 return false;
 }
-await identity;
 let store: MessageStore;
 try {
+budget.remaining();
 // Unverified living readers conservatively defer upgrades; process
 // discovery must not delay hosting their existing compatible schema.
-if (this.opts.dbPath !== ":memory:") void refreshStorePeerIdentities(dirname(this.opts.dbPath)).catch(error => this.log.debug("store reader identity refresh deferred", { err: String(error) }));
-store = new MessageStore(this.opts.dbPath, this.log.child("store"));
+if (this.initializedThisAttempt) throw new BridgeError('internal','Initializer already attempted; original settlement retained');
+this.initializedThisAttempt = true;
+store = await openAdmittedMessageStore(this.opts.dbPath,dirname(this.opts.dbPath),this.opts.pipePath,this.log.child('store'),budget);
 } catch (err) {
 await reservation.close();
+if (this.initializedThisAttempt) throw err;
 if (["EBUSY", "SQLITE_BUSY", "STORE_UPGRADE_DEFERRED"].includes(errCode(err)) || /database is locked/.test(String((err as Error).message))) {
 this.log.info("another session is preparing the store; retrying broker election", { db: this.opts.dbPath });
 return false;
@@ -32,7 +34,8 @@ throw err;
 try {
 const broker = new Broker(this.opts.pipePath, store, this.log.child("broker"), this.opts.token, Date.now, join(dirname(this.opts.dbPath), JOBS_FILE), this.opts.network);
 if (this.degradedReason) broker.setHostingMode("embedded_degraded", this.degradedReason);
-await broker.listen(reservation);
+await broker.listen(reservation,budget);
+budget.remaining();
 if (this.stopping) {
 // stop() ran while this node was opening the store or listening: never keep a broker nobody will close.
 await broker.close();
@@ -44,22 +47,6 @@ return true;
 } catch (err) {
 store.close();
 await reservation.close();
-const code = errCode(err);
-if (code === "EADDRINUSE" && (this.opts.platform ?? process.platform) !== "win32") {
-if (this.opts.daemon) return false;
-// A Unix socket file can outlive its process. If connecting failed, the file is stale.
-try {
-await BridgeClient.connect(this.opts.pipePath, this.log).then((c) => c.close());
-return false; // someone is alive after all
-} catch (probeErr) {
-if (errCode(probeErr) === "ECONNREFUSED") {
-this.log.warn("removing stale broker socket", { pipe: this.opts.pipePath });
-await this.clearStaleSocket();
-}
-}
-} else {
-this.log.debug("could not become broker", { code });
-}
-return false;
+throw err;
 }
 }
```

Parent-approved history seam (only import plus two timeout sites):

```diff
diff --git a/src/core/history-store.ts b/src/core/history-store.ts
index 58e62e09..743829c8 100644
--- a/src/core/history-store.ts
+++ b/src/core/history-store.ts
@@ -4,6 +4,7 @@ import { DatabaseSync } from "node:sqlite";
 import { CONVERSATION_RECORDS_VIEW, historyStoreV2Schema, HISTORY_V2_COPY_TABLES } from "./history-schema-v2.js";
 import { registerHistoryFunctions } from "./history-codec.js";
 import { configureSqlite, isSqliteBusy } from "./sqlite-policy.js";
+import { admissionSqliteBusy, storageAdmissionTimeout } from "./storage-admission.js";
 import { migrationLock } from "./migration-lock.js";
 import { liveStorePeers, refreshStorePeerIdentities } from "./store-compatibility.js";
 import { encodeHistoryRow, decodeHistoryRow, HISTORY_V1_PREFIX, resumableHistoryMigration, type HistoryMigrationOptions } from "./history-migration.js";
@@ -167,11 +168,11 @@ export function historyInitializationObservation(db: DatabaseSync): Readonly<{
     ownerBound: false, ownershipReleased: false });
 }
 export function openHistoryStore(file: string): DatabaseSync {
-  const db = new DatabaseSync(file, { timeout: 3000 });
+  const db = new DatabaseSync(file, { timeout: storageAdmissionTimeout(3000) });
   const record: HistoryInitialization = { identity: Symbol(), db, file, state: "initializing", close: "not_attempted" };
   historyInitializations.set(db, record); // Capture before configuration or migration can fail.
   try {
-    db.exec("PRAGMA busy_timeout=3000");
+    admissionSqliteBusy(db,3000,true);
     registerHistoryFunctions(db);
     const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
     if (version > HISTORY_STORE_VERSION) throw new Error(`unsupported history store version: ${version}`);
```

## Source / artifact separation and retained files

Source/test freeze changed these30 paths from the exact starting main (29 implementation/test paths plus the attributed reviewed design):

```text
docs/t3-messaging-convergence-design.md
src/cli/broker-daemon.ts
src/cli/doctor.ts
src/cli/main.ts
src/cli/reindex.ts
src/cli/storage.ts
src/core/broker.ts
src/core/client.ts
src/core/constants.ts
src/core/daemon-launcher.ts
src/core/doctor.ts
src/core/history-store.ts
src/core/mailbox-layout.ts
src/core/metadata-db.ts
src/core/metadata-file-lease.ts
src/core/node.ts
src/core/prior-endpoints.ts
src/core/process-identity.ts
src/core/sqlite-maintenance.ts
src/core/sqlite-migrations.ts
src/core/sqlite-policy.ts
src/core/startup-budget.ts
src/core/storage-admission.ts
src/core/storage-lock.ts
src/core/store-compatibility-overlay.ts
src/core/store-compatibility.ts
src/core/store-version.ts
src/core/store.ts
src/core/windows-process-identity.ts
test/messaging-convergence-slice1.test.ts
```

This receipt adds one documentation-only path, docs/t3-messaging-convergence-slice1.md. Generated plugin bundles, rule files, protected baselines, UI/dashboard source and earlier PR141 evidence are unchanged. The primary checkout was only read: main...origin/main with foreign untracked .worktrees/ and Python/, neither traversed nor modified.

All local raw logs, process receipts, normalization inputs, both patch representations, manifest, static utility/error notes and synthetic originals remain under `E:/AgentData/claude-codex-comm/t3-6416720d/.agent-bridge-test/`; none was deleted. Full artifact inventory: slice1-review/artifact-files.json. Full synthetic file inventory: slice1-review/retained-synthetic-files.json (24 files). These ignored raw/synthetic artifacts are separate from committed source and are preserved in the assigned candidate for parent inspection.

Key retained artifact hashes:

| Path under .agent-bridge-test/slice1-review | Bytes | SHA256 |
| --- | --- | --- |
| finalize-receipt.mjs | 15957 | 87374ecc9cc769e209c128e062cbc9c248bd9b8f1ac439bf34d1f43b332125d1 |
| focused.receipt.json | 705 | 488a85a914315a7de21604f508b47b1a176fc583bab58fbac9b6be5887f64e49 |
| focused.stderr.log | 2239 | 7d0394b1aed837de5b43c23a0879288a1b1e0e23ce157bf6b3b0158dc284c363 |
| focused.stdout.log | 694 | 6e09dceab9476ce18d496b0f3b39bd1e9dc655bf16392581d1dceff71201efa7 |
| freeze.mjs | 2053 | 5b5257c9627ef809810f0432f4dd8ac26cc147909932c35d506f66f2f1b11386 |
| noEmit.receipt.json | 592 | 337346d3a6f043af3f4d319b5a23f8614ec48b696012fc4f9eefbe8265d7d657 |
| noEmit.stderr.log | 325 | 97766d7525cab816267551752a7a3dbc9431d86371f17f8a9d75a71ecea65c2c |
| noEmit.stdout.log | 325 | 97766d7525cab816267551752a7a3dbc9431d86371f17f8a9d75a71ecea65c2c |
| normalized-after.json | 36614 | 0778718718c00a0d853522f1e8808942a8a447adb20f7a9fd9db83e285cf3b52 |
| normalized-before.json | 36614 | f3924e001482246971b527b23c8c45572b4a955d1f77f2b0892ad0a6f38cf010 |
| protected-manifest.json | 5822 | 06ad7c446af6be81a87253b8b98f3d5b2c6a209dad37d378766e43809e174571 |
| protected-methods.patch | 9233 | 785c96ae4cfefcb9f9c04414e87b8df40a7a4fbdd33cdc1c2d05e89f2f83eac3 |
| protected.patch | 45157 | cf7a1cb046629eb08204fab366b736fac0336032b90fd1ccf1927a0c1ccc7e01 |
| retained-synthetic-files.json | 6508 | 9e98bd057c284138e22fa6ca9fc7ce391502e752de45a9e02135ec2b39a49ed4 |
| run-check.mjs | 2192 | 7b3fd49d3eb6a4e1e64cc02fe5567680f9ba43a56a2544998c25fec6c517b98e |
| static-artifact-attempts.txt | 612 | a1882e3c1cd250dbd240f71d8396426dea36df43d0de432caa71ce29bdc76f53 |

Raw failed assertion / diff (unchanged):

```text
{"kind":"focused","commit":"0f4d4d45025b587604f17c4eac420b3e8b532fd4","tree":"553018b6bb378b51a9948bd36d0e6925da13769f","wrapperPID":33920,"parentPID":78408,"childPID":69248,"start":"2026-10-24T00:09:46.817Z","externalDeadlineMs":60000,"command":"C:\\Program Files\\nodejs\\node.exe node_modules/vitest/vitest.mjs run test/messaging-convergence-slice1.test.ts --maxWorkers=1 --pool=threads --no-file-parallelism --reporter=dot --bail=1"}

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/messaging-convergence-slice1.test.ts > refuses namespace before metadata, snapshots or schema repair
AssertionError: expected [ [ …(2) ], [ …(2) ], [ …(2) ], …(6) ] to deeply equal [ [ …(2) ], [ …(2) ], [ …(2) ], …(4) ]

- Expected
+ Received

@@ -22,9 +22,17 @@
    [
      "E:\\AgentData\\claude-codex-comm\\t3-6416720d\\.agent-bridge-test\\slice1-fixtures\\aa54570b-ac82-404b-b527-a347e171be55\\bridge.db",
      "5fde6b026ca5491b159bebf0a04fb17cbd3d9eba9119b4a2280edc976d9bcdcb",
    ],
    [
+     "E:\\AgentData\\claude-codex-comm\\t3-6416720d\\.agent-bridge-test\\slice1-fixtures\\aa54570b-ac82-404b-b527-a347e171be55\\bridge.db-shm",
+     "fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb",
+   ],
+   [
+     "E:\\AgentData\\claude-codex-comm\\t3-6416720d\\.agent-bridge-test\\slice1-fixtures\\aa54570b-ac82-404b-b527-a347e171be55\\bridge.db-wal",
+     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
+   ],
+   [
      "E:\\AgentData\\claude-codex-comm\\t3-6416720d\\.agent-bridge-test\\slice1-fixtures\\aa54570b-ac82-404b-b527-a347e171be55\\history.db",
      "b3192912862b8c76bf2cc6911869333aeebb849786b6f2e55e3a7bf2bc96e631",
    ],
  ]

 ❯ test/messaging-convergence-slice1.test.ts:147:49
    145|  db.close();const before=tree(path).map(file=>[file,sha(file)]);
    146|  expect(()=>metadataDb(path)).toThrow();expect(()=>new MessageStore(jo…
    147|  expect(tree(path).map(file=>[file,sha(file)])).toEqual(before);
       |                                                 ^
    148| });
    149| it.each([2,3,4,5,6,10,11,12,13,14])('never automatically reinterprets …

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯
```

**Next action:** parent supplies the supported nonmutating inspection decision; implement only that correction in this same checkout, create a new source freeze, then spend the separately approved corrected focused/noEmit allowance once each. Do not integrate into PR141, start later slices, amend pins or claim slice1 ready from this WIP. Parent owns independent review, later forward integration and remaining hosted/native acceptance.

Artifact inventory SHA256: ddb4f1c3dcd1cc1586d93e68fc645b5613582e80c1c09aec6b40dbdad884ba56. The inventory intentionally excludes its own self-referential hash; it lists the exact retained review files before receipt commit/push logs were added. Commit/push logs are retained alongside it and are identified in the final handoff.
