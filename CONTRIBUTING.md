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
missing/changed markers or any reparse point retain the whole tree. Every cleanup
entry is checked for containment and links before nonrecursive removal. Native
handles prevent entry replacement or in-place link conversion during deletion.

```powershell
npm run test:ci-windows -- -Throttle
npm run test:ci-windows -- -FreshVolume
npm run test:ci-windows -- -Lane integration test/ci-windows.test.ts
npm run test:ci-windows -- --shard=1/4
```

`-Throttle` lowers priority and restricts children to one allowed CPU.
`-FreshVolume` creates, formats and mounts a new disposable NTFS VHDX for fixtures,
then detaches it in `finally` only after checking its recorded creation path and
actual VHD GUID (checked again on the native detach handle). It requires administrator rights and Windows
Storage cmdlets; otherwise it prints a skip message and uses the fresh folder.
It never selects an existing volume. A forcibly terminated shell can leave its
marked fixtures or VHDX behind; inspect those before any manual cleanup.

This approximates runner ACLs and CPU contention. It cannot reproduce the hosted
Windows Server image, token/default owner, NTFS file-ID magnitude, antivirus,
installed tools, disk/network latency or other tenants. A fresh VHDX does not
guarantee large file IDs. See the PowerShell script header for the limits.
The runner uses short folder names to leave room for SQLite snapshots. If your
TEMP/TMP path is unusually long, set them to a shorter writable folder first.

## Branch CI

All pull requests and pushes to `main`, `fix/**`, `feat/**`, `ci/**` and `docs/**`
run Node 22 and 24 on Linux, macOS and Windows, including documentation changes.
Superseded runs for the same branch or PR are cancelled. Windows uses four
parallel shards of each lane, retaining one integration worker per shard.
`npm run test:shards -- 4` lists the files using Vitest's configured sequencer and
proves every file is covered exactly once. CI also checks the files actually run
against that inventory. Per-job artifacts retain JSON results, shard lists,
failures and retry/flaky diagnostics; retries are not added or hidden.
Artifact names include the workflow attempt so a manual rerun preserves the
original failure evidence and can upload fresh results without a name collision.
