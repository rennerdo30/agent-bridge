# Reliability and retained data in 0.30.3

`worktreeRoot` accepts an absolute directory for newly created job worktrees. The environment override is `AGENT_BRIDGE_WORKTREE_ROOT`. Saved worktree paths remain authoritative when continuing old jobs. Changing this setting does not move or clean old worktrees.

Windows Codex worktree edit jobs use `danger-full-access` by default when `codexWorktreeSandbox` is unset and the general sandbox retains its read-only default. Set `codexWorktreeSandbox` to select a restricted sandbox explicitly. Explicit read/ask jobs remain restricted. This setting applies at the next turn; it does not restart running jobs. Cancelled jobs are distinct from failures.

History import runs in the history worker, outside broker dispatch. `history.ingest=false` pauses it without resetting source or migration cursors. Re-enabling import resumes retained cursors. Each retained raw chunk is read back and compared before its source cursor advances. A verification failure latches; `reindex` explicitly retries while retaining the prior failure evidence.

`history.budgetBytes` defaults to 8 GiB; zero disables the budget. Accounting includes history DB pages/indexes, WAL and sidecars, history backups, migration snapshots and project mirrors. Import pauses with an explicit storage-budget error before admission when capacity is exhausted. This is a lossless admission budget, not a hard filesystem quota: existing retained data may already exceed it, and SQLite page/WAL allocation or a concurrent writer may exceed the batch reserve. No records, snapshots, mirrors or backups are pruned to satisfy the budget. Increase the budget or provision additional storage before resuming a large migration.

The explicit `history-archive [absolute-archive-root]` command runs offline from the broker and creates a compact SQLite snapshot, checks its integrity, compresses it and verifies decompressed bytes against its SHA-256 manifest. Original history, snapshots, compressed copies and older manifests remain retained. Archiving consumes additional storage; it does not automatically reclaim the original or free budget. The owner controls storage placement and installation. No archive relocation or destructive retention command is run automatically.

Automatic worktree checkpoints include tracked substantive edits and explicitly staged new source. Unstaged untracked files remain private in the checkout and appear in the skipped-file report. Generated cache files retain their existing exclusion. Checkpoints do not push.

Authority reads retry transient failures with bounded backoff. Durable send retries reuse the same UUID. A stored result proves persistence; an unknown result does not prove absence. Use `send_status` or retry later with the same message ID. Parent links without durable IDs cannot safely resend an uncertain operation; their error directs the caller to inspect history first.

`npm test` runs the fast lane. `npm run test:integration` runs storage, sockets and process fixtures, with serialized Windows workers. `npm run test:all` runs both. All six CI platform/Node combinations run both lanes; hooks assert timer and wait behavior instead of machine-speed cutoffs. Opt-in stress and release rehearsals use generated fixtures only.
