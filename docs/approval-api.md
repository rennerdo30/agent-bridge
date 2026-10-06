# Dashboard approvals

Codex jobs use automatic approval review by default (`codexApprovalsReviewer: "auto_review"`).
Terminal refusals and timeouts enter this same registry when a supervisor can answer. An allow
requests one exact retry as continuation context, retaining Codex's reviewer and sandbox; it cannot
override Codex policy. A deny is delivered with its reason. See [delegated access](delegated-access.md#automatic-approval-review-ab-92).

All requests use the local dashboard's `ab_ui` HttpOnly cookie, obtained by opening its launch link.
POSTs also require `x-agent-bridge: 1` and `Content-Type: application/json`.
The dashboard is bound to `127.0.0.1` and rejects foreign Host headers.

## List pending approvals

`GET /api/approvals` returns HTTP 200:

```json
{
  "approvals": [
    {
      "id": "12345678-1234-1234-1234-123456789abc",
      "owner": "claude-project",
      "job": "codex-job-1a2b3c4d",
      "agent": "codex",
      "tool": "shell",
      "command": "npm test",
      "reason": "Run the requested checks",
      "askedAt": 1791279000000,
      "deadline": 1791279600000
    }
  ]
}
```

The array is sorted oldest first, and is empty when no requests are pending.
`askedAt` and `deadline` are Unix epoch milliseconds. `id` identifies this request, not the job or turn.
`owner` identifies the session that started the job. The reason falls back to the approval question when
the agent supplies no separate justification. `command` is the command, tool input or patch summary.
These fields are untrusted plain text: render them with `textContent` or HTML escaping.
Private relay credentials and process details are never returned.

## Answer a request

`POST /api/approvals/<id>` accepts:

```json
{"decision":"allow","reason":"Run the requested checks"}
```

`decision` must be exactly `allow` or `deny`. `reason` is optional and must be a string of at most
4,000 characters. HTTP 200 means the waiting callback accepted the answer:

```json
{"outcome":"answered","id":"12345678-1234-1234-1234-123456789abc","answeredBy":"dashboard","decision":"allow"}
```

- HTTP 400: invalid JSON, decision or reason (`{"error":"..."}`).
- HTTP 403: missing/invalid cookie, foreign Host or missing `x-agent-bridge: 1` header.
- HTTP 404: unknown route or malformed request id.
- HTTP 409: answered, expired, cancelled or unknown id (`{"outcome":"expired","error":"..."}`).
- HTTP 504: the owning process did not confirm the answer (`{"outcome":"unavailable","error":"..."}`).

Refresh the pending list after answering, including after a 409 or 504. The first dashboard, session
(`message_subagent`) or native permission dialog answer wins. Repeated answers never become a follow-up
to the job, and never approve a later request. The session receives a message identifying the winning
responder. Timeout or job cancellation denies the request and removes it from the list.

Example from the authenticated dashboard page:

```js
const { approvals } = await fetch('/api/approvals').then(r => r.json());
const approval = approvals[0];
if (approval) {
  const response = await fetch(`/api/approvals/${approval.id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-bridge': '1' },
    body: JSON.stringify({ decision: 'deny', reason: 'Please revise the command' }),
  });
  const result = await response.json();
}
```

## Desktop notifications

Top-level `config.json` settings (all default to `true`):

```json
{"notifications":{"approvals":true,"finish":true,"fail":true}}
```

Notifications use fixed event text only; job commands, tool inputs, prompts, titles, reasons and reports
never appear in desktop notification text. Helpers run asynchronously with a five-second deadline,
hidden windows and ignored output. Events are limited to one of each kind every five seconds and ten
notifications per minute per bridge home, including detached runners. Missing desktop helpers are
best effort and do not affect approvals or job results.

Windows uses built-in WinRT toasts through Windows PowerShell, with no BurntToast dependency. macOS
uses `terminal-notifier` when installed, otherwise built-in `osascript`. Linux uses `notify-send`.
OS notification settings and interactive desktop availability determine whether a notification appears.
Browser notifications and dashboard rendering are owned by the dashboard UI implementation.
