# History directory failure contract — planning only

Candidate source pin: `b698835e2b7a7f16ee5d568da5dea30dee359fc1`.
Governing contracts: lifecycle prerequisite `2ce8055a58941a1bd90f92d43374e7adc3309be0`
and MessageStore closure proposal `57f986496489185172276caeea8ae0d9f0753fbb`.
This document grants no implementation, census, cold preparation or retirement
permission. Directory bookkeeping and the failed-open provenance primitive are
UNIMPLEMENTED. In particular, `no_resource` remains UNSUPPORTED.

## Pinned implementation evidence

The package requires Node >=22.16. These inspected releases cover the minimum
Node 22 implementation and selected Node 22/24 implementations; they are not an
attestation of every intervening release or of an arbitrary running executable.
The libuv versions below come from each same-commit `deps/uv/include/uv/version.h`.
Node-bundled libuv, rather than a moving upstream libuv branch, is the evidence.

| Node release | Immutable Node commit | Bundled libuv | JS opener / C++ sync opener | POSIX / Windows open implementation |
| --- | --- | --- | --- | --- |
| 22.16.0 | `9774069718d9f80578079d252dddf37ae6fd550d` | 1.49.2 | `dir.js:331`, `node_dir.cc:405` | `unix/fs.c:605`, `win/fs.c:1556` |
| 22.23.0 | `eb77496085a730a72939ef32a90b841f344eb4b0` | 1.51.0 | `dir.js:356`, `node_dir.cc:405` | `unix/fs.c:599`, `win/fs.c:1569` |
| 24.0.0 | `c5349f43cd66d2aa02d86414c9ed426f71d3ae48` | 1.50.0 | `dir.js:331`, `node_dir.cc:399` | `unix/fs.c:605`, `win/fs.c:1569` |
| 24.21.0 | `955266bfdd854cd280dffd47548673914484e4c0` | 1.52.1 | `dir.js:356`, `node_dir.cc:399` | `unix/fs.c:595`, `win/fs.c:1619` |

Each path resolves within the listed commit. Full paths are
`lib/internal/fs/dir.js`, `src/node_dir.cc`, `deps/uv/src/unix/fs.c`, and
`deps/uv/src/win/fs.c`.

The JS opener validates its arguments, obtains a native handle, then constructs
the JS `Dir`. Thus an exception from the whole JS call is not inherently proof
that the native operation failed: a resource may already have been obtained.
The C++ synchronous opener throws on a negative libuv result before creating the
Node `DirHandle`. On a successful result it constructs and returns that handle.
These are distinct boundaries. See the pinned [Node 22 JS opener](https://github.com/nodejs/node/blob/9774069718d9f80578079d252dddf37ae6fd550d/lib/internal/fs/dir.js#L331)
and [Node 24 C++ opener](https://github.com/nodejs/node/blob/955266bfdd854cd280dffd47548673914484e4c0/src/node_dir.cc#L399).

On POSIX, the bundled operation allocates its directory structure and attempts
the OS directory open. The inspected failure branch frees the structure and
clears the request pointer. This supports a no-directory-resource conclusion for
that actual native failure branch, not for any JS exception with a similar code.
See [Node 22 bundled POSIX implementation](https://github.com/nodejs/node/blob/9774069718d9f80578079d252dddf37ae6fd550d/deps/uv/src/unix/fs.c#L605).

On Windows, the inspected failure branch frees its allocated structures and
clears the request pointer. Separately, `ERROR_FILE_NOT_FOUND` from enumeration
can be a successful empty-directory open, with a directory structure returned;
it must not be classified as failed-open absence. A successful empty directory
still needs its actual close. See [Node 24 bundled Windows implementation](https://github.com/nodejs/node/blob/955266bfdd854cd280dffd47548673914484e4c0/deps/uv/src/win/fs.c#L1619).

## Original opener provenance is a separate unresolved requirement

Comparing the imported `opendirSync` to
`process.getBuiltinModule('fs').opendirSync` proves only equality of those current
references. Builtin CommonJS exports are mutable. An early replacement can be
present in both references before the owner captures them. Later
`syncBuiltinESMExports()` can propagate modified CommonJS exports to ESM bindings.
A private snapshot obtained after replacement does not establish pristine origin.
Function name, source text, property shape and equality cannot repair this gap.
The official [builtin ESM synchronization contract](https://nodejs.org/api/module.html#modulesyncbuiltinesmexports)
documents this mutation behavior; it is not an original-function attestation API.

No source-owned trusted-opener witness is implemented or approved by this
document. A future proposal must establish the exact invoked binding's original
provenance, its lifetime and invalidation, and distinguish native failure from
failure after a native resource was obtained. It cannot accept caller factories,
booleans, error objects, receipt tuples, names or a function-equality check as
that witness. It must account for early replacement and ESM synchronization and
the supported executable/loader profile. No broader external-fault exception is
invented here. If this proof cannot be established within the approved scope,
failed-open resource disposition stays unknown and supported closure refuses.

Error code, errno, syscall and requested-path correspondence may corroborate a
proved native boundary. They remain private and are never sufficient authority
on their own. Missing JS objects and pre-open path checks are also insufficient.
Other errors, substituted bindings and unrecognized runtime implementations stay
unknown; no additional filesystem probes, repair or alternate opener is proposed.

## Proposed exact records and transitions

One source-owned record is created before each actual entry. It binds a nonreused
attempt identity to the actual index/accepted-operation generation and requested
entry, keeping paths private. Any returned `Dir` is attached to that exact record
before reads, initialization or exposure. Observations read only these records.
They do not perform directory or SQLite probes and cannot attest a complete owner
census. A bounded manifest must retain all records on overflow and refuse rather
than silently truncating membership into completeness.

| State / event | Required disposition |
| --- | --- |
| `not_attempted`, source refuses before native entry | Retire only that exact proven unentered record; no resource or completion is invented. |
| Native entry begins | Mark `attempted_unconfirmed` before entry. |
| Actual `Dir` returns | Attach it before any next action; mark `returned`, with close not attempted. |
| Original native failure with independently established provenance and failed-open resource proof | A future reviewed `no_resource` transition may be possible; currently unsupported. |
| Exception without the two proofs, including an ENOENT-shaped wrapper exception | Retain the exact attempt as unknown. Do not infer no resource from the missing return value. |
| Failure after an actual source-captured `Dir` returns | Retain that exact object and record. It cannot become `no_resource`. |
| Exact source-owned close begins | Record attempted before the original native close. |
| Actual close returns successfully | Record that specific completion only; no broader settlement, lease or retirement permission follows. |
| Close throws before or after possible native disposal | Retain unknown outcome, without retry, reuse or inferred closure. |

Resources known only to an injected wrapper must be retained by the isolated
fixture that obtained them. The source retains its uncertain attempt; it must
not fabricate a native object it never received. An actual source-captured
resource remains strongly retained through uncertainty. External disposal cannot
acknowledge the source's record or renew authority.

## Discovery semantics and future fixture gate

The existing discovery catch/continue remains unchanged. Failed-open accounting
does not clear accepted discovery, pending history rows, cursor work or timers,
and does not turn the existing continuation into proof of settlement. Partial
walks keep their actual directory object and queue. Original shared 2s/10s budgets
remain; expiry is refusal with retained work, never exit or cleanup permission.

Before any future classification implementation, owned hosted Node 22/24 cases
must establish: actual missing-directory failure at the original boundary;
actual returned empty-directory close; actual retained partial walk; an explicitly
SIMULATED wrapper obtaining a real directory then throwing ENOENT; an injected
error before entry; early mutable-builtin replacement; ESM synchronization of a
replacement; real read failure after capture; and SIMULATED close failure before
and after actual disposal. Cases must preserve catch/continue behavior and all
accepted work and prove that substituted/unconfirmed outcomes stay unknown.
Fixture disposal is restricted to its exact actually owned resources, with actual
close evidence. It cannot mint source proofs or fake exit/settlement, and it must
not probe live owner directories. No case has been executed for this proposal.

The next gate is independent contract assessment and an explicit narrow source
authorization. Until then there is no directory bookkeeping source change,
`no_resource` implementation, supported closure or positive retirement claim.
