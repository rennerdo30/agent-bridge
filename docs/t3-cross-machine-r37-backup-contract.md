# R37 backup proof contract proposed for parent review

Base for this correction: `8b586dee20b20154f5602467d59dadc46d2f8e10`.
R36 review at92db was CHANGES REQUIRED, AB-45843252/PR5632437888. The
review schedules are source-derived, not executed acceptance. The separately
approved abortStartup amendment is already isolated atdfd229bf; no further
protected body change is proposed.

## Concrete format fork requiring a parent decision

Recommend a **full-backup artifact format2**, with an independently published
expected-group witness outside the mutable snapshot directory. Local protocol10,
metadata5, pairing1, mailbox schema14, JSON4 and runner-ledger-v2 stay unchanged.
This is an artifact-reader boundary, not a shared-home writer ledger or new
execution authority. No version change or witness implementation has been made
pending this decision.

Proof of need: the old version1 reader at92db accepts ordinary copies after the
whole alternate mailbox plus its self-declared manifest inventories are removed.
A new witness ignored by that reader would leave the same certificate bypass.
Its exact manifest-version check can reject a version2 artifact before effects.
This fixes the older *artifact reader* without claiming a local protocol number
can stop inactive cached writers. Existing shared-home restrictions remain.

Proposed publication and verification:

1. Under the existing storage lease, discover the complete supported group and
   original source identities once. Before payload capture, durably publish a
   bounded immutable witness at `backups/.groups/<snapshot-name>.json`. It records
   the snapshot UUID/name, creation time, full expected database set, mailbox
   namespaces, source identities, original metadata/provenance and original cold
   evidence digests/signatures. Flush file, group directory, backups and home
   entries in dependency order. Retain incomplete/orphan witnesses forever unless
   an explicit owner recovery later authorizes archival; never infer absence.
2. Copy every primary before shared archive. Compare copied payloads/chain to the
   independent witness; recheck source group/provenance before publication. Keep
   existing durable staging/manifest/rename/publication and failure retention.
3. `readBackup` derives the witness key from the actual snapshot directory name,
   never from a manifest-selected path. Require the original separate witness,
   its digest and consistent group/provenance, then require every database in the
   checksum inventory. Missing/moved/replaced witness or entire mailbox refuses.
   Never rebuild a witness from remaining DBs, manifest, cache or publication hash.
4. Existing rotation preserves the stable `.groups` ledger and resolves the same
   witness for `backups/archive/<snapshot-name>`. No witness is rotated away or
   deleted automatically. Export/copy must preserve **both** the snapshot and its
   external expected-group witness; a detached directory is retained but cannot
   be certified. This is an explicit compatibility/availability limit, not a
   restore-generation or reconstructed authority grant.
5. Legacy version1 may remain readable only for independently proven genuinely
   unbound data. Bound/intermediate version1 artifacts retain bytes but do not
   certify the new complete-group contract. Format2 always requires its witness.
   Scoped message snapshots keep their separate kind/version/merge contract.

## Discovery and copied cold proof repair

The parent's subsequent critical qualification supersedes the initial16-byte
proposal: **do not probe arbitrary root-file bytes**, even for format detection.
Exclude credential/token/key/config/private-provider paths before opening them.
Only already proved datafile paths may reach SQLite inspection. Unknown entries
which cannot be classified safely refuse certification. No such discriminator
has been implemented or run.

The remaining concrete design choice is an additive, typed datafile registration
in canonical metadata, published by a fully validated MessageStore before it can
accept traffic. It would retain exact home/file identity, mailbox namespace and
ordinary/cold generation for Unicode/spaces/suffix/case names without reading
unknown files. This is a selection proof, not new recipient or writer authority.
Root enumeration reads names/stat only. Missing registration is not absence or
completeness permission: older/unregistered/ambiguous entries refuse rather than
being scanned or silently omitted. A private/nonportable registered name refuses
backup without changing MessageStore filename support. No registration code is
implemented pending parent clarification of this conservative boundary.

In particular, a partial catalog cannot certify a home by ignoring unproven
private entries: an old writer could have used that production-accepted name.
Without independent safe role evidence, the whole backup must refuse. This may
make normal homes containing token/config files ineligible, so it is an explicit
availability/compatibility decision, not an implicit fallback. Existing JSON
backup code also intentionally captures config.json; whether the new exclusion
applies to all capture or only discovery needs an explicit parent resolution
before changing that established preservation behavior. No private/config value
is accessed during this source-only investigation.

JSON enumeration must not capture a registered SQLite mailbox a second time as
an inconsistent raw JSON file. Bound file counts/record sizes and retain all
unknown/original bytes. No source file is removed, renamed or attributed anew.

Validate the complete copied anchor/preparing/prepared/exited chain using the
original recorded identities, not the copy's new inodes. Bind the actual anchor
digest/signature to independently retained cold metadata provenance; validate
states, attempt/home/main/owner/thread, originals/prepared files, source namespace,
all digest/signature links and exited equality. The external witness records
original source evidence; mutable checksum/publication manifests are not proof
substitutes. This verifier grants preservation only, never opener/restore authority.

## Unaffected repair before that decision

Read-only current-mailbox validation must reject any current-labelled missing/
partial envelope, ownership layout or invalid namespace before metadata/schema/
backup effects. A no-envelope layout is permitted only when actually fresh or
proved metadata-only at mailbox version0. Legacy malformed-mailbox preservation
stays separate; do not create a recovery snapshot as a side effect of refusing a
falsely current layout. Original BLOBs/schema/version/bytes remain unchanged.

The new parent-authorized R37 mocked/offline+noEmit batch is one aggregate60s,
with frozen head/tree, own PIDs, external deadlines and all failed attempts. No
native Worker/provider/daemon/TLS/build/full/local-helper/installed restore or
migration. Windows directory support, bound restore and WMI remain blockers.
