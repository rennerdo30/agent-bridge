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

## Follow-up load and delivery checks (AB-122/123/124/126/129/120/97)

The same harness now accepts `AB_PERF_JOBS=50` and adds ordinary `peers` and
direct `send` probes. Both comparison runs used 50 synthetic jobs, 56 peers,
50 progress sources, and the same 20-second offered workload. No owner data
was modified. Concurrent sibling validation adds uncontrolled host load, so
these results do not establish an overall throughput improvement:

| Measurement | 0.29.10 | Integrated candidate (`90e9db0`) |
| --- | ---: | ---: |
| Failed probes | 0 | 0 |
| Peers p95 | 896 ms | 1,593 ms |
| Direct send p95 | 899 ms | 1,790 ms |
| Hook p95 | 1,680 ms | 1,833 ms |
| Dashboard maximum | 2,989 ms | 2,120 ms |
| Heartbeat during a controlled SQLite writer lock | 600 ms | 21 ms |
| Peers during that lock | 601 ms | 16 ms |

The controlled lock comparison isolates synchronous SQLite waiting: broker
writes now retry with short native waits and asynchronous backoff. Ordinary
peers can answer while a send waits for the writer. Writable bridge databases
use WAL and busy timeouts; external databases remain read-only. Native agent
lock failures receive bounded retries using the same session and deadline.
The initial integrated conversation/group candidate exposed a further regression:
44 failed probes, 7,701 ms event-loop p95, and 44,757 ms elapsed profile time.
Profiling identified repeated configuration and launch-spec reads, a pending-mail
table scan for every retained job, archive traversal on every async routing step,
and a full ownership refresh for every hosted job in an already refreshed poll.
The final candidate has zero failed probes, 19 ms event-loop p95, and 23,623 ms
elapsed profile time. Hook p95 is 1,833 ms; controlled writer-lock send completes
in 841 ms while peers continue answering. CPU time includes the new ingestion
worker, so comparison with the old broker alone is not a worker throughput claim.

Authority settings and job-root fallback are shared only within a synchronous
dispatch and expire at its next microtask. Agent-specific opt-outs, malformed
settings and original project identities retain their guards. Routing yields
every 16 retained jobs, batches pending-sender scans, and skips empty write steps.
Pure authenticated dashboard connections do not change job recipients when they
close. Every retained envelope is still imported before an empty-mail shortcut;
actual writes and retries re-read durable ownership and preserve read journals.
Hosted polls refresh ownership once before their synchronous job batch; individual
control and delivery callbacks retain their own refresh.

AB-129's exact historical 159 unread rows were quiet sibling observer notes.
All recorded true results before that report already had read receipts. New
real MCP-plus-hook scenarios nevertheless exposed independent delivery gaps:
the final result could be omitted by Stop with auto-wake disabled, and the
500-row initial replay could strand a larger backlog. Hook and channel consumers
now refill durable pending mail, batch acknowledgements, and bound pending
responses by bytes as well as rows. Quiet notes stay available through explicit
inbox/history reads and never enter supervisor hooks automatically. These
scenarios cover claude, codex and opencode. A real offline-sibling scenario also
found that the new group backlog router could mistake sibling mail for a job
report. Both pending-recipient discovery and handoff copying now exclude the
`siblings-` conversation prefix. Three real MCP scenarios exercise supervisor
hooks, receiver activation/replay, and explicit retained observer copies.
Offline local broadcast recipients
are queued from saved registrations; job sender restrictions still apply.

The upgrade fixture preserves the full 0.29.10 schema and synthetic messages,
peer registrations, session identity, decisions and an unknown user table through
the integrated schema-8 upgrade and verifies the readable schema-6 backup. A
400-job upgrade additionally verifies unknown fields, one JSON backup and repeat
upgrade idempotence.
No schema bump or destructive data operation is introduced by this lane.

## Durable conversation ingestion

The conversation-storage lane moves history scanning and SQLite/FTS ingestion to
one elected background worker. It adds bounded raw chunks, cached transcript
headers, source offsets, watch prioritization and project replicas. The AB-121
measurements above predate that lane and are not measurements of its throughput.
See [conversation-storage.md](conversation-storage.md) for budgets and capture
semantics. The retained corpus is append-only; no purge or VACUUM policy changed.
