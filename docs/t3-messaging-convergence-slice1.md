> Latest: the inventory diagnostic confirmed only newly created zero-byte WAL/volatile SHM coordination, with main identity/size/hash unchanged. The parent-authorized correction froze at `d4f8e17d0bff563f45b5f495b0f1a9f5b4489ed0`. NoEmit and the anchored seven-case selection passed (42 cases excluded). Slice1 WIP is ready for independent source review, with exact protected patches/baselines unchanged and hosted Node24/platform acceptance pending. Earlier red runs, including the diagnostic, remain red and qualified to their own freezes; no full49-case final-head pass is claimed.

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

## Parent-approved ordinary read-only inspection correction

**The original design hold was resolved, but the corrected selection is RED. No source/test edit or validation retry followed that failure. Slice1 remains WIP, not ready for acceptance.**

- Original source `0f4d4d45025b587604f17c4eac420b3e8b532fd4`, tree `553018b6bb378b51a9948bd36d0e6925da13769f`:19 passed/1 failed/18 unaccepted. Its raw logs, assertion diff and receipt remain unchanged and are not relabelled green.
- Corrected source `eeae258fb01df64b50e1df46054f10bc086061b2`, tree `72d218b9ec9f7230707770c3de44278fb62c99c0`. Only `src/core/mailbox-layout.ts`, `src/core/metadata-db.ts`, `src/core/store.ts` and the same focused test changed from prior WIP87ab4ca8.
- Parent explicitly approved ordinary READONLY SQLite with a coordination allowance. This supersedes the literal zero-filesystem-effects interpretation, not its historical red evidence. No scratch copy, custom VFS, immutable/nolock bypass, new ledger, writable recovery, sidecar cleanup, installed migration or native connector was implemented.
- This appended receipt is a later documentation-only change. Its final commit/tree does not constitute a new source/test pass. Cumulative changed paths remain the31 recorded above.

### Inspection mechanism and test boundary

`inspectMailbox` checks only an explicitly selected main and exact `-wal`/`-shm`/`-journal` family. Existing files must be regular, unlinked and stable by descriptor/path identity; ancestor symlinks refuse. Missing main with retained sidecars, empty/truncated main, invalid format/page-size bounds and linked/substituted inputs refuse before SQLite construction. The fixed100-byte header read is solely a rejection guard, never authority over current schema or WAL.

The `readOnly:true` connection uses the existing default VFS/normal locking and remaining timeout. Version, schema/envelope, component and interrupted-attempt classification share one SQL read transaction. Fresh-state and offline source/resume inspection use the guarded path. Journal presence alone is not rejected; a native read-only recovery failure propagates without writer retry, repair, checkpoint or manual sidecar deletion. Preflight is neither cached-writer revocation nor later serving authority.

Approved quiescent assertions retain every original file and byte except the exact inspected DB-shm volatile coordination. Original main, all original WAL bytes, rollback journal and unrelated files remain checked, as do logical rows/schema/version. Only SQLite-created exact X-wal/X-shm may appear. Newly created WAL must be empty in these quiescent fixtures; small synthetic SHM is at most32768 bytes. This is **not a production/general size cap**. Concurrent-writer fixtures test SQL read-view/order rather than attribute writer bytes by a whole-tree freeze. No unrelated assertion was weakened.

Timeout0 bounds lock waiting, **not synchronous WAL-index work or OS wall-clock preemption**. Existing deadline checks still deny subsequent phases/serving after expiry. No native fstat of SQLite's own handle or stronger publication guarantee is claimed.

Primary-source mechanisms reviewed:

- [Node v24.10.0 open](https://github.com/nodejs/node/blob/v24.10.0/src/node_sqlite.cc#L678-L686) maps readOnly to SQLITE_OPEN_READONLY/default VFS; [Close](https://github.com/nodejs/node/blob/v24.10.0/src/node_sqlite.cc#L1023-L1032) finalizes owned statements/sessions and calls sqlite3_close_v2.
- [SQLite read-only WAL](https://sqlite.org/wal.html#read_only_databases) permits exact WAL/SHM coordination creation with normal locking.
- [WAL file lifecycles](https://sqlite.org/walformat.html#file_lifecycles) distinguish volatile SHM and a normal nonempty read-only last client's lack of final checkpoint/WAL unlink. The first SHM hash unit is32768 bytes; larger WALs may require more units.
- [SQLite3.50.4 pagerOpenWalIfPresent](https://github.com/sqlite/sqlite/blob/version-3.50.4/src/pager.c#L3169-L3187) has a zero-main-page retained-WAL deletion exception; pre-native guards exclude partial inputs.

These source pins are **not proof of the installed or hosted library**. Actual versions were queried inside the already-authorized focused process below. No separate version/probe/helper launch occurred. Exact-build Windows/Linux/macOS behavior, actual hot-journal behavior and source-preservation review remain hosted gates.

### Corrected checks and remaining failure

| Check | Own wrapper/shell/check PID | JST start–end | External limit/result |
| --- | --- | --- | --- |
| noEmit |48936/28632/66808 |2026-10-24 09:27:35.981–09:27:37.290 |60000ms;1309ms elapsed;exit0;no timeout |
| Same focused file with inspection cases |41748/75344/28212 |2026-10-24 09:27:40.712–09:27:44.698 |60000ms;3986ms elapsed;exit1;no timeout |

Both checks observed source `eeae258fb01df64b50e1df46054f10bc086061b2` /tree `72d218b9ec9f7230707770c3de44278fb62c99c0` before and after. Both corrected allowances are consumed. No wrapper/filter retry or further launch budget remains.

Actual query in focused process28212:

```json
{"node":"v26.4.0","pid":28212,"sqlite":"3.53.2","sqliteSourceId":"2026-06-03 19:12:13 d6e03d8c777cfa2d35e3b60d8ec3e0187f3e9f99d8e2ee9cac695fd6fcdf1a24"}
```

Raw first headers (identical in each retained stdout/stderr pair):

```json
{"kind":"noEmit","commit":"eeae258fb01df64b50e1df46054f10bc086061b2","tree":"72d218b9ec9f7230707770c3de44278fb62c99c0","wrapperPID":48936,"parentPID":28632,"childPID":66808,"start":"2026-10-24T00:27:35.981Z","externalDeadlineMs":60000,"command":"C:\\Program Files\\nodejs\\node.exe node_modules/typescript/bin/tsc --noEmit"}
{"kind":"focused","commit":"eeae258fb01df64b50e1df46054f10bc086061b2","tree":"72d218b9ec9f7230707770c3de44278fb62c99c0","wrapperPID":41748,"parentPID":75344,"childPID":28212,"start":"2026-10-24T00:27:40.712Z","externalDeadlineMs":60000,"command":"C:\\Program Files\\nodejs\\node.exe node_modules/vitest/vitest.mjs run test/messaging-convergence-slice1.test.ts --maxWorkers=1 --pool=threads --no-file-parallelism --reporter=dot --bail=1"}
```

Vitest5.0.2: **37 passed/1 failed/46 total; remaining8 unaccepted**. Raw failure:

```text
FAIL test/messaging-convergence-slice1.test.ts > does not reject a rollback journal solely because it exists
Error: attempt to write a readonly database
  at test/messaging-convergence-slice1.test.ts:217:67
  at Module.inspectMailbox src/core/mailbox-layout.ts:66:18
```

The fixture writes literal `synthetic nonhot original` to its journal and expects a read. The guard admits the regular journal to normal READONLY SQLite; PRAGMA user_version throws. The inspector propagates refusal without writable retry. The fixture's **nonhot assumption is unproved**; the raw reporter supplies no extended error code, so this is not specifically certified as SQLITE_READONLY_ROLLBACK or a real hot-journal schedule. The separate mocked rollback case did not run. No assertion/fixture was changed after failure.

Retained journal: `.agent-bridge-test/slice1-fixtures/b2d8b8a8-c7fd-4322-bcad-9c378a886efe/bridge.db-journal`,25 bytes,SHA256 `c1f7df91d40a823d391c20bdcfa2f3378dbe74a5b20f59d4aa5a72131cfcff66`. Call graph: test217 -> inspectMailbox callback at mailbox-layout66 -> first PRAGMA user_version read. Native read-only open returned and BEGIN ran; the expected positive assertion failed.

Remaining8: mocked rollback propagation, committed-WAL visibility/bytes, concurrent consistent-view classification, finite m1/s9 migration, both interruption schedules, candidate-ready CAS and late mocked recovery. These are **NOT RUN/unaccepted**. Earlier guards/refusal cases and noEmit do not establish these behaviors; the aggregate result remains RED.

### Protected manifest and retained artifacts

Inspection changed **zero of13 protected normalized bodies relative to0f4d4d45**. Cumulative main-to-candidate five proposed deltas/eight unchanged bodies retain the exact hashes above. UI/dashboard source, baseline bytes, normalizers and retention guard remain unchanged. No pin amendment or protected-test run occurred.

- Normalizer SHA256: `93ca63b8638622cc790c0d776b544af0840133e4c144ce792836e718a93b664a`.
- Corrected-directory normalized JSON patch SHA256: `5c2b4be8c4ccf3811e32673d7adfe23286d1a868d5b489b8bcf4c3207ffb98d1`.
- Readable cumulative method patch SHA256: `ffb5efda7a9168e366dfa56f4f5737b530476420a81877d5e35ae9f3c7121b1e`; directory headers differ from the earlier artifact, normalized bodies do not.
- Protected-manifest SHA256: `2713b6127ca809af80d7dade24c5325077c9434e51eac8501e931e88d995f5fd`.
- Focused stdout/stderr SHA256: `1ce585dbefdd4d355fdb1f820974531d73da0d25e51e2a0c8e6992f508b44282` / `095d44928656a1befc15fda1c9054c9c1acdeecd78f6c9029f05f85d52d51ec6`.
- noEmit stdout/stderr each SHA256: `bc733dce51cc17053f39ef16547cd3085facc145ad968188ee81e66d140508b5`.

Corrected raw logs, runtime record, process receipts, full source correction patch, normalized before/after bodies and cumulative pin manifest remain in `E:/AgentData/claude-codex-comm/t3-6416720d/.agent-bridge-test/slice1-corrected-review`. Old slice1-review files remain untouched. Combined retained synthetic inventory:180 files; no synthetic originals were manually deleted or repaired.

Settled artifact index `artifact-files.json` SHA256: `8e3aba87d6de0ab01077dd8a445d60f6f9deb4dd019254cee9a817d9ffa621a1`. It excludes itself and later commit/push logs. Initial index captured while stdout was open remains separately as `artifact-files.pre-close.json`, historical rather than settled. A complete final inventory is retained after push.

Static utility PID27388/shell1620,09:31:28.687–09:31:29.083 JST,external10s,exit0. An earlier combined long-shell artifact command was rejected before launch by automatic tool approval (`blocked by policy`); no process/test ran. Structured file creation plus a separate bounded static utility completed artifact work without changing check results.

**Next parent decision:** classify/replace the journal fixture using supported SQLite behavior while preserving fail-closed READONLY recovery and original-data assertions. No further correction/launch authorization remains. Candidate is not slice1-review-ready, integrated, installed or released; no later-slice/native-connector work began.

## Test-only journal correction: one anchored run, migration failure

Parent subsequently approved **only the nonhot test fixture correction**, the optional ambiguous-literal negative and one external60s anchored selection. Production, SQLite options, preservation assertions, versions and scope remained unchanged. This section supersedes the previous next-decision paragraph; it does not relabel either earlier red run.

Test/source freeze: `0b1f3dc080417e4f19e9bde202252c05ffd83865`, tree `6fb1512112652f46e2c5a28e259b7d8d87c7f103`. The test file SHA256 is `a0b5d3e27a3625adca418f54b7ff504a1ffbc543b739adf43b7b085a1c468abb`. Tracked files were clean; commit/tree/test hash matched before and after the run. A later receipt-only commit is an artifact and does not gain a separate check result.

Production directory tree is `5a6d53ca2898bd4757f67759aa9d1c9aeed22c66` at both `eeae258f:src` and the test freeze's `src`. `git diff eeae258f HEAD -- src` is empty. Since the preceding receipt `9e934b1cd75cae59bcd5054b44cb7cf4256fc236`, the freeze changes only `test/messaging-convergence-slice1.test.ts` (16 insertions/1 deletion). No history/import implementation, inspector or production method changed in this correction.

### Exact fixture contract

The positive now writes `Buffer.alloc(1024)` as the journal and asserts that its first28 bytes equal `Buffer.alloc(28)` before opening SQLite. Its expected `user_version=7` and original-file preservation assertion remain unchanged. [SQLite locking protocol](https://sqlite.org/lockingv3.html) documents zeroing a PERSIST journal header as a commit/nonhot state. This fixture supplies that state deterministically without an external helper or writable recovery.

The additional negative retains the exact original25 bytes `synthetic nonhot original`, SHA256 `c1f7df91d40a823d391c20bdcfa2f3378dbe74a5b20f59d4aa5a72131cfcff66`, and checks ordinary read-only refusal plus unchanged original files. Those arbitrary nonzero bytes do **not** prove an actual hot journal or any specific extended SQLite error code. The earlier eeae journal and its red logs remain untouched. The separate mocked `READONLY_ROLLBACK` case is unchanged and passed here. No original was repaired, checkpointed or manually deleted.

Exact test-only patch: `.agent-bridge-test/slice1-journal-fixture-review/fixture-only.patch`, SHA256 `b2d74639eed15ac81cd5c07ff0857022f511d44fbba1c977c17560ed5ce2245e`. Production read-only refusal was not weakened.

### Exact selected cases and qualified results

Names were derived from the actual file and joined as an anchored `^(?:name1|...|name10)$` expression; the literal full pattern and argv are retained in `selection.json`, both raw first headers and `focused.receipt.json`. Only this selection was launched, with `--maxWorkers=1 --pool=threads --no-file-parallelism --reporter=dot --bail=1`.

| Exact test name | Result on this freeze |
| --- | --- |
| does not reject a rollback journal solely because it exists | PASS |
| retains arbitrary nonzero journal as ambiguous readonly refusal | PASS |
| propagates mocked READONLY_ROLLBACK without repair, checkpoint or writable retry | PASS |
| reads committed WAL evidence and retains all original WAL bytes on quiescent refusal | PASS |
| classifies one SQL read view while another synthetic connection commits a component change | PASS |
| provides a read-only exact-home plan and a finite m1/s9 isolated migration | FAIL |
| resumes one immutable interrupted attempt after snapshot, retaining all originals | NOT RUN/unaccepted |
| resumes one immutable interrupted attempt after committed-ddl, retaining all originals | NOT RUN/unaccepted |
| holds candidate-ready CAS failure even with complete tables and a metadata fence row | NOT RUN/unaccepted |
| keeps a late mocked recovery from activating or starting a subsequent phase | NOT RUN/unaccepted |

Vitest5.0.2 raw result: **1 failed /5 passed /37 skipped (47 total)**. The prior37 passes were excluded and are qualified only by their earlier eeae run; there is no final-head46/47-pass claim. `focused.receipt.json` has an unmodified `passedCount:null` because its parser did not recognize the failure-first summary; the raw summary above is authoritative. `coverageAccepted:false` is correct.

Raw failure:

```text
FAIL provides a read-only exact-home plan and a finite m1/s9 isolated migration
TypeError: Provided value cannot be bound to SQLite parameter 1.
  at importMigrationSnapshot src/core/metadata-db.ts:613:46
  at Module.migrateMessagingHome src/core/metadata-db.ts:734:4
  at test/messaging-convergence-slice1.test.ts:277:2
```

Call graph: selected synthetic shipping migration test -> `migrateMessagingHome` -> `importMigrationSnapshot` -> `insert.run(...all.map(column=>row[column]!))`. This receipt reports the observed binding failure; it does not infer which row/value caused it. No extra SQLite probe or importer correction followed failure. The finite migration, interruption/CAS and late-recovery acceptance remains incomplete.

### Process, version and allowance receipt

| Operation | Own PID(s) | UTC start–end | Deadline/exit |
| --- | --- | --- | --- |
| Static name derivation |18888; shell6408 |2026-10-24 00:40:18.180–00:40:18.298 |10000ms;exit0 |
| Test-only freeze commit |34788; shell11608 |2026-10-24 00:40:29.251–00:40:29.426 |60000ms;exit0 |
| Anchored focused run |wrapper22984; shell42884; Vitest16024 |2026-10-24 00:40:33.147–00:40:35.352 |60000ms;2205ms elapsed;exit1;no timeout |

Raw first headers are retained verbatim as line1 of both focused logs, including source/tree, production pin, test hash, all PIDs, UTC start,60000ms external limit, full argv/pattern and selected literal names. No automatic wrapper retry or other validation launch occurred. **The single remaining run allowance is exhausted.** All owned validation processes exited; no foreign process was stopped.

Version query occurred inside that already-authorized Vitest process only:

```json
{"node":"v26.4.0","pid":16024,"sqlite":"3.53.2","sqliteSourceId":"2026-06-03 19:12:13 d6e03d8c777cfa2d35e3b60d8ec3e0187f3e9f99d8e2ee9cac695fd6fcdf1a24"}
```

This is actual Node26 evidence, **not Node24 acceptance**. No installation, PATH change or separate version/native launch occurred. Hosted Node24 and exact-platform source-preservation gates remain mandatory and NOT RUN.

NoEmit for this fixture correction: **NOT RUN as instructed**. The earlier noEmit on unchanged eeae production passed; this does not claim a new final-tree typing run. No new type change was introduced by the fixture correction. No production worker, provider, daemon, helper, TLS, build, full suite, release, installed migration or owner-home activity occurred.

### Unchanged protected deltas and retained evidence

All13 normalized protected bodies are unchanged by this fixture correction because the complete `src` tree is identical to eeae. The cumulative original five changed/eight unchanged bodies still await the parent's exact patch review. The previous exact manifest, normalized before/after JSON and readable patch were copied byte-for-byte into the new artifact directory; originals were not overwritten. No pin/baseline amendment or protected-test run occurred.

- Protected manifest SHA256: `2713b6127ca809af80d7dade24c5325077c9434e51eac8501e931e88d995f5fd`.
- Normalized JSON patch SHA256: `5c2b4be8c4ccf3811e32673d7adfe23286d1a868d5b489b8bcf4c3207ffb98d1`.
- Readable method patch SHA256: `ffb5efda7a9168e366dfa56f4f5737b530476420a81877d5e35ae9f3c7121b1e`.
- Baseline, UI, retention guard and extracted normalizer hashes were reread as static bytes and equal the preceding manifest. Exact proofs are in `preservation-manifest.json`; the raw normalizer and assertions were not edited or executed.
- Focused stdout/stderr SHA256: `694de517ee54fd4bec8aef685fd70abd402f78d7be14e5f342350e3579ae233c` / `1102dc0223cd6f5b86c538c901d6013127fa6113c457ef3a05f7ad8640fbac02`.
- Settled pre-receipt artifact index `artifact-files.json` SHA256: `6c959b559b6a322b83a680b27cb83a13d741a6043785fb74e8e9cd264ba6de19`. It excludes itself, the later static packaging receipt and subsequent Git/push/final inventory files.

New artifact directory: `E:/AgentData/claude-codex-comm/t3-6416720d/.agent-bridge-test/slice1-journal-fixture-review`. Earlier `slice1-review`, `slice1-corrected-review` and all synthetic originals/snapshots remain retained. A new final inventory is written after the explicit WIP push and reported in the handoff; older inventories stay untouched. Packaging used static source/file/hash operations only, PID9316,external10000ms,exit0; its precise UTC times are in `artifact-pack.receipt.json`.

**Parent decision required:** the authorized test fixture boundary now passes, but slice1 cannot be handed off as ready for independent source review while shipping migration fails. A separately scoped production importer correction and explicit verification allowance are needed before further implementation/checks. This WIP preserves the failed source freeze and all evidence; no additional correction, retry, integration or PR was made.

## Narrow importer binding correction: confirmed cause, new pre-import refusal

Parent authorized a correction **only inside `importMigrationSnapshot`'s projection/binding**, one small synthetic fidelity regression, metadata-only diagnosis in the existing focused process, one noEmit and one external60s focused selection. This section supersedes the preceding next-decision paragraph without changing its historical evidence.

Continuation starts at pushed artifact head `7566bec952c9b18526c506677b03ed43ff143f75`, tree `00f460bf7f8f41aeeb077d918e89e133b58a6023`. Original main remains `5e3fa8aa17d22d57cb5d24549c16381c5843edeb`. New source/test freeze is `e185e18550774802a0304eed56315a294ba80bff`, tree `33712923dc186e858f1d836f8dadc274097faba4`; its `src` directory tree is `521361624c07ea0b04702ca495bf295040e14341`. Only `src/core/metadata-db.ts` and `test/messaging-convergence-slice1.test.ts` changed in that freeze (45 insertions/2 deletions); the later receipt commit is artifact-only.

### Confirmed table/key and exact source change

The shipping fixture's first legacy missing projection key was confirmed **inside the authorized focused run**, bounded to32 fixture projections and one metadata record. No row values or independent probe were logged:

```json
{"table":"decisions","requestedKey":"rowid","returnedKeys":["revision","id","topic","body","scope","author_id","author_name","author_agent","created_at","source_message_id","supersedes"]}
```

The table declares `revision INTEGER PRIMARY KEY AUTOINCREMENT` (`src/core/decisions.ts:57`). The test reconstructs the old projection on the immutable synthetic snapshot, confirms the returned object lacks the requested key and records only table/column metadata. No production diagnostic hook was added. [Node24.10 statement metadata and object results](https://nodejs.org/download/release/v24.10.0/docs/api/sqlite.html#statementcolumns) document the APIs used; actual behavior above belongs to the observed Node26 build, not hosted Node24 acceptance.

The importer now assigns every result expression a unique explicit `__migration_column_<position>` alias and binds values by those result keys. Every projection is aliased, so an actual source column named `__migration_column_0` cannot collide with an unaliased field. Destination column names/order, implicit-rowid selection, `setReadBigInts(true)` and the direct value bindings remain intact. There is no undefined-to-NULL conversion, dropped field, BLOB conversion or skipped table.

Schema construction, source opening/closing, BEGIN/ROLLBACK/COMMIT boundaries, phase callback, sqlite_sequence handling and unknown-COMMIT policy are unchanged. This correction introduces no importer framework, version/dependency change, inspector/admission adjustment or scope expansion.

Exact production-only patch SHA256: `caa42a6f6ddb36c6fca698c6a324013b2b7461ef21a693f21321161bf366fa50`; full source/test patch SHA256: `14b5d4929a750a69343f9476a92b56b831471d25fd1094b29c82d35a1690b285`. Both are retained in `.agent-bridge-test/slice1-binding-review` as `production-only.patch` and `source-test.patch`.

### Focused selection and stopped result

The anchored names were derived from actual literal test names and the existing `it.each(['snapshot','committed-ddl'])` template. Exact full pattern/argv are retained in `selection.json`, both raw first headers and `focused.receipt.json`. Forty-two prior cases, including journal/guard checks, were excluded.

| Exact selected test | Result on e185e185 |
| --- | --- |
| provides a read-only exact-home plan and a finite m1/s9 isolated migration | PASS; includes projection diagnosis |
| preserves INTEGER PRIMARY KEY aliases, shadowed rowids and WITHOUT ROWID value fidelity | FAIL before import |
| resumes one immutable interrupted attempt after snapshot, retaining all originals | NOT RUN/unaccepted |
| resumes one immutable interrupted attempt after committed-ddl, retaining all originals | NOT RUN/unaccepted |
| holds candidate-ready CAS failure even with complete tables and a metadata fence row | NOT RUN/unaccepted |
| keeps a late mocked recovery from activating or starting a subsequent phase | NOT RUN/unaccepted |

Raw Vitest5.0.2 summary: **1 failed /1 passed /42 skipped (48 registered)**. The small regression creates three ordinary synthetic tables: INTEGER PRIMARY KEY plus a real alias-like column, a real `rowid` column with separately assigned implicit rowid, and a composite-primary-key WITHOUT ROWID table. It asserts explicit expected large positive/negative integers, BLOB bytes and NULLs before migration, then is intended to compare destination rows/schema and retained source bytes. Its source expectations passed, but destination fidelity was **not reached or accepted** because migration refused first.

```text
FAIL preserves INTEGER PRIMARY KEY aliases, shadowed rowids and WITHOUT ROWID value fidelity
Error: Source changed after planning; all originals and interrupted destination retained
  at migrationRefusal src/core/metadata-db.ts:532:61
  at Module.migrateMessagingHome src/core/metadata-db.ts:668:116
  at test/messaging-convergence-slice1.test.ts:318:2
```

Call graph: new regression -> `migrateMessagingHome` -> locked-source inventory comparison, **before destination construction/import**. That regression calls apply directly; the passing shipping case first invokes the read-only plan. The current log does not capture the inventory delta, so it does not prove whether the differing record is a coordination sidecar, identity change or another effect. No guard was weakened, new cause inferred as fact, production expansion made or extra probe launched. Diagnosis of this separate pre-import refusal requires the parent's decision.

### Exact frozen-process receipts

| Operation | Own wrapper/shell/check PID | JST start–end | External limit/result |
| --- | --- | --- | --- |
| Source commit |Git11836/shell22880 |2026-10-24 09:50:42.413–09:50:42.563 |60000ms;exit0 |
| noEmit |50252/48636/45280 |2026-10-24 09:50:48.916–09:50:50.207 |60000ms;1291ms elapsed;exit0;no timeout |
| Anchored six-case selection |26852/8028/4956 |2026-10-24 09:50:54.960–09:50:56.992 |60000ms;2032ms elapsed;exit1;no timeout |

Both checks observed the same source commit/tree and test SHA256 `f910604125d34f319e9851a32563eabc70426b29a9c1d254d841b4ce0ec4ed3c` before and after. Raw line1 of each stdout/stderr file names the exact freeze, test hash, all PIDs, UTC start,60000ms deadline, wrapper Node version and argv; focused headers also retain the exact six names. All owned check processes exited; no timeout cleanup or foreign-process termination occurred.

Actual version query in the already-authorized focused process only:

```json
{"node":"v26.4.0","pid":4956,"sqlite":"3.53.2","sqliteSourceId":"2026-06-03 19:12:13 d6e03d8c777cfa2d35e3b60d8ec3e0187f3e9f99d8e2ee9cac695fd6fcdf1a24"}
```

NoEmit **PASS** on this source freeze. Focused selection **RED**; both new allowances are consumed. No automatic retry, second initialization, post-failure source/test change, native worker/helper/provider/daemon/TLS/full suite/build/install/live-home migration or version/PATH change occurred. Hosted Node24/platform verification remains **NOT RUN**. The original19/1,37/1 and5/1 red runs remain unchanged and separately qualified; no combined final-head pass count is claimed.

### Protected patch and artifacts

The binding correction changes zero protected methods. Complete broker.ts/node.ts/dashboard.ts Git blobs match the previous head, establishing that all13 normalized bodies and their exact cumulative main-to-candidate patch remain identical. `preservation-manifest.json` records those blob proofs, fresh baseline/UI/retention/normalizer byte hashes and copied artifact hashes. Baselines are untouched; the original five proposed protected-method deltas still require parent review before any separate pin amendment.

- Protected manifest: `2713b6127ca809af80d7dade24c5325077c9434e51eac8501e931e88d995f5fd`.
- Normalized JSON patch: `5c2b4be8c4ccf3811e32673d7adfe23286d1a868d5b489b8bcf4c3207ffb98d1`.
- Readable cumulative method patch: `ffb5efda7a9168e366dfa56f4f5737b530476420a81877d5e35ae9f3c7121b1e`.
- Focused stdout/stderr: `e5abe10797679e41d32a91473396c1ccda1e0df15683fd3152943abea541d160` / `4869d82e9e443f171dce80237799ed28c6ada9ffd57c0ec18100baa2f51c1ff4`.
- Settled pre-receipt artifact index: `914159c87d533fe5aba52216f63c66a6cc129e40e359efc3fe2ac85d8427232d`; excludes itself and later packaging/Git/final-inventory artifacts.

New artifact root: `E:/AgentData/claude-codex-comm/t3-6416720d/.agent-bridge-test/slice1-binding-review`. Static packaging PID22256,09:51:58.150–09:51:59.105 JST,external10000ms,exit0. All previous artifact roots and synthetic originals/snapshots remain retained. Final commit/push PIDs/times/exits and a new complete retained-file inventory are recorded after this receipt's artifact-only commit.

**Parent decision needed:** authorize a narrowly scoped diagnosis of the pre-import inventory drift, or hold the candidate at this preserved WIP. The confirmed binding correction and shipping pass are available for independent inspection, but fidelity/interruption/CAS/late-recovery acceptance remains incomplete; there is no slice1-review-ready, merge, PR, installed migration or release claim. PR141 and its original writer remain untouched.

## Confirmed empty-WAL coordination correction and slice1 source handoff

Parent authorized static inventory tracing, one bounded synthetic diagnostic if needed, then a correction **conditional on confirmed owned coordination**, one focused selection and one noEmit. The previous paragraph's inventory decision is now resolved within that authorization. The diagnostic failure remains historical RED evidence; it is not counted as an accepted test.

Continuation head: `7456c17e711831a7e9c971d4acab54984b2d0a6e`, tree `9750c6e97d70d4a5f56b1f5b79b52b8fbe4baca9`. Original base remains `5e3fa8aa17d22d57cb5d24549c16381c5843edeb`, tree `099261e3f7c378f38bf2ecb2dcf4ca4479d9fabf`. Same assigned checkout/branch is retained for later slices. Reviewed design and attributed copies above are unchanged.

### Static trace, diagnostic freeze and exact difference

Before correction, `migrateMessagingHome` captured inventory/inputId at645–646, performed ordinary read-only preflight/inspection at648–655 and compared a new inventory under maintenance exclusion at668. Inventory ignores exact SHM, but previously included every exact WAL as a durable input. Each input records `path`, `role`, `identity=dev:ino:size:mtimeNs:ctimeNs`, `bytes` and `sha256`; unknown names remain separately retained. Static tracing explained the possible discrepancy but lacked the old runtime census, so it could not establish the actual differing record.

Diagnostic test-only freeze: `79be5784672e229421803362314d7da8a20d07d6`, tree `a452617e8e2aff4337b1aa2c184b9d90900835e5`, test SHA256 `abe67a48f9b9ffc269141a774458478faf6c8fd6749a3a5b49fbcdad3a79245f`. Production was unchanged. The only selected case was `preserves INTEGER PRIMARY KEY aliases, shadowed rowids and WITHOUT ROWID value fidelity`. A temporary test-only flag recorded known synthetic file names, roles, size, identity and hashes, then rethrew the original failure. No row/payload/config/secret values or separate SQLite probe were logged.

Observed before/after:

| Exact path | Before | After | Inventory effect before correction |
| --- | --- | --- | --- |
| bridge.db |sqlite;323584 bytes |same identity, size and SHA256 |unchanged durable record |
| bridge.db-wal |absent |wal;0 bytes;empty-file SHA256 |new durable input record |
| bridge.db-shm |absent |excluded-coordination;32768 bytes |already excluded |

Main identity in both censuses: `3901952415:5066549592081503:323584:1792803437569863100:1792803437569863100`; main SHA256 `62450def3b4c523e51cef7469451d3b2b9a405b62ffd58e875d4365028ad37b1`. New WAL identity: `3901952415:5629499545502817:0:1792803437578363000:1792803437578363000`; SHA256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. No other entry changed. SHM's32768-byte observation belongs only to this small fixture, not a production cap.

The before/after census plus static role mapping confirms the failure: old inventory changed from one durable record to two despite identical original durable bytes. The new empty WAL was created during the owned ordinary read-only path. Exact reconstructed inventory shapes, all observed identity/hash fields and the corrected equal durable census are retained in `inventory-difference.json`, SHA256 `d9fa845740b94bdf6f781af474c7a3e51038d97e1e4c6d34a95f0a822a9b923c`. The immutable inputId was not refreshed/replaced; this artifact does not compute a replacement identity for changed source data.

Diagnostic raw result: **1 failed /47 skipped (48)**, same source-inventory refusal, external30s,exit1/no timeout. It remains RED. The temporary diagnostic test block was removed by the subsequent ordinary correction commit; the frozen code/logs remain in history/artifacts.

### Selected correction and retained refusal boundary

Chosen option: **classify only an exact, validated zero-byte WAL as coordination**. `messagingMigrationInventory` still passes every known WAL through `migrationInput`'s regular/unlinked/path checks, stable descriptor/path identity and complete hash read. Only afterward, `.filter(input=>input.role!=='wal' || input.bytes!==0)` excludes empty WAL coordination from the immutable durable-input list. No file is removed, truncated, repaired, checkpointed or copied by this classification.

All fields remain exact for every nonempty WAL and every other durable input. Empty-to-nonempty WAL growth adds a durable record and refuses; a previously nonempty WAL changing or disappearing changes the exact comparison and refuses. Database/body/schema and other inventoried evidence still receive the original identity/size/hash checks. SHM exclusion is unchanged. Unknown journal/name handling is unchanged; they are not classified as empty WAL or inferred to be fresh data. Missing-main/retained-sidecar and read-only recovery guards remain in the existing preflight.

Inventory capture/inputId ordering and the under-lock change guard remain unchanged (now650–651 and673). There is no changed-inputId refresh, relaxed durable hash, snapshot of accepted changed input, immutable/custom VFS, scratch copy, new ledger/subsystem, version/dependency change or broader admission change. Reader/endpoint exclusion, operator attestation, owned cleanup, transaction/rollback/unknown-COMMIT and WAL/FULL authority policies remain unchanged.

Corrected source/test freeze: `d4f8e17d0bff563f45b5f495b0f1a9f5b4489ed0`, tree `cfb03f4cbdecfaa0f03908679c1961fca1b8b381`; `src` directory tree `fc8031127deb1117417ce2522055b8de64fec4a3`; test SHA256 `1c1e904bad2150302390b21492ee54f7aa558d3874c89c31e70693c03983bda5`. Relative to7456c17e, only metadata-db.ts and the focused test changed (25 insertions/1 deletion); the later receipt commit is artifact-only.

Exact production-only patch SHA256 `6d0680220accb6c5325c2b6c600aba46a47dd4c2d66485069b1c8681e1699232`; full source/test patch SHA256 `e0b4a23a399500ec98e0e2690e64f1a0b04a9f1347a9401b1f37cb7869fdd2c4`. Both are in `.agent-bridge-test/slice1-inventory-review`.

### Corrected selection and qualified pass

The source file's literal names and existing parameterized interruption template supply the exact anchored pattern in `selection.json` and raw first headers. The shipping positive joins because this inventory contract directly changes immutable shipping inputId and plan/apply behavior; this written reason is also retained in selection metadata. Previous guard/journal passes were excluded.

| Exact selected test | Result on d4f8e17d |
| --- | --- |
| provides a read-only exact-home plan and a finite m1/s9 isolated migration | PASS |
| preserves INTEGER PRIMARY KEY aliases, shadowed rowids and WITHOUT ROWID value fidelity | PASS |
| refuses a real committed WAL change after planning and retains its durable input identity | PASS |
| resumes one immutable interrupted attempt after snapshot, retaining all originals | PASS |
| resumes one immutable interrupted attempt after committed-ddl, retaining all originals | PASS |
| holds candidate-ready CAS failure even with complete tables and a metadata fence row | PASS |
| keeps a late mocked recovery from activating or starting a subsequent phase | PASS |

Raw Vitest5.0.2 result: **7 passed /42 skipped (49 registered)**. Fidelity now reaches destination row/schema comparisons for INTEGER PRIMARY KEY, real alias-like column, shadowed rowid, WITHOUT ROWID, large signed integers, BLOB bytes and NULL, while preserving source bytes. The new negative first verifies the exact nonempty WAL's role/size/identity/hash in a plan, then commits another synthetic record through an in-process connection after planning. It verifies source-change refusal before destination effects, unchanged main hash and retention of the original WAL prefix. The new durable change is never re-planned or imported.

Both interruption schedules retain one immutable attempt/input identity and originals through resume; unknown COMMIT does not receive external retry. CAS failure still prevents admission despite complete tables/fence row. Late mocked recovery cannot activate or start a subsequent phase. These are focused source/test results, not installed migration or native platform acceptance.

### Exact process/version receipts

| Operation | Own wrapper/shell/check PID | JST start–end | External limit/result |
| --- | --- | --- | --- |
| Diagnostic freeze commit |Git67016/shell67024 |2026-10-24 09:57:06.808–09:57:06.957 |60000ms;exit0 |
| Red diagnostic |29768/21660/77220 |2026-10-24 09:57:15.481–09:57:17.644 |30000ms;2163ms elapsed;exit1;no timeout |
| Corrected source commit |Git23952/shell66556 |2026-10-24 09:58:42.111–09:58:42.289 |60000ms;exit0 |
| noEmit |49620/19144/43384 |2026-10-24 09:59:03.222–09:59:04.521 |60000ms;1299ms elapsed;exit0;no timeout |
| Anchored seven-case selection |21892/54740/60648 |2026-10-24 09:59:11.442–09:59:14.374 |60000ms;2932ms elapsed;exit0;no timeout |

All check receipts observed their exact commit/tree before and after, including final test hashes for the corrected checks. Each stdout/stderr line1 retains the source freeze, PIDs, UTC start/deadline and exact argv; selected names/pattern are retained without reconstructing a broader command. All owned check processes exited. No retries or other verification launches occurred; diagnostic30s, focused60s and noEmit60s allowances are consumed.

Actual versions inside diagnostic77220 and corrected focused60648 were Node `v26.4.0`, SQLite `3.53.2`, source ID `2026-06-03 19:12:13 d6e03d8c777cfa2d35e3b60d8ec3e0187f3e9f99d8e2ee9cac695fd6fcdf1a24`. No separate version/native helper launch, installation or PATH change occurred. **Hosted Node24/exact-platform validation remains mandatory and NOT RUN.**

NoEmit **PASS** and seven focused cases **PASS** belong only to d4f8e17d. Earlier37 guard and5 journal/inspection results remain qualified to their original freezes, with the earlier shipping pass separately recorded; no49-case final-head or whole-suite pass is claimed. Original19/1,37/1,5/1,1/1 and diagnostic red histories remain intact.

### Independent source review packet and remaining gates

This correction changes zero protected normalized methods. Full broker.ts/node.ts/dashboard.ts blobs match7456c17e; copied exact13-method before/after JSON, cumulative patch and manifest are unchanged. Baseline/UI/normalizer/retention raw hashes were reread and match. Original five proposed protected deltas/eight unchanged bodies remain for parent review before any separate pin amendment; baseline and pin tests were not changed or run.

- Protected manifest SHA256 `2713b6127ca809af80d7dade24c5325077c9434e51eac8501e931e88d995f5fd`.
- Normalized JSON patch SHA256 `5c2b4be8c4ccf3811e32673d7adfe23286d1a868d5b489b8bcf4c3207ffb98d1`.
- Readable protected patch SHA256 `ffb5efda7a9168e366dfa56f4f5737b530476420a81877d5e35ae9f3c7121b1e`.
- Corrected focused stdout/stderr SHA256 `f8c044cbaedcb0fd2c452e5d0d63a0f2b9c971b9900b6f4212762d5f0ac223d2` / `893986eebdb7e446a2bc662cfc6e4eacd7d4f7d3265a0ea858a8348c293b714d`.
- Pre-receipt artifact index SHA256 `73cf86f2ecccce8630623b66e8b4fd65034d7fa21342742752af60bdeeed5f65`; excludes itself and later packaging/Git/final-inventory artifacts.

Artifact root: `E:/AgentData/claude-codex-comm/t3-6416720d/.agent-bridge-test/slice1-inventory-review`; static packaging PID32836,10:00:31.369–10:00:32.420 JST,external10000ms,exit0. Previous artifact roots, raw first headers/logs, original data and interrupted snapshots remain untouched. New final retained-file inventory and explicit WIP commit/push receipts follow the artifact-only receipt commit and are reported in the parent handoff.

**Slice1 source candidate is ready for independent review.** No new unresolved fork was introduced by this confirmed conditional correction. Parent review of the full design/source and exact protected deltas, subsequent slices and hosted Node24/Windows/Linux/macOS gates remain separate. There is no new PR, integration, release, installed migration, native connector enablement or whole-product completion claim. PR141/c94 history and the original writer checkout remain untouched. Keep this same worktree/branch for later slices.
