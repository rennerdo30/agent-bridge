---
title: "Finished job outcomes"
slug: job-outcomes
---

`GET /api/job-outcomes` uses the dashboard's existing loopback Host check and
`ab_ui` authentication cookie. An unauthenticated request receives HTTP 403.
`?job=<name>` and `?run=<name>` select one finished record before Git derivation.
They return the same response envelope and `contractVersion`, with one populated
entry, empty other collection, and `next: null`. An unknown or unfinished name
returns 404; supplying both filters returns 400. Paired-PC reads accept these
filters too. Run lookups read only the selected log body and retain next-turn
receipt boundaries from metadata whenever receipt evidence exists. An empty
receipt snapshot stays unknown without reading unrelated metadata. Ordinary
loose and packed Git heads are read directly; symbolic refs and alternate Git
layouts use Git. The 700-run regression checks both lookups within one second
for merged and unmerged branches, including packed refs, without a stale cache.

It returns JSON with `contractVersion: 1`:

```ts
interface Outcome {
  delivery: {
    status: "unknown" | "delivered" | "read";
    messageId: string | null;
    recipient: string | null;
    deliveredAt: number | null;
    readAt: number | null;
  };
  merge: {
    state: "merged" | "held" | "unmerged" | "discarded";
    branch: string | null;
    baseBranch: string | null;
    branchHead: string | null;
    reason: string | null;
    checkedAt: number;
    decisionAt: number | null;
    decisionBy: string | null;
  };
}
interface Response {
  contractVersion: 1;
  jobs: Record<string, { startedAt: number; status: "done" | "failed"; outcome: Outcome }>;
  runs: Record<string, Outcome>;
  groups: { needsReview: string[]; held: string[]; merged: string[]; discarded: string[] };
}
```

`jobs` keys are job names, including archived finished jobs. `runs` keys are the
dashboard's recent finished run log names, without `.log`. `groups` contains job
names grouped by merge state; `needsReview` means `unmerged`. Timestamps are Unix
milliseconds. Unknown historical timestamps and identities are `null`.

Delivery means the result reached the supervisor's durable bridge queue or local
inbox. Read means bridge consumption through a hook, channel, or tool; it does
not prove that the supervisor reviewed the work. Broker results reuse durable
`read_at` receipts from active and archived messages. Local results retain
delivery records and use the existing read journal for consumption receipts.
Historical read journal entries without timestamps still mean `read`, with
`readAt: null`. A missing receipt means `unknown`, not a lost result. Progress,
approval messages, sibling copies, and results outside a run's time window do
not count as that run's result.

Merge state is derived by testing whether the job's branch tip is an ancestor
of its recorded local base branch. New runs save the final branch name and tip,
so ancestry can still be checked after cleanup removes the branch and worktree.
Missing Git evidence conservatively gives `unmerged` with an explanatory reason.
An explicit supervisor decision takes precedence over Git ancestry.

Requester records marked `remote` keep delivery unknown and merge `unmerged`
with a paired-PC evidence reason, unless the supervisor explicitly held or
discarded them. Remote paths and receipt namespaces are never tested against
local Git or local message rows. Paired-PC outcome evidence needs integration
with the remote-jobs contract.

The supervisor MCP tool is:

```json
{"job":"codex-job-deadbeef","state":"held","reason":"Wait for CPU A/B"}
```

Call `set_job_outcome` with a job name or ID, `state: "held" | "discarded"`, and
an optional `reason`. A hold requires a nonblank trimmed reason of at most 2000
characters. Only the job's owning supervisor may set outcomes, and only for
`done` or `failed` jobs. Delegated sessions do not receive this tool. Its result
is an MCP text block containing JSON `{ job, outcome }`; validation and ownership
failures return an MCP error. The tool records a decision and does not delete or
merge anything. A continued job has a separate decision keyed by its new start
time. Earlier decisions stay in history.

JSON store format 2 is an additive upgrade from format 1. Reads derive legacy
values without rewriting old run files. The first upgraded write backs up the
old bytes and retains unknown fields through the existing atomic writer. Future
store versions are not overwritten. Supervisor decisions live in
`job-outcomes/<hash-of-job-and-start>.json`; local delivery evidence lives in
`local-result-receipts/<hash-of-job>/<hash-of-message>.json`. Archives remain
readable. No dashboard page source changes are included; the endpoint is the
contract for dashboard integration.
