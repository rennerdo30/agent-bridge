---
title: "Sessions and project groups"
---

A session is one running coding agent connected to the bridge. Use `peers` to discover its name, CLI, folder, availability and version. Address an exact session when you need that conversation; address its project when the available main contact should handle the message.

Local sessions sharing a Git common directory form one project group, including worktrees. The main session receives project messages first; a secondary is the available fallback. Exact session messages stay direct. Jobs retain their owning masters and durable history across handoff or plugin reload.

Read [project groups](../../project-groups/) for routing and permissions and [subagent handoff](../../subagent-handoff/) for explicit ownership transfer.
