# Questions to the owner

`ask_owner` (opencode: `bridge_ask_owner`) files an owner-only decision in the existing **Waiting for you** approvals registry. Claude Code, Codex, opencode and Antigravity use the same MCP contract. It returns immediately. Delegated jobs ask their main instead. Interactive project sessions can file only for their own canonical project; a linked job must be controlled by that project session. Check `decisions` before asking.

Use questions for missing scope, priority, budget, release, policy or authorization decisions. Status, progress, peer coordination, routine code checks and playable owner checks belong in their existing channels. Never include secrets, credentials or full logs. Authorization questions must link the concrete artifact, diff or commit. Answers never bypass native tool approvals, widen authorization or accept implementation.

Required fields: `title` (one line), `context` (at most ten lines), `topic`, `options` (2–4 distinct ids, labels and consequences, exactly one recommended), `blocking`, `blocks` and `meanwhile`. Optional fields: `project` (own project directory only), `deskProject` (Pair Desk slug; inferred from `.pair-desk.json` when linked), `job`, `links` (`issue`, `file`, `commit`, `artifact`, `diff`), `affectedProjects`, `destructive`, `authorization`, `urgency`, and `default: {option, deadline}` (Unix milliseconds). Free text is always available to the owner.

The registry computes the dedupe key from canonical project + linked issue ids + topic. Matching terms merge into one stable id with every asker and affected project. Conflicting options/defaults are rejected rather than silently replacing a decision. Related topics on other issues return a `similar` warning. A session can have at most five open questions.

Routing, caps and dismissal rights follow native session identity, with broker peer identity as the fallback before it is learned. Renaming does not evade the cap. A replacement display name does not receive the original asker's answer; a new responsible project main can receive an explicit fallback even when it reuses the old main's name.

Questions remain `open` until `answered`, `cancelled` or `superseded`. `withdraw_owner_question` explicitly closes an asker's question with a reason; supersession also requires an existing replacement id. Closed records stay in Question history and search. There is no silent expiry. A declared safe default is recorded explicitly as **declared-default, not the owner**. Authorization questions and blocking destructive questions cannot have a default.

The owner clicks an option once, or enters free text and clicks **Send answer**. The registry stores the exact answer, identity and time before delivering a direct waking message (`reply_to = question id`) to both asker and responsible main, plus a linked job when present. Offline inboxes remain durable; a newly available project main receives fallback. The UI distinguishes busy, offline, wake unavailable, wake requested, failed/unconfirmed and read receipts. A requested wake without consumption after twenty seconds is explicitly unconfirmed; inbox delivery alone is never reported as a read.

The **This is a lasting rule** checkbox uses the existing decision store, with explicit project/all scope, revision id, supersession and question id as context. An ordinary answer never installs a policy. Answers linked to a Pair Desk issue are mirrored through its local HTTP API (`127.0.0.1:8765`); failures remain visible and retry at most once per minute, with an issue lookup preventing duplicate comments after an unconfirmed write.

## Alerts

Dashboard tabs heartbeat every three seconds, including Page Visibility state. A heartbeat remains live for ten seconds. One visible tab is preferred; otherwise one hidden-but-open tab gets the alert. The tab plays a brief generated Web Audio chime, highlights the question and sets a title count. A hidden tab also uses browser notifications if permission was granted through the quiet **Notify me in this browser** button. Browser sound needs one interaction to unlock audio; the page shows its readiness.

Without an open dashboard, the existing native notification helpers display a question toast with the stable dashboard key and question deep link. Windows uses a protocol-activation toast; macOS uses `terminal-notifier -open` with the existing AppleScript fallback; Linux uses the notification action and `xdg-open`. Desktop environments lacking actionable notification helpers may show only the notification. Helpers never install modules or modify the registry.

Each question claims one alert channel durably, preventing double alerts across tabs or broker restarts. Blocking questions can gently remind after fifteen minutes. Configure in the page or `config.json`:

```json
{"questionAlerts":{"sound":true,"toast":true,"reminderMinutes":15}}
```

Set `reminderMinutes` to `0` to disable reminders. Questions and exact answers are indexed by `search_history`, including `kind: "question"`.
Individual config overrides are accepted; omitted alert fields keep their defaults. Sound-off also silences native alerts and browser notifications.

## Storage and mixed versions

The approvals registry has an additive `owner-questions.db` extension. Legacy permission JSON and `bridge.db` formats are unchanged by this feature, so a 0.29.17 permission process cannot interpret an answer as allow/deny. Question schema changes use versioned SQLite migrations and verified pre-migration backups. No question history or user data is deleted. An older broker rejects unsupported question operations; a new dashboard still displays retained open questions read-only until an updated broker takes over naturally.

`GET /api/approvals` returns the combined open list with `kind: "permission"` or `kind: "question"`, plus durable question history. Owner answers use `POST /api/questions/{id}` with `{option}` or `{text}`, optionally `pin: {topic, scope}`. These cannot be posted to the permission allow/deny endpoint. Explicit dismissals use `/api/questions/{id}/dismiss`. Settings use `/api/questions/settings`; tab presence uses `/api/dashboard/heartbeat`. All mutations retain the dashboard's local cookie and anti-CSRF header checks.
