# R37 source candidate and qualified handoff

Final source: `6a64be36c5e11ec718eef65227332878c0286f0a`, tree
`cecdbc8573974b219b083b64b0ddb8d954988f92`. **This final source is NOT tested.**
The tested source is separately frozen at
`667a8f45b67706a037f450113bc3949a829a48c5`, tree
`b388313b37bf78d3039ad7204bf895a026d6d19c`.
Parent owns fresh holistic review and hosted acceptance. PR141 is not hardened,
merge-ready or product-complete. No production Worker/provider/daemon/TLS/build/full-suite,
installed migration/restore or Windows helper was launched here.

## R36 findings repaired in the candidate

AB-45843252 / PR review5632437888 at92db identified four preservation faults:
legal alternate names omitted from discovery; whole ordinary groups removable
from self-declared manifests; copied cold chains not fully checked; and a false
current14 label reaching metadata effects before missing-envelope refusal.

- `mailbox-layout.ts` validates current envelope, ownership/intent/grant tables
  and namespace read-only before metadata initialization. The direct metadata
  boundary uses it too. Current malformed storage refuses without a recovery
  snapshot/schema repair; legacy malformed preservation remains separate.
- A fully constructed persistent MessageStore registers its exact basename,
  home/file identity, namespace and provenance generation transactionally before
  returning/accepting traffic. Cached metadata goes through the same constructor
  registration. Memory-only stores do not invent persistent selection evidence.
  Doctor's direct opener and the ordinary/factory/cold paths share this boundary.
- Catalog selection does not grant mail, writer, reader or restore authority.
  Unknown input names refuse backup without a format/header byte probe. Registered
  Unicode, spaces, case, extensionless and JSON-suffix mailboxes are selected as
  SQLite exactly once; JSON enumeration cannot overwrite that snapshot with raw
  bytes. Registered private/nonportable names refuse backup, not MessageStore
  naming. Source files/proofs are never deleted or silently reclassified.
- Full artifact2 publishes a bounded nofollow external expected-group witness at
  `backups/.groups/<actual-snapshot-name>.json` before payloads. The key comes from
  the actual snapshot UUID/name/root, not manifest input. Root rotation retains
  the same witness; detached copies, missing/partial/replaced witnesses refuse.
  The fixed publication descriptor binds its digest and original file signature.
  All primary mailboxes precede shared archive; source group is checked again.
- Copied verification checks original metadata/cold provenance and the complete
  anchor/preparing/prepared/exited chain, including states, owner/process/thread,
  home/main, original/prepared identities, namespace, digest/signature links and
  exited equality. Copy inodes never become original authority. A reweighted
  mutable manifest cannot supply the independently retained expected group.

Source discovery opens only canonical data roles or admitted registrations.
Known config/private paths are excluded from discovery before open. The existing
explicit `config.json` capture remains; tests use synthetic config only.
Credential/token/key/private-provider capture is excluded. No owner config or
credential values were inspected. Incomplete/uncertain staging and witnesses stay
retained; no unknown automatic reexecution or proof reconstruction is provided.

## Authorized compatibility boundary

Parent approved source-only protocol11/metadata6 for mandatory registration,
including p10 endpoint probes, symmetric exact local authentication and refusal
of automatic shared-home metadata1..5 upgrades before effects. Endpoint absence
and common locks do not prove inactive cached old writers gone. Only the existing
explicit owner-coordinated isolated offline admission remains. Pairing1,
SQLite14, JSON4, runner-ledger-v2 and mailbox ownership capabilities are unchanged.
Full backup artifact2 is a separate reader contract; v1 can certify only an
independently proved unbound legacy set. Bound restore remains unavailable AB-461.

The qualified old/no-registration regression models the 92db source schedule:
an older writer can store a legal private-role filename before canonical metadata
exists; the old regex discovery silently omits it. It uses synthetic native
SQLite fixture data, not a live old binary, provider or installed home.

Source evidence at both original parent70820a0f and tagv0.30.32 is local protocol2,
metadata component1. Thus automatic-upgrade refusal affects real shipping-format
homes, not just development homes. Local protocols3..11 and metadata2..6 here are
unreleased branch states, not evidence of shipped versions. No installed-version
inventory, update or migration was performed. The residual unsupported-old-reader
and cached-writer limitation requires coordinated upgrades, not a claim that a
new number forces an old process to cooperate.

## Exact evidence and its limits

Production source at red head905f563c is equivalent to92db for these mechanisms;
the new regression fixture tracks/closes only its own actual failed-constructor
handles. At905f563c all ten initial R37 cases failed in3.582s/PID79536: four legal
names omitted, whole mailbox removal accepted, anchor/exited corruption accepted,
three malformed current14 layouts failed at a later boundary. This is qualified
source-equivalent red, not an unchanged92db checkout running new tests.

Original R37 batch: **57.740/60s**, all attempts retained. It includes an initial
12.040s harness timeout, later failed corrections, a16.063s incomplete two-module
selection, and an8.043s incomplete final selection. Neither interrupted selection
is green. A completed b82 selection passed14/20; six valid-backup cases were
stopped by the obsolete256-byte v1 descriptor bound.

At exact667a8f45 noEmit passed/PID47528/1.458s. A separately approved ONE12s
allowance finished in10.969s total: **20 R37 cases passed**/PID39904/7.899s and
**one optional-purge owned-resource case passed**/PID64172/2.596s. The52 and8
excluded tests were skipped by selection, not passes. No noEmit rerun occurred.
Raw files begin with commit/tree/PID/time/exit headers. Both budget ledgers,
individual failures, selections and SHA256s are included in the receipt.

The optional-purge fixture now tests the actual worker, not a helper call count:
broker drain calls closeBackups, then legacy store.close invokes it idempotently.
The controlled owned worker must close once, block store close until settlement,
and leave resources cleared. The successful listen promise covers mandatory
recovery/activation, not optional postactivation purge completion. The distinct
mandatory recovery failure/pipe-cleanup fixture remains at its real boundary.
Native metadata unsafe/hot/129/130 observation corrections were source-only here.

### Post-admission delta: UNRUN

No code changed during the admitted runs. Afterward:

1. `4b99f5e2` replaces the interim1024-byte descriptor cap with the exact maximum
   of its fixed JSON encoding: version2, two64-hex digests, five signed-decimal
   strings of at most64 ASCII bytes, plus newline. It rejects extra/missing keys
   and invalid native signature shape. Malformed/oversize negative fixtures were
   added. These changes/tests were **not run**, nor covered by667 noEmit.
2. `6a64be36` stops inferring a fresh catalog solely from canonical-file absence.
   Initial names outside this admitted initializer's exact infrastructure mark
   the source `legacy-unproven`; historical private/unregistered bytes are not
   opened. The catalog requires an `initial` classification; older draft m6
   headers without it refuse rather than being rebuilt. A synthetic private-name
   historical mailbox regression was added, **not run**.

The initial-proof proposal is a review candidate, not an accepted immutable
empty-root proof. Review must examine the actual enumeration/transaction/durable
publication schedule, genuine fresh infrastructure, concurrent additions,
partial/lost/replaced catalog and restart/backup/restore behavior. Existing
headers/rows are preserved on refusal. No further protocol/component bump is
proposed or authorized.

Parser incompatibility is **not** cached-writer exclusion. A previously returned
MessageStore may still use its native statements/accepted-operation paths without
calling registerMailboxDatafile again; existingMetadataDb/metadataDb can return
cached native handles after their reader checks. A backup in flight may already
hold a captured group across awaits. The new parser rejects old proof on a fresh
validation, but does not revoke those live objects. Whether all such schedules
are safely fenced is explicitly **UNPROVEN**, for holistic source review. There
is no assertion here that an added field solves that compatibility boundary.

## Remaining acceptance and retained failures

The separate CI matrix records22 named92db/0e jobs,4940 raw FAIL headers, exact
log hashes/line numbers and every distinct case. Earlier8ed/55b evidence remains
in the immutable R36 matrix. Error records include duplicate cleanup failures;
they are not inflated failed-test counts. Every lane with unhandled rejections
has UNKNOWN coverage. Generic bootstrap refusal is not retroactively labelled
unsupported-directory without inline evidence.

Windows ordinary and cold startup still refuse directory publication; this is
an availability blocker, not an accepted implementation. Full bound restore,
WMI late creation, historical runner exits/fairness/quiet-observer/retained-lock
schedules and pending-rejection ownership remain qualified in the coupling map.
No actual worker, all-platform full/lifecycle/preservation, standalone bundle or
native acceptance is inferred from local mocks. Parent commissions new review
at the final freeze and hosted gates; nothing here authorizes merge/release.
