# Transcript fixtures

These small excerpts were cut from local CLI stores on 2026-10-06 and anonymized.
Chat text, arguments, output, titles, identifiers and timestamps use generic values.
Personal paths, account metadata and emails were removed. No original store was changed.

- Claude Code 2.1.283: parent JSONL and nested native-subagent JSONL; the legacy test
  reuses the observed `isSidechain`/`agentId` records in the parent stream.
- Codex 0.160.0: `session_meta`, `response_item`, `event_msg`, and native
  `source.subagent.thread_spawn` metadata. The native fixture includes the observed
  root `session_id`, distinct child `id`, and inherited-history ordinal boundary.
- OpenCode 1.18.34: SQLite `session`, `message` and `part` rows, exported to JSON so
  tests can recreate a tiny database. Includes text, tools, ignored reasoning/step
  parts, and a real Task result's `state.metadata.sessionId` relationship.

The helper creates only the columns these readers need; the live schema contains
additional columns. Completion text and generic parent prompts replace originals.
