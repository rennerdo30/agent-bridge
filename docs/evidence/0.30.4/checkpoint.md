# Pre-AB-208 checkpoint

This is incomplete 0.30.4 work on `c5cfd6b`, not a release verdict. AB-208 is now
the first gate and must build on AB-206 from released 0.30.3. No live storage or
installation was changed; generated evidence is retained outside repositories.

## Current evidence

- Exact cancel/continue worktree regression passes against inherited identity
  file leases, preserving native context, worktree bytes and ownership archives.
  It must be adapted and rerun through AB-208 row leases.
- Survivor-report continuity test and actual generated worktree-process probe
  pass; the probe does not terminate anything or infer ownership from association.
- Two TLS instances, 8 MiB transfer and 60 ms delayed ACK fixture: serial window
  1 takes 2658.54 ms (3.01 MiB/s), window 8 takes 684.54 ms (11.69 MiB/s).
  Maximum concurrent message latency is 13.79/11.81 ms; SHA-256 matches. Exact
  live paired-PC review steps are filed on AB-183.
- Read-only legacy-lock report: actual Windows open-handle detection, exact
  job/worktree-state match, unknown-owner retention, unchanged bytes and rejected
  action flag regressions pass. Owner command is filed on AB-187. No live report
  or reconciliation was run.
- Version audit and immutable Action pins are documented in `version-audit.md`.
  Two newer advisory fixes remain excluded by the owner's two-week age limit.
- Typecheck and four-plugin build succeeded. First serial Windows full suite:
  1609 passing, one five-second detached startup-link deadline failure, two
  skipped. All seven handoff cases then passed unchanged on focused rerun. This
  is not a green full-suite verdict; final post-AB-208 full suite/CI remain required.

## AB-147 measurements and limitations

Actual compiled MCP worker/runner fixtures use Node 26.4.0, 17 MCP workers
(one broker plus 16 sessions), seven detached runners and a generated provider.
Both settle seven seconds and sample Windows process counters for about 30
seconds. These are early quiet fixtures, not the owner's populated-store
acceptance; no real provider/model calls occur.

| Role | Before mean RSS MiB | After mean RSS MiB | Before aggregate CPU ms | After aggregate CPU ms |
|---|---:|---:|---:|---:|
| Broker (1) | 89.52 | 88.20 | 46.875 | 62.500 |
| Sessions (16) | 84.41 | 82.52 | 78.125 | 312.500 |
| Runners (7) | 82.64 | 77.26 | 140.625 | 312.500 |

Elapsed measurement windows: 30.710/31.455 seconds. RSS fell in this pair; CPU
did not. Near-idle Windows CPU quantization, startup/GC timing and shared
machine activity limit these numbers. No CPU reduction is claimed. Earlier
module-surface fixtures are weaker evidence and are not substituted for this
pair. Repeat after AB-208 with a populated, fully settled store and heap evidence.

The fifty-job load has not passed: the latest retained run reports two hook
connect deadlines, event-loop p95 56.89 ms, p99 124.58 ms, 908 deliveries and
active retained-history backfill. Request deadlines and latency assertions were
not relaxed. Its synthetic peer/store versions need review: unversioned jobs
and unknown reader capability records caused upgrade deferral and repeated
durable receipts. The harness's separate contention probe also renamed one
hard link of a live lease; this was corrected to owner release/archive. Future
load fixtures must use AB-206/208 admission and rows instead of silently
reconciling legacy storage. Setup migration wait alone increased from 60 to
120 seconds before the timed window.

## Pending

AB-208 implementation and migration/latency matrix; AB-182 row-lease recovery;
AB-147 zero-failure load and settled CPU/heap comparison; final full suite;
origin v0.30.3/green CI rebase; release commit/main push/tag and all-platform CI;
owner paired-PC and installation acceptance. Issues remain in progress with
open plan gates; none is marked passed or handed over as an accepted release.
