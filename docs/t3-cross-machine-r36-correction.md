# R36 preservation correction and remaining owner decisions

Frozen source/test head: `cf5c9a555192c9168aa22a19f5b610daa191ad02`, tree
`e49b051f94a2e4531127bb699df919875b79082b`. Base:
`55b2fe19551471823580c664a98d04386fa4b55d`. Later documentation/artifact commits
are not exact tested heads. This is a correction for review, not acceptance.

The separately approved R35 baseline attribution was committed at 55b. Its three
hashes remain intact. A new abortStartup delta is proposed, not amended, in
`t3-cross-machine-mobile-pin-r36.patch` and `.json`. All other twelve methods,
UI hash, normalizer, behavioral assertions, retention guard, flaky candidate and
protocol10/metadata5/pairing1/SQLite14/JSON4/runner-ledger-v2 are unchanged.

## Effect and evidence boundaries

| Boundary | Repair / preserved evidence | Qualification |
| --- | --- | --- |
| Full-backup discovery | One bounded root-level schema/namespace inventory includes ordinary alternate mailboxes as well as canonical metadata, archive, history and present supported sidecars. The common storage lease prevents admitted schema/group transitions. Original database identities are retained and rechecked before publication. | Unknown/linked/incomplete groups refuse. No application rows or credential/config harvesting is used for discovery. |
| Archive interleaving | Every discovered primary precedes the monotonic shared archive in both sync and incremental paths. An archive move after a primary snapshot leaves at least the original primary copy; a move before it is captured later in the archive. | Per-database snapshots plus monotonic move preservation, not a global point-in-time transaction across all databases. No full-restore authority is inferred. |
| Completeness | The exact discovered DB group must equal the checksummed DB entries. Cold prepared.files independently requires canonical/main/archive/history. Actual selected alternate namespace must match prepared.namespace; all mailbox namespaces are compared. | Missing archive/history, an unchecksummed existing main, wrong alternate namespace, unknown proof or changed source refuses certification. Original anchor/journal/provenance bytes and source identities remain retained. |
| Directory publication | Probe and synchronize the parent chain before backup effects. Flush files, nested staging directories, staging, backups/home entries, rename and final backups entry in dependency order. Only then write the manifest-digest publication marker and flush its directory. | No file-flush substitute. Missing marker or uncertainty marker refuses; uncertain captured/published bytes are retained, not deleted. Success/rotation cannot precede final directory durability. Supported-platform power-loss acceptance remains unrun. |
| Restore | Cheap bound/ambiguous refusal precedes maintenance. Under actual maintenance exclusion, repeat source/destination authority, file/home signatures and source manifest verification before metadata close, recovery mkdir or displacement. | A current metadata writer appearing while lock admission is suspended remains open and its accepted BLOBs untouched. Bound full restore remains unavailable under AB-461; confirmation/force is not a generation grant. |
| Future/unsupported mailbox | Inspect version and immutable original envelope/key shape read-only before canonical metadata initialization. A future version refuses without any database/backup mutation. An unsupported layout is rechecked under common exclusion and snapshotted read-only; original schema/rows/bytes remain unchanged. | Original database and readable recovery snapshot retained. Valid shipping layouts continue through normal migrations; no guessed ownership or automatic schema2/3 admission. |
| Provenance retry | Explicit offline upgrade validates any existing provenance against its original home/file/anchor and preserves its exact stored value, timestamp and generation. Only genuine absence reaches INSERT. | No INSERT OR REPLACE; foreign/invalid/incomplete proof refuses. Existing current-component missing-provenance refusal remains. |
| Metadata census | Pre-current component inspection returns no admitted writable handle. Native RO preflights are classified separately; setup migration lease returns are outside each later operation window. | Actual129/130 RW references and close failures remain required. Native fixture not run locally. Three unsafe/hot authorizing-opener expectations remain pending below. |
| Mobile abort | Retire borrowed authority and start the existing bounded disposer synchronously before the first cleanup await. Continue owning every partial service and late callback. | Original five-second disposer bound and eventual retired-access denial retained. Exact pin review required; no baseline refresh made. |
| Deferred history fixture | Wait for the actual serving worker publication and paused state within the original single pause deadline. Establish canonical ordinary provenance before injecting history-only phase failures. | No prewarming production, longer deadline, fake owner or disabled original assertion. Actual large backfill/native worker fixtures remain hosted-only. |

The full-backup manifest number stays1: this correction adds required preservation
group/publication evidence to an unreleased branch format, not a transferable
writer/restore grant. Earlier incomplete branch backups are retained but not
certified by this reader. An older verifier does not prove the new completeness
contract; old binaries must not be used to certify/restore current bound homes.
No claim is made that a version bump can stop an unsupported old cached writer.

## Qualified verification

The fresh R36 allowance used **57,948 / 60,000ms**, including all failed attempts
and static inspections. Every raw stdout/stderr begins with commit/tree, own PID,
UTC start/end, elapsed, exit and original external step deadline. Raw files and
the append-only ledger are under `E:/AgentData/reports/ab458-r36-*` and
`E:/AgentData/reports/ab458-r36-budget.json`.

| Run | Exact head / qualification | Own PID; ms; exit | Result |
| --- | --- | --- | --- |
| backup-red | b168ad69; backup production unchanged from55b, other prerequisite corrections already present | 70408;3833;1 | Six meaningful failures: alternate omission, three missing checksum-group members, alternate namespace, absent directory publication.42 excluded. |
| backup-correction | 7007cbec | 25568;6461;0 |10 passed48excluded; this selector did not include the newly parameterized archive interleaving or mobile test. |
| typing-initial | 7007cbec |72464;1214;1 | Namespace output required explicit string narrowing; corrected. |
| restore-relocated-base-red | Harness70c17296; exact b168 backup Git blob, import relocation only, current dependency guards |50732;1424;1 | Old restore accepts a newly bound destination and displaces it. Not an unchanged whole-base run.50 excluded. |
| frozen-mechanisms |70c17296 |70768;14402;1 |56passed,3fixture errors: immutable ESM export spy twice and missing runtime constructor import. No passing-suite claim. |
| final-backup-boundaries |0f4d3c16 |66024;13035;-1, own process stopped at bound | Background fixture did not settle. No green result; retained raw evidence. |
| frozen-selected-final |dc47720c |10076;10043;-1, own process stopped at bound | Still incomplete after correcting archive-reader closure schedule. Native incremental/fake-clock cause not proven; no blind acceptance. |
| selected-controlled-transport |cf5c9a55 |27596;5560;0 |12passed47excluded. Explicit controlled SQLite backup primitive uses real production snapshot SQL/bytes, not native incremental scheduling. Covers sync/background order, group omission, namespace, publication refusal, restore TOCTOU, malformed/future bytes, provenance retry, census and mobile abort. |
| final-noemit |cf5c9a55 |53788;1258;0 |noEmit passed. |
| static-artifacts |cf5c9a55 |31372;375;0 |Committed Git-blob hashes and thirteen pins; one abort delta. Initial classification window could include the next FAIL block; original matrix retained in reports. |
| static-scoped-errors |cf5c9a55 |12560;343;0 |Corrected error-block boundary; all15 supplied logs/2562 FAIL error records retained. Nested Git PIDs26540/40108/53204, each1000ms bound, exit0. |

No native bootstrap Worker, provider, daemon, TLS fixture, build, full local suite,
installed migration/restore/helper/update/release was launched. Vitest's owned
test-runner threads are not production bootstrap workers. The mocked directory
transport is explicitly not evidence of Windows support. Earlier pre-R33
aggregate remains **NOT RECONSTRUCTED**; this allowance does not retroactively
validate it. Hosted full/lifecycle/actual-worker/native/Windows gates and fresh
independent R36 review remain mandatory.

## Complete CI inventory and residual contract forks

`t3-cross-machine-r36-ci-failures.json` contains every supplied8ed/55b FAIL header,
original line, first error/site, job hash and source qualification:15logs,
2562error records. Duplicated setup/afterEach records are not extra failed tests.
Ubuntu/Mac full55b each retain39distinct failed names; the matrix covers all39,
not only the latest tail. All six55b Windows shards are included. Shards1/2/4/5
have4/5/5/2unhandled respectively and coverage **UNKNOWN**. No pending rejection
is globally ignored. Their exact original future/old-turn/cancel/undefined-owner
assertions remain required and have not been rewritten as passes.

Explicit Windows unsupported directory publication is proven for the named8ed
and55b preservation cases and the current explicitly classified lifecycle cases.
It now affects ordinary metadata initialization as well as cold bootstrap.
Earlier generic bootstrapUnknown, timeout, HTTP500, stale state or cleanup errors
do not prove the same historical kernel cause. Secondary cleanup/retained-worktree
records remain evidence; no foreign process or retained home was force-reaped.

Remaining owner decisions are batched rather than implemented speculatively:

1. **Windows:** review `t3-cross-machine-windows-durability-proposal.md`. Source-only
   native-adapter feasibility needs separate approval; there is no currently
   proven supported portable directory publication primitive or acceptance claim.
2. **Three metadata native fixtures:** current authorizing opens must refuse a
   hardlinked/changed-identity or genuinely hot-journal home. Propose testing that
   refusal and retaining the already owned actual native references/bytes using
   non-authorizing observation, while preserving separate legitimate two-handle
   and129/130capture tests. Do not reopen/SQL-probe hot evidence just to retrieve
   the cached handle. The old two-admitted-aliased-handles expectation is
   unreachable under the approved strict opener; parent must approve that explicit
   test-contract change before it is made. No guard relaxation proposed.
3. **Required purge versus optional serving maintenance:** approved R35 deferral
   treats purge/archive scheduling as post-activation optional work; the old
   listen-failure fixture replaces purge with a throw and expects startup failure.
   Recommend preserving the required-step rejection/pipe-cleanup acceptance using
   actual mandatory recovery admission, plus a separate optional maintenance
   failure/ownership diagnostic. No fake pre-activation purge or silent expectation
   rewrite is implemented. Parent should select the intended contract.

Other unresolved acceptance includes approved bound restore unavailability
(AB-461, including doctor/background/decision round trips), older-reader
cohosting fixtures versus current provenance exclusion, the unknown metadata
lease phase fixture, Windows pending-RPC settlement cascades, WMI lateCreate and
historical takeover/fairness/quiet-publication schedules. Their passing appearance
in another CI run is not proof of an exact historical cause. No product-complete
or merge-accepted claim is made.
