# Retained backup recovery fixture admission

Mac CI job120085616712 at67a743c2 failed the newer-backup authority/context test
at `indexFixtureFile(jobs.json.backup-2)` with ENOENT. This is fixture ordering,
not evidence that backup rotation lost a record: both nodes had already started
the archive worker before the fixture created and manually indexed its copies.
The worker may retire a verified legacy copy before a later root-only read.

The production `migrateJobArchives` path imports exact serialized versions,
verifies them in `job_versions`, bundles and reimports the bundled version, then
uses `retireBundled` to recheck and move originals into
`cold-storage/jobs-v1/{archive-originals,root-originals}`. It does not promise
that an imported legacy backup remains at its original root path. The existing
test helper `retainedRootJobCopy` already documents that retention contract.

The corrected fixture exclusively owns a newly isolated home and has no live
node/worker while writing its two legacy copies. It awaits the actual admitted
archive migration, including the production migration lock and compatibility
check, before node registration. No guard or migration is stubbed. It checks:

- Both copies were imported and moved, with none deferred or left unverified.
- Both original complete serialized job versions are present in the index.
- Both raw original files are byte-exact in their documented cold locations.
- The old supervisor is refused and the newer supervisor retains its exact
  authority, session, prompt and inherited root/parent/access context.
- Project job visibility still follows the newer owner; the active registry
  remains empty and neither original file changes after the authority reads.

The adjacent archive-only context fixture also finishes its explicit import and
metadata setup before starting its node. No production source, ownership policy,
helper fallback, timeout, assertion, protocol/schema or protected pin changes.

## Evidence qualification

Official Mac CI is the original test's red evidence:1 failed,4202 passed,
136 skipped. Its other takeover, fairness, remote TLS and quiet cases passed in
that run; those results do not prove their earlier failure causes.

A deterministic offline probe at unchanged67a743c2 forces the real migrator to
complete the allowed worker interleaving before the original root-only helper.
PID44832 exited1 within60s with the same ENOENT, **after** asserting both cold
originals were byte-exact and the newer record had precedence. This is a forced
interleaving reproduction, not a claim that the original test was rerun locally
with its real worker. The probe is retained in ignored validation artifacts.

Working-patch PID32996 exited0 within60s on the original newer-backup test,
with21 unrelated cases excluded. That run is not labelled as a frozen commit.
Final exact head/tree, commands, PIDs, exits and noEmit evidence are recorded in
`E:/AgentData/reports/ab458-pr141-<head>-retained-backup-validation.json`.

Local verification runs real migration, persistence, recovery and in-process
registration against the isolated fixture. Only the subsequent background-worker
launcher, OS identity queries and external native discovery are mocked; child
process launches are blocked. The adjacent archive-only large-tail case remains
for hosted CI. No native provider, daemon, TLS fixture, full suite, build,
install, release, Bridge call, delegation or further agent was launched.
Fresh independent review and hosted full/native/lifecycle gates remain required.
Earlier tenth-runner, note-retry and fairness causes remain unproven.
