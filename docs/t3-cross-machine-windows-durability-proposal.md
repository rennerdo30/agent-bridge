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
