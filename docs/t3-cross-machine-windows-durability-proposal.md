# Windows directory publication: bounded feasibility proposal, not a fix

AB-458/R36. No native helper, installation, launch, build or filesystem experiment
is authorized by this document. Protocol10/metadata5 and all existing gates stay
unchanged. Windows ordinary/cold startup and provenance-bound full restore remain
availability blockers. Explicit classified55b failures are retained in the R36
matrix; generic older failures are not retroactively assigned this cause.

The existing Node O_DIRECTORY/fsync transport refuses Windows. Replacing it with
file fsync, success based on an absent endpoint or a mock would violate the
approved durable-before-effects contract. A new directory, its parent entry,
anchor/journal, preparing/prepared/exited records and final backup rename all
need durable publication, not merely an atomic name visible to the live process.

## Source-backed limits

Microsoft documents that [FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)
needs writable access; whole-volume flushing requires administrative privileges.
That option is excluded. [Directory handle documentation](https://learn.microsoft.com/en-us/windows/win32/fileio/obtaining-a-handle-to-a-directory)
allows obtaining a directory handle but does not establish a FlushFileBuffers
directory-publication guarantee. This absence is a proof gap, not proof that
every Windows filesystem lacks a mechanism.

[NtFlushBuffersFileEx](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntflushbuffersfileex)
documents normal-mode data/metadata/cache synchronization and weaker optional
flags. Its published requirement is a kernel interface; that documentation alone
does not prove a supported non-elevated user-mode adapter or directory semantics.
Do not use undocumented dynamic exports, weak flags or a driver installation as
an automatic production fallback. [MoveFileEx](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexa)
write-through documentation also does not establish the complete ancestor-chain
guarantee needed here. A successful rename test is not a power-loss proof.

## Proposed independently reviewed stage

Approve only source/CI feasibility of a small non-elevated Windows directory
durability adapter, conditional on a supported API/OS/filesystem proof. If that
proof cannot be established, stop with the availability blocker and a concrete
unsupported result; do not integrate a weaker success path. No helper has been
written or launched in this batch.

Dependencies would be Windows SDK/MSVC on hosted CI, source-reviewed C++ and
explicitly built x64/arm64 artifacts. No package installation into consumer
homes, PowerShell/WMI, elevated helper, daemon, runtime download, PATH lookup,
kernel driver or ambient executable selection. Artifact identity must be tied to
the release build and reviewed separately; no release is authorized here.

The bounded adapter interface would accept a nonce, exact current home/ancestor
file IDs, volume/filesystem evidence, at most64directories and the original
remaining startup deadline. Fixed-size responses contain only stage/category,
identity agreement and handle-close outcome, never credentials, mailbox bodies
or arbitrary native error text. It opens directories without following reparse
points, checks handle/path identity before and after each publication barrier,
rejects unsupported or changed paths and never opens/migrates a mailbox database.

The parent owns its exact PID and all opened resources. Cancellation/deadline
revokes the request before any later phase; close/exit evidence is awaited before
admission. Unknown/late completion leaves existing evidence unsettled, not a
retry or compatibility grant. A separate reviewed containment mechanism is
required if the chosen syscall cannot meet cancellation/exit accounting; a
timeout alone does not stop an uncancellable native effect. No foreign/shared
helper may be terminated.

Asynchronous integration must cover ordinary metadata initializers, direct and
factory openers, workers, backup publication and explicit offline paths. A
synchronous metadata caller cannot silently spawnSync a helper or borrow cached
directory proof. Any preparation must remain under the existing common exclusion,
fresh reader/endpoint checks and one outer10s budget; final admission remains a
genuinely fresh min(2s,outerremaining) proof. No provider/request/listener authority
before exact helper settlement and final proof. Metadata1/2/3/4 and schema2/3
automatic upgrades stay prohibited. No new gate is proposed without a separately
demonstrated older-writer bypass.

Acceptance requires review of the API guarantee plus hosted non-elevated Windows
NTFS/reparse/ACL/unsupported-volume tests, failure after each parent/record/rename
phase, cancellation/late-native-effect ownership, old-writer exclusion and the
actual preservation/lifecycle/full suites. Mocked success, ordinary file flush
or one green workflow cannot certify portable durability. This proposal requests
a scoped next-stage decision; it does not resolve Windows availability.

## Parent-authorized proof research, 2026-10-24

Parent approved source/documentation and hosted-CI feasibility research only,
not adapter implementation, integration, enablement or local launches. The
specific combined guarantee is still **UNPROVED**. No adapter source, binary,
dependency, new OS state, workflow build or hosted execution was added here.

| Documented candidate | Actual documented guarantee | Missing contract / decision |
| --- | --- | --- |
| CreateFile/FlushFileBuffers | Regular-file data/cache flushing and write-through metadata semantics; volume flushing requires elevation. | A directory handle does not by itself prove a supported barrier for every newly created ancestor. File flush is not substituted for this proof. |
| User-mode NtCreateFile | Microsoft explicitly documents this user-mode API and directory/write-through options. | Directory-compatible options do not establish a flush of all prior parent entries. Its documented directory option list also does not list OPEN_REPARSE_POINT. Do not infer safe nofollow composition or dynamically use an undocumented flush export. |
| KTM/TxF commit | Microsoft describes flushing undo, actual changes and a commit record. This is substantive durable-transaction evidence, unlike plain rename atomicity. | Local NTFS only, unsupported on other filesystems/network volumes/shared-writer scenarios; Microsoft recommends alternatives. Its timeout does not abort after the prepared point. Hard deadline/late-commit containment is not proved. Not selected as a production fallback. |
| Cancellation/process termination | Cancellation requests and process termination are documented. | Neither establishes bounded completion of pending kernel I/O. A success return from cancellation/termination cannot become an exit, rollback or no-late-effects witness. |

References and scope of the conclusions:

- [NtCreateFile user-mode reference](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile)
  distinguishes directory access/options from ordinary file access and supports
  relative opens through an existing parent handle. It does not document the
  complete proposed publication-plus-cancellation barrier. This is a proof gap,
  not a claim that the user-mode function is itself undocumented.
- [TxF commit sequence](https://learn.microsoft.com/en-us/windows/win32/fileio/performance-considerations-for-transactional-ntfs)
  documents durable commit work; [unsupported TxF scenarios](https://learn.microsoft.com/en-us/windows/win32/fileio/when-to-use-transactional-ntfs)
  constrain filesystem and writer scope. The [CreateTransaction timeout](https://learn.microsoft.com/en-us/windows/win32/api/ktmw32/nf-ktmw32-createtransaction)
  applies only before preparation. [CommitTransaction](https://learn.microsoft.com/en-us/windows/win32/api/ktmw32/nf-ktmw32-committransaction)
  does not supply an overriding deadline/abort guarantee.
- [Microsoft's TxF alternative guidance](https://learn.microsoft.com/en-us/windows/win32/fileio/deprecation-of-txf)
  argues against a new dependency and discusses database-oriented alternatives.
  No dependency on TxF is proposed for integration without a separate decision.
- [CancelSynchronousIo](https://learn.microsoft.com/en-us/windows/win32/api/ioapiset/nf-ioapiset-cancelsynchronousio)
  can race normal completion and does not wait for it.
  [TerminateProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess)
  is asynchronous; exit waits for pending I/O completion/cancellation. Thus an
  owned helper plus kill request alone cannot prove settlement within10s.

### Alternative architectures for an owner decision

1. **Consolidated durable authority/data in already provisioned storage.** Design
   a transactional database representation for evidence, pending work and data
   whose recovery does not depend on a newly published directory per operation.
   It still needs independently durable initial provisioning and absence/restore
   detection; moving the same bytes into a new DB does not solve those boundaries.
   This would be a separate migration and compatibility design, not a change
   authorized here. No automatic copy, split or reclassification is proposed.
2. **Explicit isolated offline provisioning on unsupported Windows homes.** Keep
   automatic startup refused and require a separately reviewed owner-run contract
   proving the initial durable home/files. An attestation or missing endpoint
   alone cannot prove it. This retains an availability limitation rather than
   calling cold startup fixed. No installed provisioning is authorized here.
3. **Retained native-settlement ownership rather than guaranteed hard termination.**
   A future reviewed design could refuse startup by the original deadline while
   retaining exclusion and exact pending-resource accounting until native work
   actually settles, with no request/provider authority or automatic reexecution.
   That is a change to the worker lifetime/containment contract and needs explicit
   owner/design approval. It cannot silently widen startup or permit late schema
   phases. TxF's support/deprecation limitations would still remain.

Recommendation: do not implement an adapter with the evidence currently found.
Keep the Windows availability blocker explicit and take one concrete alternative
through independent design review before code. This research neither changes the
durability requirement nor proposes another protocol/component increment.
