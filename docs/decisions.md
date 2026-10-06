# Pinned owner decisions

Research the owner's choice before recording it. `decide` stores the recording session as author; it does not infer a decision from ordinary messages.

## MCP

`decide(topic, text, scope?, source_message_id?)` returns a JSON text block:

```json
{"decision":{"id":"uuid","topic":"camera","text":"Hold to look","scope":"all","author":{"id":"peer-id","name":"claude-project","agent":"claude"},"createdAt":1790000000000,"sourceMessageId":null,"supersedes":null,"current":true},"deliveredTo":["claude-project","codex-project"]}
```

`decisions(query?, scope?, history?)` returns a JSON text block containing an array of those decision objects, newest revision first. `history` defaults to false; true includes superseded revisions. Query matches a case-insensitive substring of topic or text. An empty result is `[]`.

Scope accepts:

- `"all"`: all local sessions; on lookup, only decisions recorded for all sessions.
- `{"project":"absolute folder"}`: that exact folder, normalized for separators and Windows case. Lookup includes global decisions.
- `{"sessions":["peer-name","peer-id","host-session-id"]}`: any of these session addresses. Lookup includes global decisions.

An omitted MCP scope defaults to the calling session's project folder. Project lookup also includes decisions addressed to that calling session. Topic identity is trimmed and lowercase. A later decision on the same topic supersedes the previous one across scopes, including when scope changes. Every revision remains in history. `source_message_id`, if provided, must identify an existing bridge message; otherwise provenance is null. `createdAt` is Unix epoch milliseconds.

## Authenticated dashboard reads

Both endpoints use the dashboard's existing HttpOnly `ab_ui` cookie and localhost Host guard. They read the shared database without opening a writer or running migrations, and work when the broker is offline.

`GET /api/decisions?q=<substring>&scope=<scope>` returns `{"decisions":[...]}` containing current revisions. Omitted scope lists all current decisions. Scope is literal `all` or URL-encoded JSON in either object shape above. Omitted `q` searches everything. There is no implicit project/session context in dashboard requests.

`GET /api/decisions/<encodeURIComponent(topic)>/history` returns `{"topic":"normalized topic","decisions":[...]}` with every revision of that exact topic, newest first. Optional `q` and `scope` have the same meaning as on the list endpoint.

- `200`: result, including empty arrays for unknown topics or no matches.
- `400`: malformed scope, topic or oversized query, with `{"error":"..."}`.
- `403`: missing/invalid dashboard cookie or forbidden Host, using existing dashboard responses.

Decision object fields are exactly `id`, `topic`, `text`, `scope`, `author` (`id`, `name`, `agent`), `createdAt`, `sourceMessageId`, `supersedes` and `current`. Nullable fields use JSON null. The dashboard page itself is unchanged.

## Persistence and notifications

Broker requests `decide` and `decisions` share one store in `bridge.db`. Version 3 creates append-only `decisions` and `decision_deliveries`; versions 1 and 2 retain their original meanings. Existing databases are backed up before migration, with every upgrade tested from versions 0, 1 and 2.

Each revision queues one durable bridge message per connected session in scope, including the recording session. Messages and delivery receipts commit together. Job runners are excluded. A session's receipt follows its host session id across broker restart and MCP reload. New or relocated sessions receive applicable current decisions when their host session identity is learned; this avoids duplicate notifications while a reloaded server is still identifying itself. Unacknowledged messages retain the existing broker replay behavior.

Notifications use hop 100, the maximum configurable hop limit, so they do not wake idle sessions or keep Stop hooks running. Current project decisions also appear briefly in both SessionStart notes (at most five topics and 160 characters per text); the command hook can read them before a broker is running.
