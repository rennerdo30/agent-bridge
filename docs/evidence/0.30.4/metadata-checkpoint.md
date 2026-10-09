# Independent metadata checkpoint

This checkpoint is on `release/0.30.4` in the physical
`D:\Development\agentbridge-0304` worktree. The requested E: drive alias resolves
to D:. No shared push, tag, installation or live migration was performed.

## Implemented

- Additive `bridge_components` metadata versioning leaves the global AB-206
  SQLite version untouched. Old-reader admission protects file authority;
  existing databases receive a verified protected backup before metadata DDL.
- Worktree ownership uses transactional PID creation identity, job ID, nonce,
  acquisition/heartbeat times and retained archived ownership rows. Unknown
  legacy directories remain untouched and protected. Heartbeat age never grants
  recovery authority. Verified v2 file metadata retains its known identity.
- Capabilities, local completion envelopes, consumption receipts and outcome
  decisions use indexed rows after lossless import. Decision history and unknown
  fields survive. Maintenance exclusion and explicit SQLite handle shutdown
  remain enforced.
- Imports retain exact bytes and SHA256 manifests in bounded shared gzip
  members. Every member is restored and compared before original cold moves.
  Failed projection and source races preserve evidence. Orphan members from a
  failed transaction remain retained; later members append after actual file size.
- Completed-run pack/index APIs preserve active/uncertain logs, retain metadata
  and share bounded bundles. Broker migration and run-history reader integration
  await AB-206's tested worker contract; automatic run packing is not wired yet.
- `doctor --migration-plan [--json]` inventories file metadata without opening
  databases or credentials. Action flags are rejected. The authorized real-store
  report is retained in `migration-plan-real.json`, with the home display redacted.

## Evidence

- TypeScript typecheck and four plugin builds succeeded.
- Nine-file focused Windows run: 74 tests passed, 84.12 seconds. Covers metadata,
  completed-run bundles, row leases, outcomes, capability compatibility, delivery
  reload, migration planning, worktree close retention and runner continuity.
- Rebuilt MCP test `cancel_subagent then message_subagent continues the same
  worktree and archives its lease` passed. Retained untracked worktree bytes and
  native continuation context are verified after cancellation.
- Fifty finished runs packed into one shared bundle; explicit content restores
  are byte-exact. Warm indexed receipt/outcome/finished-run loops perform zero
  directory scans and JSON file reads in the instrumentation tests.
- Authorized live planner only used directory entries and stat data. It observed
  a 21,248,008,192-byte primary DB, 65,320,866,816-byte migration snapshots and
  65,073,428,447-byte backups. Six pending-backup items total 64,572,643,328 bytes.
  No newer copy has yet been verified; all retention decisions remain with owner.

## Remaining gates

Integrate the coordinator-supplied AB-206 commit and its background worker,
finish specs/state and indexed run consumers, then implement ordered resumable
AB-209 migration. Compare consistent NVMe-speed snapshot methods under concurrent
writes, snapshot the real store to an isolated D: copy, measure MB/s and broker
p95, inspect copy-only dbstat, verify hashes/counts and history resume, and rehearse
replacement of hotfix-patched bundles. The final full suite, six CI legs,
privacy/retention audit and one final v0.30.4 publication remain pending.

Generated distribution chunks replaced by rebuild are retained physically in
the ignored `bundle-archive` directory. No source or user data is removed.
