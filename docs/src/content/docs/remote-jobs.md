---
title: "Jobs on a paired PC"
---

Pair the two instances first. The PC that will run the jobs must enable remote
jobs in its own `config.json`. Every pair is denied until its instance name is
explicitly listed. A minimal policy is:

```json
{
  "network": {
    "enabled": true,
    "name": "mac",
    "remoteJobs": {
      "enabled": true,
      "allowRoots": ["/Users/owner/projects"],
      "agents": ["codex", "opencode", "claude"],
      "allowPeers": ["windows"]
    }
  }
}
```

All four remoteJobs settings default to disabled or empty. The broker reads this
policy for each request; agent executables and defaults come from the remote
PC's config. The requester cannot supply an executable, environment, script or
runner specification. Access levels retain each agent's existing semantics.
Provider approval support is the same as for local delegation.

`spawn_codex`, `spawn_opencode`, `spawn_claude` and their `ask_*` equivalents
accept `host: "mac"` and an absolute `cwd` on that PC. The other public spawn
arguments work as usual. `send_to` grants are local-only and rejected remotely.
Use `message_subagent` with the returned job name (or `mac/<remote job name>`)
for messages, approval answers, titles and next-turn settings. `cancel_subagent`
stops the remote job. A remote PID is never signalled on the requesting PC.

Worktree jobs create `worktrees/<repository>-<job>` beneath the allowed remote
repository. The source repository, git metadata and generated checkout must
stay within allowRoots. Canonical paths reject traversal and symlink/junction
escapes. Continuations use the remote registry's saved session and worktree;
requesters cannot import an unrelated remote session by passing session_id.

The remote broker records ownership by pinned pair identity and stable
supervisor identity. It keeps `remote-jobs.json` and the normal runner state and
run logs. The requester keeps its normal jobs store, cached remote states and
mirrored run logs. Both sides log spawn and control activity. The remote
broker limits requests to 600 and spawn attempts to 10 per pair per minute,
honours its configured maxJobs and bounds its registry to 200 jobs.

## Link contract

Hello advertises the additive capability `remote-jobs-v1`. The authenticated
TLS extension frame is `{ "type": "remote-job", "payload": ... }`:

- Requests have `kind: "request"`, UUID `rid`, broker-authenticated `peer`
  (`id`, `name`, `supervisor`) and a strictly validated `request`.
- Operations are `spawn` (`job`, `target`, public `args`), `state` (`job`),
  `control` (`job`, validated runner control) and `approval` (`job`, approval
  `id`, `decision`, optional reason).
- Responses have `kind: "response"`, matching `rid` and either `value`
  (`state`, `alive`, public `approvals`) or a bounded `error`.

Progress notes and reports use normal namespaced bridge messages. State polls
refresh every two seconds. The additive AB-85 `file-stream-v1` capability and
`file-stream` frames share the bounded extension transport independently.
Missing remote-jobs capability returns an explicit update-needed error.
Spawn timeouts are ambiguous: check the paired PC before retrying. Ownership
prevents a retry from starting a duplicate live runner with the same job id.
Disconnected links have no durable outgoing command spool; cached states
expire after 90 seconds. Detached remote runners continue while a requester
reloads; the requester can reattach with its persisted supervisor identity.

Approvals use the AB-81 registry on both PCs. The requester publishes the public
approval with its local supervisor owner and job `host/name`; private HTTP
tokens stay in the local home. An answer routes to the exact remote approval
and returns only after its acknowledgement. Expired approvals never become
follow-ups. Sibling chat cannot supply supervisor control or approval answers.

## Dashboard contract

Existing authenticated `GET /api/state` includes mirrored remote jobs in
`runs`. Each remote run adds:

```json
{
  "job": "claude-job-12345678",
  "by": "claude-supervisor",
  "remote": { "host": "mac", "name": "claude-job-12345678" },
  "workdir": "/Users/owner/projects/repository",
  "session": "remote-session-id"
}
```

Blocking asks use their local `*-ask-*` job name in `job`; `remote.name` is the
runner's name. Existing status, title, model, effort and progress fields retain
their meanings. `jobs[localJobName]` also adds `remote` alongside `next`.
`GET /api/runs/<run>` reads the local mirror; `POST /api/subagents/message`
and `/api/subagents/settings` continue to address a local run and route through
its owning supervisor. Existing cookie authentication and mutation headers
remain required. Approval endpoints are unchanged. Remote transcript files
are not available through local transcript endpoints.

`src/cli/ui-page.ts` is deliberately unchanged; the supervisor owns presentation.
Loopback tests exercise two real TLS brokers and detached fake-agent runners.
Physical PCs, provider accounts and platform-specific build tools require
separate acceptance.
