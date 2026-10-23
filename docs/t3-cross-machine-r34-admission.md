# R34 correction contract before implementation

Base1491d078b042b9ae3eaddcf4b92f8c0bd88e9043. Read full independent R33
AB45843086, including the four source schedules and later P2 evidence. Parent
approved one new60s aggregate mocked/offline/noEmit batch, no native workers,
providers, daemons, TLS, builds, full suites or installed migrations.

1. Broker startup keeps both reserved and directly bound transports tentative.
   A single original check/signal follows every service await and the checks
   before each subsequent effect. TCP/network startup is prepared without
   request authority; activation occurs synchronously only after all preparation
   completes and the original check passes. Abort immediately revokes authority,
   destroys owned tentative sockets and closes only owned listeners. Asynchronous
   service completion after revocation checks before further effects; cleanup
   waits for exact partial resources, never calls late completion success.
   Optional-service errors cannot swallow the admission/cancellation error.
2. Every MessageStore constructor/opener and metadata admission, including an
   existing cached metadata handle, checks the bootstrap journal independently
   of optional cold preparation. The sole initializer exception is synchronous,
   exact home/attempt/preparing-byte witness scoped and nonescaping. Reindex and
   doctor get no exception from omitting startupDeadline. Cleanup of owned handles
   remains possible after refusal; uncertain originals are not removed/repaired.
3. Before any schema effect, directory durability must be supported: synchronize
   the existing home, create/check the private journal directory, synchronize its
   publication in home, then fsync the new record and its containing directory.
   Each entry/descriptor identity is checked around sync; unsupported directory
   flush or any uncertain publication refuses and retains all evidence. File
   fsync is never substituted for directory durability. Windows support remains
   UNVERIFIED; unsupported cold startup is an availability BLOCKER, not a completed
   product behavior. Local tests use an explicitly fake directory-flush transport.
4. Preparing/prepared reads capture exact raw-byte digest and stable path/descriptor
   dev/ino/size/mtime/ctime signatures before and after reading. Prepared retains
   the original preparing witness. Under exact maintenance exclusion after clean
   worker exit, reread and compare BOTH retained records with the original
   snapshots before publishing exited from the fresh read. Immediately revalidate
   the complete ledger before final construction; a missing/replaced/changed row
   is retained/unsettled, never reconstructed from cached JSON. No repeated DDL.

Parent's batched source-only compatibility approval: protocol9/metadata4 because
intermediate protocol8/metadata3 writers ignore this journal, including cached
pre-registration handles not excludable by endpoint probes. Probe p8 endpoints;
refuse metadata1/2/3 automatic shared-home upgrades before schema/journal effects.
Only existing explicit owner-coordinated offline admission in a named isolated
home may migrate old metadata, preserving original rows/snapshots. No automatic
copy/split, environment bypass or claim a version forces old cached writers to
cooperate. Pairing1/SQLite14/JSON4/runner-ledger-v2 remain unchanged.

Required focused schedules: recovery suspended across expiry; TCP preparation
suspended while local ping is attempted; directly bound listener remains tentative;
caller abort versus original deadline; opener without startupDeadline/direct
constructor/cached metadata sees unsettled records; unsupported directory sync and
record-directory failure before DDL; in-place read mutation; removed preparing or
replaced prepared before exact exit/final proof; legitimate complete reconnect;
protocol8/metadata3 refusal and explicit no-loss isolated metadata upgrade.

R33 P2 checklist transport isolation and typed AbortError at1491 remain retained
corrections, not retrospectively reviewed acceptance. All previous unsuccessful
harness attempts remain evidence; earlier aggregate is NOT RECONSTRUCTED. New
checks identify their own frozen head/tree, exact PID/start/end/exit and original
external60s aggregate cap. Protected method deltas require exact normalized
artifacts/parent approval before a separate attributable baseline amendment.
Fresh full independent R34 review and hosted actual-worker/Windows/full/lifecycle
acceptance are mandatory; no merge, release or installed update is approved.
