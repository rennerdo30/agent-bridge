# Broker performance with many agents

Tracked in Pair Desk **AB-121**; duplicate completion delivery is **AB-117**.
Measured on Windows, Node 26.4.0, on 2026-10-07. Branch: `agent-bridge/cb251588`.

## Owner evidence (read-only)

The owner's files were inspected, never modified, repaired, pruned or truncated:

| Evidence | Snapshot |
| --- | ---: |
| `bridge.db` | 354,811,904 bytes |
| WAL | 6,270,672 bytes |
| `jobs.json` | 875,347 bytes |
| Run tree files (logs and metadata, including archives) | 762 / 34,246,094 bytes |
| Archived run files | 586 / 27,075,900 bytes |
| Job archive snapshots | 164 / 348,346 bytes |
| Main log / rotated log | 5,070,142 / 5,243,166 bytes |

SQLite was already in WAL mode, schema version 6. A read-only query initially found
15,192 message rows with 10,860,518 body bytes. The rest of the database includes
derived search data and allocated pages; database size alone is not an OOM diagnosis.
The recent-message query scans the message-id index and uses a temporary sort.

The broker log contained repeated jobs-store lock timeouts, send/ack timeouts,
ack retries after reconnect, and re-election failures. Retained election entries
included 22:09:49 and 22:10:10 on October 6 and 06:06:14 on October 7 (UTC).
The last broker PID was still alive during inspection, with approximately 1.2 GiB
working set. No uncaught-exception or OOM stack was found in the retained logs.
This proves periods of unavailability and churn, but does not identify every
reported process exit. A live process can appear dead while its event loop is blocked.

## Reproduce the load

`scripts/performance.ts` is an opt-in harness outside Vitest's test discovery. It
creates a fresh synthetic home, short socket path (under 104 bytes on macOS), its
own database and credentials, and empty CLI transcript roots. No links to source
or owner caches are used. Its cleanup removes only its own freshly created fixture.
Windows key ACL setup happens before profiling; established pairing is measured.

From the isolated checkout:

```powershell
New-Item -ItemType Directory -Force .agent-bridge-test | Out-Null
npx esbuild scripts/performance.ts --bundle --platform=node --format=esm --outfile=.agent-bridge-test/performance.mjs
node .agent-bridge-test/performance.mjs
```

The default load window is 20 seconds; `AB_PERF_SECONDS` changes it. The harness
has 36 persistent peers (30 sibling runners and six sessions), 30 additional fake
runner progress sources owned by six job managers, sibling sends every two
seconds per runner, six fresh authenticated hook pollers every second, dashboard
`/api/state` polling every two seconds, and an authenticated TLS paired link with
verification traffic. Historical data consists of 680 run logs, 164 job archives,
400 stored jobs and 8,000 retained messages. Progress polling exercises the actual
job manager's read/merge/write path. A separate worker releases a held store lock
to measure whether contention blocks a 20 ms heartbeat.

Outputs include inspector CPU samples, `process.cpuUsage`, synchronous filesystem
counts/bytes/time, operation mean/p95/max latency, failures and
`monitorEventLoopDelay` p95/p99/max. Startup/seeding is excluded. Five cold/warm
run-summary reads precede concurrent traffic and are included in the profile.

For the before measurement, the identical harness was bundled against source
from `3ec8f4bede545f5bf920fd982e40b6b89c00550e`, captured in an ignored directory
inside this worktree. Dependencies resolve from this worktree's own installation.
Use that revision in a separate isolated checkout when reproducing the baseline.
On this machine E: is a subst of D:; do not mistake them for independent checkouts.

## Measurements

Final progress-writing workload, same harness and synthetic corpus:

| Metric | Before | Candidate |
| --- | ---: | ---: |
| Operation failures | 37 | **0** |
| CPU time | 17,828 ms | 6,218 ms |
| Elapsed profile time | 59,161 ms | 24,293 ms |
| Event-loop p95 | 4,861 ms | 62 ms |
| Event-loop p99 / max | 17,968 / 17,968 ms | 564 / 2,879 ms |
| Sibling mean / p95 | 21,383 / 21,383 ms | 804 / 1,127 ms |
| Hook mean / p95 | 19,149 / 21,385 ms | 435 / 1,520 ms |
| Dashboard mean | 42,015 ms (one request) | 1,463 ms (six requests) |
| Paired verification mean | 21,382 ms | 342 ms |
| Five run-summary reads, mean / p95 | 2,414 / 2,036 ms | 520 / 201 ms |
| Synchronous file reads | 67,263 | 1,427 |
| Bytes read | 900,622,947 | 105,220,877 |
| Synchronous file writes | 229 | 58 |
| Bytes written | 136,110,852 | 34,030,467 |
| Contended persist call | 835 ms | 0.65 ms |
| 20 ms heartbeat under contention | 1,825 ms | 20.2 ms |

The overloaded baseline cannot sustain the requested cadence, so operation
counts and actual elapsed time differ. These are outcomes of a fixed offered
workload, not equal completed-throughput samples. CPU time fell 65%, read bytes
88%, and written bytes 75%, while more messages and dashboard requests completed.
Other owner workloads changed during the session; exact latency varies with disk
and CPU contention. The counters and controlled contention check provide stronger
causal evidence than a wall-clock comparison alone.

The original discovery run, without progress writers and before CLI-root
isolation, had 71 failures, 11.6 s maximum event-loop lag, 50,072 reads / 732 MB,
and 12,421 ms CPU. CPU samples were dominated by `readFileUtf8`; the final baseline
also showed `readArchivedJobs` and filesystem traversal. Its hottest
`readFileUtf8` node had 14,494 samples, `lstat` had 1,836, and `readArchivedJobs`
had 411. Candidate hot nodes included SQLite `all` (2,306 samples), `run`
(850 and 818), `readFileUtf8` (598 and 314), and `stat` (306). These are raw
per-node profiler samples from differing elapsed windows, not normalized shares.
After caching, SQLite
`all`/`run` and metadata checks became the larger residual costs. The candidate
still has cold-start and persistence stalls; it does not promise zero lag.

## Root causes and changes

- **Shared jobs lock blocked the elected broker.** `Atomics.wait` could sleep up
  to two seconds per contended save. Job persistence now tries once and schedules
  jittered retries of the latest state. Concurrent progress changes coalesce into
  one save per manager. Uncontended lifecycle saves remain immediate.
- **Every sibling send repeatedly reread every archive.** Parsed JSON snapshots
  validate size, modification/change/birth times, device and inode. The broker
  reuses the merged registry and shares it within a synchronous dispatch batch;
  the next microtask expires that batch view. Malformed archives still report
  errors. Public projections are cloned so callers cannot poison cached data.
- **Dashboard polls reread and split unchanged logs.** Run summaries are cached
  by file identity and metadata. Staleness and ETA expiry are derived on every
  read. Canonical directories are validated once per scan; direct files use
  `lstat`, and symlinks retain containment checks. Active/archive precedence,
  recovery and pagination remain intact. Workdir classification and represented
  job lookup use indexes rather than repeated full scans.
- **Replacing a session also closed its elected listener.** Replacement now
  retires the session connection while retaining the listener until actual process
  shutdown. Other sessions keep their connections.
- **Deferred callbacks could escape request error handling.** Replay and runner
  checks now contain transient failures; completion processing logs failures
  without terminating the broker. Per-connection in-flight and output bounds
  isolate floods/slow clients. Inbox replay respects stream drain backpressure;
  unread mail remains durable for reconnect or pending reads.
- **Unchanged paired advertisements repeated full snapshots.** Echo-capable
  links advertise only changes, retaining compatible full snapshots when needed
  and continuing periodic verification. Older links retain periodic advertisements.
- **Two completion delivery paths used different IDs (AB-117).** Runner state
  now carries an optional per-turn report identity. Broker delivery and supervisor
  fallback share its UUID; either arrival order produces one context report.
  Later turns remain distinct and legacy states still work.

Parsed-file caching has an 8 MiB input-byte budget and 2,048-entry bound. Summary
caching is limited to 2,048 entries. Merged archive caches are limited to four
homes with an 8 MiB input limit each. Eviction changes memory only, never disk.
No retention policy, database schema, indexes, VACUUM or owner configuration was
changed. WAL already existed, and the measured dominant cost was repeated file
work. No migration or migration backup was needed.

## Report triage and acceptance

- **AB-97:** quiet observer copies are already filtered from hook/wake delivery
  in current source. The failed observation predates installation of that fix.
  Copies remain stored and explicitly inspectable; current messaging/retention
  regressions were rechecked. Owner reload/live-context acceptance remains open.
- **AB-117:** completion fallback race fixed and tested in both arrival orders.
- **AB-115 / AB-116:** commit trailers and approval-text parsing remain outside
  this performance lane.
- **AB-118 / AB-119:** worktree close/cleanup and ACL ownership remain outside
  this lane. No cleanup or permissions change was made to owner folders.
- **AB-120:** offline broadcast semantics remain outside this lane.

Crash resilience is available separately in `bdde674`. Build/typecheck and all
new overload/retention regressions passed. Its first four-worker run had 759
passed, one existing runner-continuation predicate timeout, and two skipped; that
scenario passed its isolated rerun. The final candidate run had 767 passed, one
existing detached-runner predicate timeout, and two skipped; that scenario also
passed isolated. Build and typecheck passed, and each of the four new test files
passed alone with default timeouts (12 tests total). The merged 0.29.10 release
passed build, typecheck and the complete four-worker suite: 84 files passed,
768 tests passed and two skipped (261.50 seconds). Release CI is recorded in
AB-121 and the task report. Vitest configuration and timeout declarations were unchanged.
New tests run in seconds; this load harness never enters the default test suite.

Synthetic survival and local tests do not establish deployed two-PC acceptance
or diagnose every prior broker exit. The supervisor owns release, reload and
live acceptance; handoff and TODO files are untouched.

## Durable conversation ingestion

The conversation-storage lane moves history scanning and SQLite/FTS ingestion to
one elected background worker. It adds bounded raw chunks, cached transcript
headers, source offsets, watch prioritization and project replicas. The AB-121
measurements above predate that lane and are not measurements of its throughput.
See [conversation-storage.md](conversation-storage.md) for budgets and capture
semantics. The retained corpus is append-only; no purge or VACUUM policy changed.
## 0.29.15 load and bounded hook follow-up

The AB-121 harness now supports `AB_PERF_JOBS=50`. Run it from existing dependencies:

```powershell
$env:AB_PERF_JOBS='50'
$env:AB_PERF_SECONDS='20'
node scripts/performance-run.mjs
```

Both 20-second runs used 50 synthetic jobs, 56 peers, 680 logs and 8,000 retained
messages in a fresh home. Owner storage was never opened. Host load varies;
these are survival checks, not a general throughput claim.

| Measurement | 0.29.10 | Narrow 0.29.15 candidate |
| --- | ---: | ---: |
| Failed probes | 0 | 0 |
| Peers p95 | 896 ms | 899 ms |
| Direct send p95 | 899 ms | 897 ms |
| Hook transport probe p95 | 1,680 ms | 1,293 ms |
| Dashboard maximum | 2,989 ms | 1,622 ms |
| Heartbeat during a controlled SQLite writer lock | 600 ms | 22 ms |
| Peers during that lock | 601 ms | 15 ms |

The hook transport probe measures authentication plus dashboard peer lookup,
not the MCP Stop handler. A separate real MCP scenario used the installed
0.29.14 Codex bundle against synthetic peers. After a direct send, Stop was still
blocked when cancelled at 2,100 ms. The installed handler deliberately long-polled
for up to 290,000 ms; this matches the reported five-minute delay without needing
broker overload or transcript ingestion. The identical scenario with the new
bundle returned in 2.3 ms. No owner hooks or unread messages were consumed.

Hooks now share a 1,500 ms deadline across metadata, connection, replay and summary
reads. Slow work defers mail to a later hook. A deadline rejects the continuation
before it marks context mail read; late parent inbox responses remain buffered.
Stop processes queued results immediately and arms one notify-mode subscription
for running jobs, rather than polling. Existing wake delivery handles later replies.
Permission and approval relay waits remain separate from mail hook deadlines.

SQLite writers use WAL and busy timeouts. Broker mutations use short native waits
and asynchronous retries, rechecking job ownership before writing. A delayed send
no longer prevents peers from answering. Pending routing yields in bounded batches,
imports retained delivery envelopes, preserves consumption journals and retries
busy drains. Hook consumers refill backlogs exceeding the initial 500-row replay.
Send retries reuse their deduplication key. Broadcasts queue saved offline local
registrations and report delivery per recipient, preserving job ACL restrictions.

Project identity resolution checks durable roots before launch-spec recovery.
Authority configuration is cached by canonical root and agent only until the next
microtask, preserving immediate opt-outs and malformed-setting rejection. Hosted
poll batches avoid reloading ownership for every job. Hooks use cached job metadata
and perform no transcript filesystem scanning.

AB-129's historical 159 unread rows were quiet sibling observer copies. All real
results recorded before that report already had read receipts, which prove bridge
consumption rather than comprehension. Independent regressions verify final-result
Stop delivery with auto-wake disabled and draining 550 results past 159 quiet copies.
Observer notes stay available on demand and never enter supervisor context.
Real MCP-plus-hook reconnect scenarios cover sibling isolation. Claude, Codex and
opencode receive the same shared hook and backlog support.

This release retains SQLite schema 7 and introduces no migration. The upgrade test
loads the complete 0.29.10 schema, preserves mail, registrations, session identity,
decisions and an unknown user table, and checks the existing readable schema-6
backup. The 400-job JSON upgrade verifies retained unknown fields, one backup and
idempotence. No user data is deleted. Conversation schema 8 and other feature lanes
are intentionally released separately.
