# Updates while sessions are running

`npx -y github:rennerdo30/agent-bridge update claude codex opencode --yes`
publishes a new release without stopping sessions. Where the native client is
installed, `update antigravity --yes` applies the same retention policy.

New MCP server starts select the published compatible runtime. Existing servers
continue with their original code, stdio connection, session identity, broker,
jobs, approvals and notification waits. The updater reports recorded live server
PIDs and versions, including servers still on retained code. Launches made before
the startup launcher was introduced are unrecorded, rather than guessed current.
PID liveness is best-effort reporting; PID reuse can leave a stale launch record.

## Why the old updater required shutdown

The previous installer skipped Codex on Windows whenever it found any running
Codex process, including background jobs. The restriction was in agent-bridge;
it was not evidence that each process had a JavaScript module file open.

Codex caches plugins under `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>`.
Its [0.157.1 cache implementation](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/core-plugins/src/store.rs)
publishes a new version and then attempts to delete older directories. Reinstalling
the same version renames the entire plugin base into a temporary backup. It selects
the highest semantic version, with `local` taking priority over numbered releases.
The [current implementation](https://github.com/openai/codex/blob/main/codex-rs/core-plugins/src/store.rs)
retains these behaviors. This updater bypasses those destructive native steps.

The MCP configuration starts `node ./dist/server.mjs` with `cwd: "."`, resolved
inside the cached plugin directory. A running process's working directory prevents
directory rename/removal on Windows. The mocked-client test reproduces this with
a real Node process and then proves that separate-version publication succeeds.
Read-only inspection of the owner's current cached module allowed an exclusive
read, so persistent module handles were not demonstrated. Older cache directories
contained missing server modules, consistent with partial native pruning.

[OpenAI's plugin documentation](https://developers.openai.com/plugins/build/plugins)
describes cached installs and client restart for local metadata refresh. Updating
files alone cannot force an already running host to re-read every manifest, skill
or tool schema. Source inspection and mocked tests do not establish live desktop
plugin refresh behavior.

## Publication and retention

- Each plugin snapshot is copied into a unique staging directory outside the
  version selector, then published by one directory rename. No old directory is
  renamed, overwritten or pruned. An identical reinstall is a no-op; changed
  content at the same version is refused. Release a new patch instead.
- Codex receives a complete numbered cache entry and a local marketplace containing
  that same release. The updater atomically changes only its marketplace source
  in `config.toml`, preserving unrelated tables and the plugin's enabled preference.
  This prevents a stale Git marketplace snapshot from requesting a downgrade.
- Claude Code's v2 installed-plugin registry atomically selects the new cache path
  for every existing scope. Other plugins, scope fields and custom metadata remain.
- opencode's small native entry imports the new plugin from an immutable directory.
  Its legacy server directory remains untouched for already loaded legacy plugins.
  Skills and agent definitions are backed up before replacement; foreign files
  remain untouched.
- Antigravity publishes complete runtimes beside its native plugin descriptor in
  `.agent-bridge-runtime/plugin-versions/antigravity/<version>`. MCP and hook
  metadata switch atomically with adjacent backups; legacy `dist` and every old
  runtime stay intact. Unknown native settings and selectors are refused. Custom
  MCP entries, environment fields and a deliberately disabled permission gate are
  preserved. The exact PreToolUse gate follows the selected runtime and retains
  encoded Windows command paths. Native uninstall archives the descriptor while
  preserving all immutable runtimes for workers still using them.
- The bundled `server.mjs` is a small startup selector; real code is `worker.mjs`.
  It imports exactly once. A cached launcher can select a newer runtime on its next
  start. The runtime selector has schema version 1 and includes the broker protocol
  version. Unknown formats are preserved and refused; incompatible selectors fall
  back to the launcher's bundled worker. Existing database migrations and backups
  remain responsible for shared user-data formats.
- Every replaced metadata file has a unique adjacent backup. Failed staging and
  older plugin snapshots are retained. Links and junctions in source or writable
  destinations are refused. There is no automatic version cleanup.

## Limits and recovery

This release does **not** replace a worker mid-session. An apparently idle server
may still own a broker, delegated jobs, approval relays, pending MCP requests or
notification waits. Hook replay alone cannot restore that state safely. A future
live worker handover needs a versioned transfer protocol for all these resources.
Until then, running sessions stay functional on retained code; they can adopt new
code through a client-supported plugin reload or when their MCP server next starts.

The first update from a legacy package cannot retrofit a launcher into an already
loaded server. A long-lived desktop host may cache plugin metadata for new chats;
the host must start a newly selected MCP server before those chats get new code.
There is no claim that every new chat in an existing desktop process re-reads
plugin metadata. After a launcher-equipped server is installed, its next startup
reads the runtime selector independently of the host's cached launcher path.

Mixed releases continue speaking broker protocol 2, with existing feature capability
negotiation and optional readable-store ceilings on hello; older brokers ignore
that additive field. Peers and dashboard name the actual retained versions. An
incompatible future protocol cannot automatically join an old broker merely because
the updater publishes its files. Coordinate incompatible major migrations separately.

Shared JSON and the primary SQLite database do not advance to an unreadable
version while recorded live peers still need an older format. New peers record
their maximum readable versions; legacy ceilings are taken conservatively from
released formats. Presence is retained after broker loss and checked by PID,
so the next elected broker waits too. Unknown live readers block advancement.
Existing readable data stays available; an operation needing a format upgrade
reports the named blockers and can retry after they finish naturally. No process
is stopped. This cannot undo a format upgrade made by a pre-guard release, and
unobserved legacy launches are not claimed to be protected retroactively.

Migrations take a process writer lock before snapshotting or inspecting versions.
They recheck the schema after acquiring it, then create and integrity-check a
protected snapshot in `.migration-snapshots` before DDL. Protected originals are
never rotated; a public copy supports existing backup discovery. Recovery keeps
the SQLite writer transaction through restoration. A live migration lock never
expires by age; other candidates retry and broker election tolerates contention.
An exited writer's lock can be recovered without deleting data. Optional public
snapshot rotation tolerates Windows handles and concurrent legacy rotation.

Codex caches using `local`, non-release directory names or a newer release are
preserved and refused, since highest-version selection would not activate the
requested numbered version. Claude registry formats other than v2 are also refused.
Initial plugin registration still uses the native install command; `update` uses
the retention-safe path. Both install and update finish by synchronizing the native
selectors. Claude's marketplace clone is fetched and fast-forwarded only after the
incoming manifests match the packaged release. Dirty or divergent clones are refused;
no reset, clean or pruning is used. Existing Codex Git marketplaces are refreshed too,
while its configured local marketplace points at the same immutable cache release.
opencode's loader and Antigravity's MCP config select their retained runtime versions.

`agent-bridge doctor` (or `agent-bridge doctor --json`) reads marketplace manifests,
installed records, selected cache/runtime versions, native loaders and live server
processes. Mismatches include the client and exact update command. Retained running
versions are identified separately, with reload/restart instructions to use after
active work finishes. An unavailable process lookup is reported as unverified.
Doctor never invokes plugin managers or repairs these paths automatically.

Native uninstall/force reinstall and independent native
marketplace updates are outside this updater's retention guarantee. Do not run
those commands concurrently with this updater. Concurrent metadata changes detected
before replacement cause a refusal with both revisions preserved.

For recovery, retain the previous metadata backups and complete old directories.
Restoring an old selector is an explicit operator action; numbered Codex cache
selection also considers higher versions, so restoring only `config.toml` is not
a reliable rollback. Never remove a version until all users of that version have
finished and cleanup has been explicitly authorized. No opt-in cleanup is added
by this change.

## External termination during an update

The AB-155 incident was a manual process-tree termination following the legacy
updater's refusal, not a kill performed by the updater. All ten runner PIDs
survived the broker restart; their app-servers were manually terminated later.
Do not stop active job processes to update. Current publication retains every
old runtime and changes only the selector for future starts. A regression keeps
ten mock app-servers active through publication and verifies their pinned code
and normal completion. An unexpected active-turn exit now names external
termination as a possible cause and preserves the resumable session; an exit
code alone cannot distinguish a manual kill from a native crash.
