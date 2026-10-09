# AB-208 implementation gate

AB-208 supersedes file ownership leases for 0.30.4. Implement it on the released
AB-206 job-row and compressed-archive contract. The reviewed base `c5cfd6b`
still stores jobs in JSON; AB-206 has not landed in that branch object. No new
SQLite migration number or competing jobs/archive schema is assigned here.

## Adapter inventory

| Domain | Current adapter | Required row behavior |
|---|---|---|
| Runner specs/state | `src/mcp/job-host.ts`, `src/mcp/job-runner.ts` | Spec keyed by job and turn; atomic state/heartbeat updates; immutable prior turns retained |
| Worktree state/leases | `src/core/worktree-state.ts`, `metadata-file-lease.ts` | Transactional owner nonce, PID creation identity and heartbeat; append archived ownership evidence on release/recovery |
| Outcome decisions | `src/core/job-outcomes.ts` | Job name and turn identity; preserve holds, reasons, authority and unknown fields |
| Local completion receipts | `src/core/local-result-receipts.ts` | Immutable complete message envelope; deduplication by message ID, owner and turn |
| Deferred job receipts | `src/core/job-pending-journal.ts` | Preserve writer identity/sequence/base snapshot and conflicting envelopes; no acknowledgement before durable receipt commit |
| Read-state | `src/core/read-journal.ts` | Identity-scoped monotonic read markers; replay across reconnect and broker retirement |
| Store capabilities | `src/core/store-compatibility.ts` | PID creation identity, explicit capability floors, unknown-reader fail-closed upgrade gate |
| Active/finished runs | `src/core/runfeed.ts`, `src/core/run-history.ts` | Active append log allowed; indexed metadata and rotated compressed finished-run bundles |
| Dashboard/peer polls | `src/core/broker.ts`, `src/core/dashboard-read.ts`, `src/mcp/jobs.ts` | Indexed projections from AB-206 rows; no directory scans or JSON reads after admission/import |

## Migration constraints

1. Reuse AB-206 database admission, backup and packing APIs after reviewing the
   released implementation. New capabilities must not permit an old runner to
   observe a format it cannot read. Keep the compatibility projection while old
   readers still require it; transition only after verified reader admission.
2. Back up before the versioned database change. Import exact raw bytes as well
   as queryable records. Preserve malformed, oversized, duplicate, future-format
   and unknown-field evidence instead of normalizing it away.
3. Publish a compressed bundle and SHA-256 manifest without replacing an
   existing artifact. Restore into an external generated temporary directory,
   compare each file's bytes/hash and verify imported row coverage before any
   original moves to cold storage. Retain staging and verification evidence on
   interrupted/failing work. Journal cold moves for restart-safe resumption.
4. Refuse linked ancestors and raced physical identities. Never use file age,
   heartbeat expiration alone or PID existence alone as abandonment proof.
   Unknown identity blocks takeover. A reused PID must not authorize killing it.
5. Lease release and stale recovery append ownership history; they never delete
   lease evidence. Compare the immutable nonce inside the same transaction that
   acquires/releases the row. Report surviving owned tools to the supervisor.
6. AB-187 remains separate: pre-versioned empty job/worktree locks are read-only
   evidence. AB-208 must neither reconcile them nor move them automatically.
   Any future archive action requires the explicit owner-confirmation flag and
   fresh handle/state evidence.

## Required regression matrix

- Exact MCP `cancel_subagent` then `message_subagent` continuation through row
  leases: same worktree/native context, all retained bytes, archived prior owner.
- Dead owner, live owner, reused Windows PID, unknown process identity, expired
  heartbeat with a still-live owner, concurrent acquisition, stale release and
  interrupted transaction. Heartbeats alone never prove process death.
- Old-runner admission and compatible fallback without a migration/write;
  new-reader activation only after the version gate; capability loss/reuse.
- Immutable result/deferred receipt recovery, precise envelope comparison,
  continuation authority, cancellation authority and read-state replay.
- Lossless compression/import round trips, malformed/oversized records,
  interrupted packing and cold moves, idempotent restart, checksum failure,
  disk-full/write refusal and unknown/linked source retention.
- Generated 10k jobs plus 10k finished runs on Windows: peers/dashboard p95
  below one second; counters prove zero steady-state directory scans/JSON reads.
  Repeated jobs/messages add rows, not per-item hot files; cold bundles rotate
  without pruning. Retain fixture and measurements.

All fixtures must be physical directories outside repositories, fenced with
`GIT_CEILING_DIRECTORIES`. No live bridge storage, installation, release-job
worktrees or credential files are inputs to these checks.

## Release boundary

Wait for origin `v0.30.3` and green platform CI, rebase `release/0.30.4`, then
implement and validate this matrix before the remaining AB-147/183/168/187
gates. Rebuild every plugin, run full tests, audit retention/privacy, and only
then fast-forward/push/tag through the authorized release sequence. No tag or
shared branch is moved or force-pushed.
