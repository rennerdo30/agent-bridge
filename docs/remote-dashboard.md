# Paired dashboard reads (`dashboard-read-v1`)

AB-94 adds read-only inspection of a paired PC through the existing TLS PSK link.
Both elected brokers must advertise `dashboard-read-v1`; update/restart hosting
sessions on both PCs after upgrading. This does not require another HTTP listener
on the remote PC. The local dashboard still requires its `ab_ui` token cookie and
checks the HTTP Host header before any proxy call. Message sending remains the
existing broker operation; this protocol has no write commands.

## HTTP contract for the page

Use `encodeURIComponent()` on the entire remote identity, including its slash.
For example, `Desktop-PC/session` becomes `Desktop-PC%2Fsession` in one segment.
Run and job names returned by the API already have this prefix.

| GET route | Parameters | Response |
| --- | --- | --- |
| `/api/state` | none | Local state plus remote first pages (details below) |
| `/api/runs?host=Desktop-PC` | `limit`, `before` | `{runs, next, total, host}` |
| `/api/runs/Desktop-PC%2Frun-name` | `from` | `{text, next, size, host}` (byte offsets) |
| `/api/runs/Desktop-PC%2Frun-name/chat` | `from` | `{items, next, host}` |
| `/api/runs/Desktop-PC%2Fjob-name/chat` | `from` | Same chat, using latest run for that job |
| `/api/sessions/Desktop-PC%2Fsession/chat` | `from` | `{items, next, host}` |
| `/api/sessions/Desktop-PC%2Fsession/subagents` | none | `{subagents, host}` (native CLI children) |
| `/api/sessions/Desktop-PC%2Fsession/subagents/child-id` | `from` | `{items, next, host}` |
| `/api/jobs/Desktop-PC%2Fjob-name/subagents` | none | `{subagents, host}` (native children of the job's CLI session) |
| `/api/jobs/Desktop-PC%2Fjob-name/subagents/child-id` | `from` | `{items, next, host}` |
| `/api/job-outcomes?host=Desktop-PC` | `limit`, `before` | `{contractVersion, jobs, runs, groups, next, host}` |

Individual reads also accept a literal `Host/name` path. Prefer the encoded form.
Local routes keep their existing response fields. Outcome responses add `next`
and are now bounded pages locally too; the default page contains at most 50
distinct job/run keys, with a maximum `limit` of 500. Outcome `before` is the last
lexically ordered native key; run-list `before` is the existing time/name cursor.
Send returned cursors unchanged, with the same `host`. Cursors and native child
IDs are **not** prefixed. Transcript readers retain their own cursor formats.
Never concatenate a host onto a transcript child ID.

`/api/state` retains local `runsNext` and `runsTotal`. Its `runs` includes the local
first page followed by each successful remote first page; `jobs` includes remote
saved settings with prefixed keys. Additional fields:

```json
{
  "remoteRuns": {
    "Desktop-PC": {
      "runs": [], "runsNext": null, "runsTotal": 0, "jobs": {}, "host": "Desktop-PC"
    }
  },
  "remoteErrors": {}
}
```

Use `remoteRuns[host].runsNext` to load more with
`/api/runs?host=<host>&before=<cursor>`. The first-page settings map contains jobs
represented on that page. Do not use a remote cursor for the local list.
`remoteErrors[host]` holds an error body for unavailable/mixed-version peers;
one peer's failure does not discard local state or successful peers' pages.

All returned remote containers and list/map items have `host`. Run `name`, `job`,
`by`, `owner`, `parentJob`, and `rootName` are host-qualified, as are job/outcome
map keys and outcome group entries. Already qualified cross-PC owner names stay
qualified. Filesystem paths, branch names, transcript IDs and cursors remain
native values; paths are informational and cannot be used as read targets.

Live runner advertisements include `jobAgent`, `jobParent` (owner name),
`parentJob`, `rootSession`, `rootName`, `subagent`, `title` and `jobTitle`.
`rootSession` identities are prefixed with the instance UUID; name fields use
the instance name. `/api/state.peers` marks runners `subagent: true` and sets
`parent` to the parent job when present, otherwise the owning session name.
Older runners gain lineage from their durable local job record where available.
Local runners receive the same dashboard classification, while normal broker
session lists keep their existing routing behavior.

Errors retain the local reader's HTTP status and `{error}` for missing records,
unbound sessions and invalid cursors. Link errors have `{code, error, host}`:

| Status | Code | Meaning |
| --- | --- | --- |
| 409 | `remote_update_needed` | Connected peer lacks the capability (or local broker needs restart) |
| 503 | `remote_offline` | Known pair disconnected or broker unavailable |
| 404 | `remote_offline` | Unknown/unpaired host |
| 504 | `remote_timeout` | No response within 10 seconds |
| 429 | `remote_busy` | 32 requests already pending |
| 429 | `remote_rate_limited` | Peer exceeded 120 reads per 60 seconds |
| 413 | `remote_response_too_large` | JSON result exceeds 1,500,000 bytes; reduce page limit |
| 500 | `remote_read_failed` | Remote reader failed |

Errors returned by an unavailable local broker may omit `host`. No POST route is
proxied by this protocol. The page should surface update/offline errors rather
than display an empty conversation as a successful read.

## Extension wire contract

Network frame type: `dashboard-read`. Both directions use `sendExtension` after
capability negotiation and authenticated pairing. Requests contain only a local
dashboard route and bounded string query fields, never a directory or arbitrary
file name. Unknown fields and routes are rejected.

```json
{"type":"dashboard-read","payload":{"kind":"request","rid":"<uuid>","request":{"path":"/api/sessions/session/chat","query":{"from":"0"}}}}
{"type":"dashboard-read","payload":{"kind":"response","rid":"<same uuid>","result":{"status":200,"body":{"items":[],"next":"0"}}}}
```

Allowed paths are the table's reads without a host prefix/query, plus `/api/state`
(a read-only projection of `{runs, runsNext, runsTotal, jobs}`). Response bodies
are exactly the shared local handler's shape. Host marking is applied by the
requesting HTTP dashboard, not transmitted as part of the remote answer. A
response is accepted only from the authenticated instance associated with its
pending UUID. Requests expire after 10 seconds; shutdown settles pending reads
as offline. Invalid wire requests with a valid request UUID receive 400
`bad_request`. Response bodies are capped below the link's 2 MiB frame limit.

Run pages default to 50 and cap at 500 entries. Log chunks read at most 128 KiB
and end on UTF-8 character boundaries. Transcript reads use the existing 512 KiB
reader window, bounded text/tool previews and maximum 200 native children.
Large JSON expansions return 413 rather than an oversized frame. The only data
sources are the remote dashboard's run/job stores, outcome evidence and supported
CLI transcript readers. Corrupt outcome reads do not repair or move owner data.

## Verification

`test/remote-dashboard.test.ts` uses two in-process TLS PSK links and paired
brokers with short native temp paths. It verifies parity with local handlers,
paging, UTF-8 chunks, native child membership, strict routes, timeout/rate limits,
old-peer fallback, advertisements/classification, encoded HTTP identities, token
authentication and read-only routing. Browser layout and real two-PC acceptance
remain the supervisor's UI/playtest work.

## Job completion estimates

`report_progress` accepts optional `eta_minutes` (0-1440, fractional minutes allowed).
The parent computes `etaAt` (estimated completion epoch milliseconds) and
`etaReportedAt` (report receipt epoch milliseconds). Omitting an estimate keeps
the last one; reporting it again replaces both timestamps. Zero means due now.

`/api/state.runs[]` exposes these optional fields beside `percent`, `progressNote`
and `progressAt`. The remote projection keeps the same values in merged `runs[]`
and `remoteRuns[host].runs[]`; host qualification does not alter timestamps.
They also travel in job records, runner state and remote-jobs snapshot `state`.
Older records and peers may omit both fields. No stored envelope version changes.
Finished jobs and runs clear both fields; stale terminal run metadata is hidden
on read. `peers` displays the remaining time rounded up to minutes and clamped
at zero. Dashboard rendering is handled separately.
