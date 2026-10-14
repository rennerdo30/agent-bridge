# Development

Install Node 22.16 or newer and run `npm ci`. `npm test` runs the fast lane;
`npm run test:integration` runs the native process/storage lane. `npm run
typecheck` and `npm run build` are also required before submitting a change.

## Windows CI locally

Run `npm run test:ci-windows` on Windows to run both lanes with the CI flag,
unchanged test deadlines, and a fresh temporary fixture root. The root disables
ACL inheritance and grants the current user, SYSTEM and Administrators explicit
access. TEMP/TMP and the test home live there; cleanup removes only this
invocation's marked root. The marker must exactly match its random token and path;
missing/changed markers and outside, chained or unproven links retain the whole tree. Every cleanup
entry is checked for containment and links before nonrecursive removal. Native
handles prevent entry replacement or in-place link conversion during deletion.
Before any deletion or metadata change, every regular file and marker must have
one observed link, a known volume/full 128-bit file identity on its held handle,
and canonical containment in the marked physical root. Unsupported queries,
unknown/multiple links or changed identities refuse the whole preflight. Link
count is a snapshot; handle sharing does not establish an atomic topology lock.
Read-only regular files use native `FileDispositionInfoEx` with only DELETE and
IGNORE_READONLY_ATTRIBUTE; cleanup never clears their shared read-only flags.
That flag requires Windows 10 1809 or a supporting server/filesystem. Unsupported
deletion fails without an attribute-clearing fallback and retains remaining
fixtures/marker evidence; it may fail after earlier admitted entries were removed.
Ordinary delete-on-close semantics remain: other open handles can delay final
removal, and failures/partial cleanup are not reported as complete success.
Only a directory junction to a physical directory in the same marked root can be
unlinked, by its own handle, with no traversal. Each unlink logs its path, target
and reason; symlinks and volume mount points are refused.

```powershell
npm run test:ci-windows -- -Throttle
npm run test:ci-windows -- -FreshVolume
npm run test:ci-windows -- -Lane integration test/ci-windows.test.ts
npm run test:ci-windows -- --shard=1/4
```

`-Throttle` lowers priority and restricts children to one allowed CPU.
`-FreshVolume` is unavailable, including with administrator rights. Both public
entries refuse it with a nonzero exit before fixture creation or any disk,
partition, mount, format or access-path mutation. There is no fresh-volume
fallback. Support requires a separately reviewed mechanism binding the owned
image/root/disk/partition handles across every mutating operation. The retained
creation/GUID ownership helpers and same-handle native detach checks do not
establish that missing lifecycle proof. The existing guarded folder mode remains
available; interrupted folder cleanup can leave marked evidence for inspection.

This approximates runner ACLs and CPU contention. It cannot reproduce the hosted
Windows Server image, token/default owner, NTFS file-ID magnitude, antivirus,
installed tools, disk/network latency or other tenants. Administrator/VHD
acceptance is unsupported. See the PowerShell script header for the limits.
The runner uses short folder names to leave room for SQLite snapshots. If your
TEMP/TMP path is unusually long, set them to a shorter writable folder first.

## Branch CI

All pull requests and pushes to `main`, `fix/**`, `feat/**`, `ci/**` and `docs/**`
run Node 22 and 24 on Linux, macOS and Windows, including documentation changes.
Superseded runs for the same branch or PR are cancelled. Windows uses four
parallel shards of each lane, retaining one integration worker per shard.
`npm run test:shards -- 4` lists the files using Vitest's configured sequencer and
proves every file is covered exactly once. CI also checks the files actually run
against that inventory. Before running a shard, CI uses
`npm run test:ci-windows -- -CollectOnly` in a separate fresh marked root to
collect the unsharded cases for both lanes. This imports setup files and test
modules and evaluates collection code, including parameterized and conditional
tests; it does not execute test callbacks or hooks. Collection retains the
configured worker isolation and uses a separate temporary cache.

The four shard file sets must be disjoint and cover every unfiltered file.
Each shard's final cases must exactly match its portion of the unsharded census
by project, file, deterministic Vitest module ID and case ID, including collection
skips. Pinned Vitest IDs bind the project-relative file and nested registration
order; exact checkout/runtime metadata binds that structure to the source.
Full names remain informational, including runtime-dependent parameter values
such as worker PIDs. Structural membership does not prove those runtime values
are identical across collection and execution. Missing, duplicate or changed
IDs still fail; repeated names with distinct IDs remain separate cases. Artifacts record
the actual passed/failed/skipped disposition, checkout revision, Node/Vitest
versions, event, run ID and attempt, plus a deterministic census digest to compare
across all four jobs separately for each Node version. Failed tests still fail
CI even when their membership is known. A partial collection, missing report,
unhandled error or pending case produces `coverage: unknown`, retains available
census evidence and fails the coverage check. Collect-only is not a test pass.
No unsharded test bodies run. Per-job artifacts retain JSON results, shard lists,
failures and retry/flaky diagnostics; retries are not added or hidden.
Artifact names include the workflow attempt so a manual rerun preserves the
original failure evidence and can upload fresh results without a name collision.
