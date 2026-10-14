# AB319 isolated archive persistence evidence

Draft PR: https://github.com/rennerdo30/agent-bridge/pull/13

Starting branch `agent-bridge/7e80e1ad` was clean at
`b2ae690a2fd82a7553a30604092b92f52d8d8f32`. After fetching origin, it rebased
onto `7adb4817ea2800e56bd26737a81dbe28d7f17219` before edits. No inherited
source changes or other ref cleanup. Owner exception: `ad385302`.

`toStored` retains undefined optional properties, while the archive decodes JSON
without them. The overflow filter now compares the complete JSON persistence
value. Unknown fields remain part of equality; archive digests, immutable version
storage, ownership rules and reader compatibility are unchanged.

## Fixture and observation boundary

`test/jobs-archive-persist.test.ts` starts ten connected synthetic BridgeNodes
and ten real JobManagers on one isolated fixture broker/home/pipe/database.
Twenty finished jobs include unknown nested fields. Store limit is 1 and archive
age is 1 ms to force this synthetic corpus into overflow; these are fixture
settings, not product acceptance thresholds.

After setup and initial durable archives, the measured loop runs twenty rounds
of ten unchanged `persist()` calls (200 calls). A pass-through spy observes actual
`archiveJobs` invocations; the real SQLite implementation executes. Successful
publication log events and immutable version rows are observed separately.
The CPU profile covers the steady-state loop, excluding fixture startup,
changed-payload tests and bundle generation. The inspector attaches only to the
hosted test process that owns the fixture broker.

Command: `node node_modules/vitest/vitest.mjs run test/jobs-archive-persist.test.ts --maxWorkers=1`

The fixture blob is identical in both revisions:
`e2fe440e9e76984094ce03a7127fb7603b3914bc`.

## Hosted results

| Measurement | Pre-fix | Post-fix |
| --- | ---: | ---: |
| Actual archive calls / successful publications | 200 / 200 | 0 / 0 |
| Immutable versions before / after unchanged loop | 40 / 40 | 40 / 40 |
| Persistence warnings | 0 | 0 |
| Loop elapsed, ms | 1764.177 | 1288.652 |
| Process CPU user + system, ms | 378.666 + 400.122 | 483.015 + 396.346 |
| Per-persist median, ms | 5.208 | 5.902 |
| Per-persist nearest-rank p95, ms | 25.922 | 8.447 |
| Regression | 2 failed at publication assertions | 2 passed |

The pre-fix regression failure is retained as bug reproduction. No duplicate
immutable version insertion was observed. The post-fix regression also proves
exactly one new immutable version for a changed model and exactly one additional
version for new accepted unknown fields, retaining previous versions and exact
new payloads. Readers return the changed record. A live synthetic legacy reader
defers compaction and keeps both compatibility rows through repeated persists.

These are one pair of hosted measurements. Total process CPU increased; median
persist latency also increased. This evidence establishes archive-loop relief,
not an overall CPU or latency budget result. Overall health p95 <100 ms,
dashboard initial <1 s, chat switch <300 ms, zero authority-reader timeouts,
successful handoff and idle broker <5% core require subsequent owner CI evidence.
AB228 and AB215 remain separate gates. The local test slot was deferred when a
host CPU probe reported 100% load, then released; no local tests or profiles ran.

## Receipts

Pre-fix branch head: `5cb142d558d8be379dab3ea0679944e4f58d841c`.
CI merge revision: `0ee77006356e43f78489178d997894e46e2a6b36`.
[Run/job](https://github.com/rennerdo30/agent-bridge/actions/runs/38360360599/job/115172838160).
Artifact `11794671121`, named `ab319-archive-persist-0ee77006356e43f78489178d997894e46e2a6b36`:

- Artifact ZIP SHA256: `fab4a1ccb040ceb9710841b36adb4450aa43c4f0e10c7cbbeada80d35ffc0efb`
- `archive-persist.cpuprofile` SHA256: `630fef829ad8a252f9242668edf6af695252054286e8c0c2ac978bf1ba7d286b`
- `archive-persist.json` measurement manifest SHA256: `88a911b3deae77990d93d0fd38e93b9879268b6d0fc038a2906a743801f2db87`

Post-fix source head: `53b2759b1da776b4ea0af77ca15d69fabfcd5aaf`.
CI merge revision: `dd8e3ef10776bb7674d08d0e4dde52fb6518a3d4`.
[Run/job](https://github.com/rennerdo30/agent-bridge/actions/runs/38360523480/job/115173366179).
Artifact `11794885885`, named `ab319-archive-persist-dd8e3ef10776bb7674d08d0e4dde52fb6518a3d4`:

- Artifact ZIP SHA256: `52b5dc4b4fbe8a6ac921acf8391001c7b8168ac6cfa543c5de24fa866f58cfa7`
- `archive-persist.cpuprofile` SHA256: `714f0f51f7f56914fc206af97088fcf97c78d44ec9c96d3661bc82a4262fbb1b`
- `archive-persist.json` measurement manifest SHA256: `8b7b41545bc2fa65273fe4e1414135a25f0d990b6eca2e8a405ee285dc3b00ff`
- `plugin-bundles.patch` SHA256: `78f92fa206d2ce75190f1482bb4e315f3724e37afacae5c6ecb09a1b7624412a`

The hosted workflow generated the plugin patch only after the post-fix
regression passed. Applying that verified patch produces the separate final
`Rebuild plugin bundles` commit. No local build or installed plugin mutation.
