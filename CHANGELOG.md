# Changelog

## 0.30.0

Changes since 0.29.17:

- Owner questions appear in the dashboard and desktop notifications, retain answers, and reach the current project master.
- Project groups and subagent handoff preserve discovery, ownership and control across supervisor reloads; main changes are visible and announced.
- Codex idle wake and delivery distinguish queue acceptance from consumption, with consistent direct, broadcast and quiet-note handling.
- Broadcasts reach live secondary sessions; stale offline names are skipped. Inbox pages keep retained quiet copies available explicitly.
- Startup admission bounds concurrent native launches across Claude Code, Codex, opencode and Antigravity; broker scheduling and SQLite contention fixes keep bursts responsive.
- Plugin updates preserve running jobs, retained versions and user data, synchronize marketplace/cache records, and expose mismatches through doctor checks.
- Storage isolation, outcome lookup and terminal log parsing protect live jobs and retained history; the dashboard groups project sessions more clearly.

Idle-memory and lazy-loading changes remain deferred pending load acceptance.
