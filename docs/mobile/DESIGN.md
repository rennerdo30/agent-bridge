# agent-bridge mobile: design (AB-271)

The agent-bridge dashboard on the phone. One React Native + Expo (TypeScript) codebase for Android and iOS. It is a
client of the existing dashboard API on the owner's PC, reached through a private gateway. This document is the
build spec; `tokens.json` holds every color, size and timing value, and `components.md` lists the reusable
components with their props and states. When this file says "token `x`", read `tokens.json`.

Contents

1. Design principles
2. Navigation map
3. Global states (connection, pairing, revocation)
4. Screens (wireframes, components, states, API)
5. Interactions and gestures
6. Notification flows
7. Pairing flow
8. Accessibility
9. Light and dark mode
10. Data, polling and caching rules
11. API map (screen to endpoint)
12. API gaps the implementer must add

---

## 1. Design principles

1. **The dashboard, not a new product.** Same palette (indigo accent, one blue for "working"), same vocabulary
   ("working · 42%", "main", "secondary", "Waiting for you", "started by …"), same status colors, same chat
   rendering rules (tool steps folded after three, answers on green, your prompts tinted on the right). A person
   who knows the web dashboard recognizes every screen.
2. **Glance first, then drill down.** Overview answers "is anything working, stuck or waiting for me?" in one
   screen. Details live one or two taps deeper, never on the first screen.
3. **Questions are the only thing that interrupts.** Only `ask_owner` questions addressed to the owner get a badge,
   a push or a banner. Agent-to-agent traffic (`job-question`, peer messages) never alerts and never appears in the
   inbox. Permission approvals are out of v1 and are filtered out as well.
4. **Read-mostly, deliberate writes.** v1 writes exactly two things: an answer (or dismissal) to an owner question
   and, optionally, a message to a local session. Each write needs a deliberate confirm tap, shows "saving", and is
   never retried automatically. An unconfirmed write says so in plain words.
5. **Honest freshness.** Every screen says when its data is old or unreachable. Cached content stays visible
   (never blanked) under a banner that names the problem and the time of the last good update.
6. **No secrets on the lock screen or in transit to push services.** Push payloads carry no content. Nothing about
   a question is shown until the app is open and has re-checked with the PC.
7. **Native patterns only, nothing platform-exclusive.** Bottom tabs, native stack with swipe/back, bottom sheets,
   pull to refresh, system share/copy. The same layout on both platforms; only platform conventions (back gesture,
   haptics API, notification channel) differ.
8. **Status is never color alone.** Every dot or tint is paired with a word (busy, idle, offline, failed, …).

---

## 2. Navigation map

```
RootNavigator (native stack, headerShown per screen)
├── Launch                     (splash; decides the branch below; no UI beyond the logo)
├── Onboarding (stack)         shown when no device credential is stored
│   ├── S01 Welcome
│   ├── S02 Scan pairing code  (camera)
│   ├── S03 Confirm on your PC
│   └── S04 Notifications primer
├── Revoked                    S05, full screen, replaces everything when the PC revoked this phone
└── Main (bottom tabs)
    ├── Tab "Overview"   icon: grid      stack: S10 Overview → S11 Session → S12 Subagent → S13 Native subagent
    │                                     sheet: S14 Host details
    ├── Tab "Running"    icon: activity  stack: S20 Running → S12 Subagent → S13 Native subagent
    ├── Tab "Questions"  icon: question  stack: S30 Inbox → S31 Question
    │                    badge: number of open owner questions (warn color, see 8)
    └── Tab "Settings"   icon: gear      stack: S40 Settings → S41 Connection → S42 Notifications → S43 About
Modals (presented over Main, iOS pageSheet / Android bottom sheet):
    M01 Answer confirmation   (from S31)
    M02 Dismiss question      (from S31)
    M03 Composer              (from S11, optional v1 feature)
    M04 Session info          (from S11 header)
Toasts: in-app, top of the screen below the status bar, over any tab.
```

Deep links (scheme `agentbridge://`, also used by push taps):

| Link | Opens |
|---|---|
| `agentbridge://pair?…` | S02 result (QR scanned with the system camera); see 7 for the payload |
| `agentbridge://questions` | Questions tab, S30 (push tap lands here first; see 6) |
| `agentbridge://session/<host>/<name>` | S11 (internal only; used by "open session" links inside S31) |
| `agentbridge://subagent/<host>/<groupKey>` | S12 (internal) |

`<host>` is `local` for the gateway PC, otherwise the paired PC name exactly as the dashboard uses it in
`"<pc>/<name>"` session names.

Tab bar: always visible on the four root screens, hidden on S12/S13/S31 (full-height reading). Back from a
pushed screen returns to the same scroll position.

---

## 3. Global states

These apply on every Main screen. They are drawn by `ConnectionBanner` (components.md) directly under the
navigation bar, above content. Only one banner shows at a time; the priority is the order of the table.

| State | Trigger | Banner (exact copy) | Content behaviour |
|---|---|---|---|
| Revoked | any request returns 401 with `code: "device_revoked"` | none; navigate to S05 | credential and caches wiped first |
| Unpaired | no credential in secure storage | none; Onboarding stack | — |
| Update needed | `GET /m/v1/hello` capability missing, or 426 | "Your PC runs an older agent-bridge. Update it to use the app." (warn) | cached content stays, writes disabled |
| Offline (phone) | NetInfo `isConnected === false` | "You're offline. Showing what was loaded at 14:02." (neutral, icon wifi-off) | cached content, writes disabled |
| Unreachable | network ok but `unreachableAfterFailures` (3) requests in a row failed or timed out | "Can't reach office-pc. Last update 14:02. [Retry]" (warn) | cached content, writes disabled, polling continues with backoff |
| Reconnecting | 1–2 failures in a row | "Reconnecting…" with a small spinner (neutral) | cached content, writes stay enabled |
| Stale | last successful `/state` older than `staleAfterMs` (15 s) while foregrounded, without a failure (e.g. slow PC) | "Updated 40 s ago" (neutral, no action) | — |
| Bridge slow | `/api/state` returns `brokerState: "slow"` or `"unavailable"` | "The bridge on office-pc is responding slowly." (neutral) | keep previous `peers` (same rule as the dashboard poll) |

Times in banners are the phone's local time, `HH:mm`, 24-hour unless the OS is set to 12-hour.

"Writes disabled" means the Send answer / Send buttons are disabled and show a caption "Connect to your PC to
answer." The draft is kept.

---

## 4. Screens

Wireframes are 40 columns wide (a 375 pt phone). `[ ]` is a button, `( )` a chip/pill, `●` a status dot, `▸`/`▾`
a fold, `═` a progress bar, `▎` a vertical accent rule. Anything in `<angle brackets>` is data.

### S01 Welcome (unpaired)

Purpose: explain what the app does and start pairing.

```
┌────────────────────────────────────────┐
│                                        │
│              [agent-bridge logo 72]    │
│                                        │
│        agent-bridge                    │  largeTitle
│  Your agents' dashboard, on your phone │  body, textMuted
│                                        │
│  ● See which sessions and subagents    │  callout rows with
│    are working, and how far they are   │  small icons
│  ● Read their conversations            │
│  ● Answer the questions they ask you   │
│                                        │
│                                        │
│  [        Pair with your PC         ]  │  PrimaryButton
│  On your PC, open the dashboard and    │  caption, textMuted
│  choose Network › Pair a phone.        │
└────────────────────────────────────────┘
```

Components: Logo, FeatureRow ×3, PrimaryButton, caption.
States: only this one. If the app was opened through an `agentbridge://pair` link, skip S01 and go to S03.
API: none.

### S02 Scan pairing code

Purpose: scan the single-use QR code shown on the PC.

```
┌────────────────────────────────────────┐
│ ‹ Back            Scan code            │
├────────────────────────────────────────┤
│ ░░░░░░░░░░░░░ camera ░░░░░░░░░░░░░░░░░ │
│ ░░░░░░┌──────────────────┐░░░░░░░░░░░ │
│ ░░░░░░│                  │░░░░░░░░░░░ │  QrFrame 248×248,
│ ░░░░░░│                  │░░░░░░░░░░░ │  corner marks accent
│ ░░░░░░│                  │░░░░░░░░░░░ │
│ ░░░░░░└──────────────────┘░░░░░░░░░░░ │
│ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
├────────────────────────────────────────┤
│ Point the camera at the code on your   │  callout
│ PC. It works once and expires after    │
│ 5 minutes.                             │
│ [ Turn on torch ]                      │  GhostButton
└────────────────────────────────────────┘
```

Components: CameraView (expo-camera, barcode type `qr`), QrFrame, GhostButton (torch).
States:
- Camera permission not asked: show the system prompt on entering.
- Camera permission denied: replace the camera with EmptyState "Camera access is off" / "Allow camera access in
  Settings to scan the code." [Open Settings] (Linking.openSettings()).
- Scanned a code that is not an agent-bridge code: haptic warning, inline error under the frame "This is not an
  agent-bridge pairing code." Keep scanning.
- Scanned an expired code (`exp` in the past, checked locally): "This code has expired. Show a new one on your
  PC." Keep scanning.
- Valid code: haptic success, freeze the frame for 300 ms, push S03.
API: none (parsing is local).

### S03 Confirm on your PC

Purpose: claim the pairing and wait for the owner to approve it on the PC, with a match code against relay attacks.

```
┌────────────────────────────────────────┐
│ ‹ Cancel                               │
├────────────────────────────────────────┤
│  Confirm on office-pc                  │  title
│                                        │
│  Your PC shows a request from          │  body
│  "Renne's Pixel 8". Check that it      │
│  shows the same code, then choose      │
│  Allow on the PC.                      │
│                                        │
│        ┌────────────────────┐          │
│        │   482 913          │          │  PairingCode, mono 32
│        └────────────────────┘          │  accentSoft box
│                                        │
│  ◌ Waiting for your PC…                │  spinner + subhead
│                                        │
│  Phone name  [ Renne's Pixel 8   ✎ ]   │  editable before claim
│  PC key      7F3A·91C2·…·0B4E          │  monoSmall, textFaint
└────────────────────────────────────────┘
```

Components: PairingCode, Spinner, InlineEdit (device name, default from expo-device `deviceName`, max 40 chars),
FingerprintText.
States:
- Claiming (POST in flight): spinner text "Connecting to office-pc…".
- Waiting: as drawn, polls the claim status every 1.5 s, up to `pairingConfirmTimeoutMs` (2 min).
- Gateway unreachable: ErrorState "Can't reach office-pc" / "Your phone must be on the same network as your PC, or
  on your private network (for example your VPN)." [Try again] [Scan another code].
- Code already used: "This code was already used. Show a new one on your PC." [Scan again].
- Rejected on the PC: "office-pc did not allow this phone." [Scan again].
- Timed out: "No answer from your PC. The request expired." [Scan again].
- Fingerprint mismatch (TLS key differs from the QR): blocking ErrorState "This connection is not your PC. The
  key does not match the code you scanned. Pairing stopped." [Scan again]. Never offer "continue anyway".
- Approved: store the credential, then S04 (or Overview if notifications were already decided).
API: gap G2 (`POST /m/v1/pair/claim`, `GET /m/v1/pair/claim/<id>`).

### S04 Notifications primer

Purpose: ask for notification permission with context before the OS prompt.

```
┌────────────────────────────────────────┐
│                                        │
│        [bell illustration 64]          │
│                                        │
│  Get told when an agent asks you       │  title
│                                        │
│  When a session or subagent asks you   │  body
│  a question, your phone shows          │
│  "A question is waiting for you".      │
│  The question itself never leaves      │
│  your PC until you open the app.       │
│                                        │
│  [        Turn on notifications     ]  │  PrimaryButton
│  [             Not now              ]  │  GhostButton
└────────────────────────────────────────┘
```

States: shown once after the first pairing. "Turn on" → OS prompt → register push token (G4) → Overview.
"Not now" → Overview; Settings › Notifications can turn it on later. If the OS already denied (iOS second time),
the button becomes "Open Settings".
API: G4 `PUT /m/v1/devices/self/push`.

### S05 Revoked

Purpose: tell the owner that the PC removed this phone, after wiping local data.

```
┌────────────────────────────────────────┐
│                                        │
│        [unlink icon 56, textFaint]     │
│                                        │
│  This phone was removed                │  title
│                                        │
│  office-pc no longer accepts this      │  body
│  phone. Its saved connection and       │
│  everything it loaded were deleted     │
│  from the phone.                       │
│                                        │
│  [         Pair again                ] │  → S02
└────────────────────────────────────────┘
```

Also reached when the owner chooses Settings › Unpair this phone (title then reads "This phone is unpaired").
Wiping only touches the phone's own app storage, never anything on the PC.

### S10 Overview (Tab 1 root)

Purpose: hosts → projects → sessions with role, agent, activity and running subagents at a glance.

```
┌────────────────────────────────────────┐
│ Overview                     ● office-pc│ largeTitle; right: ConnectionDot
│ ┌────────────────────────────────────┐ │
│ │ ⌕ Search sessions and subagents    │ │ SearchField (pull down to reveal)
│ └────────────────────────────────────┘ │
│ ┌────────────────────────────────────┐ │
│ │▎2 questions are waiting for you   ›│ │ AttentionCard (warnSoft, warn rule)
│ └────────────────────────────────────┘ │
│ ┌──────────┬───────────┬─────────────┐ │
│ │ 3        │ 7         │ 1           │ │ StatsStrip: stat numbers
│ │ working  │ sessions  │ failed today│ │ busy / text / bad colors
│ └──────────┴───────────┴─────────────┘ │
│                                        │
│ THIS PC · office-pc            ● 5     │ HostHeader
│ ┌────────────────────────────────────┐ │
│ │ agent-bridge                    2 ▸│ │ ProjectGroup header (folder name,
│ │ ├ [C] claude (main)   ● busy       │ │   count of working subagents)
│ │ │     2 subagents working          │ │ SessionRow (member, main)
│ │ └ [C] codex           ● idle       │ │ SessionRow (member, secondary,
│ │       secondary                    │ │   textMuted title)
│ ├────────────────────────────────────┤ │
│ │ [O] pair-desk          ● busy      │ │ SessionRow (standalone)
│ │     opencode-pair-desk · 1 working │ │
│ └────────────────────────────────────┘ │
│                                        │
│ LAPTOP                    ○ offline    │ HostHeader, offline
│ ┌────────────────────────────────────┐ │
│ │ Not connected · last seen 13:41    │ │ HostOfflineRow
│ └────────────────────────────────────┘ │
│                                        │
│ ▸ Ended sessions with subagents (3)    │ Disclosure
├────────────────────────────────────────┤
│  Overview   Running   Questions  Settings│ TabBar (Questions badge "2")
└────────────────────────────────────────┘
```

Order and grouping (same rules as the dashboard sidebar `sideGroups` / `projectSidebar`):
- Hosts: the gateway PC first (label "THIS PC · <pc name>"), then paired PCs by name.
- Inside a host: sessions in a shared project (`peer.projectGroup`) are grouped under a ProjectGroup titled with the
  folder of `peer.projectRoot`; the `projectMain` session first with a "main" tag, the others "secondary" and in
  `textMuted`. Sessions without a project group are standalone SessionRows. Order: most running subagents first,
  then title A–Z.
- Session title: folder name of `peer.cwd`, else the short name. Subtitle: short session name · role (if grouped)
  · activity (`busy` / `idle` / `connected` when unknown / `unavailable`).
- Subagent sessions (`peer.subagent === true`) are not listed here; they appear under their parent in S11.
- Ended sessions that still have subagent runs go into the collapsed "Ended sessions with subagents (n)" disclosure
  at the end, rows at `opacity.ended`.

Stats strip: `working` = running subagent groups (all hosts); `sessions` = live sessions; `failed today` = groups
failed since local midnight. Tapping "working" switches to the Running tab with filter Working; "failed today" with
filter Failed.

AttentionCard: only when open owner questions > 0. Copy: "1 question is waiting for you" / "n questions are waiting
for you". Taps to the Questions tab.

States:
- Loading (first fetch, no cache): Skeleton — stats strip with three grey blocks, one HostHeader bar, four
  SessionRow skeletons. No spinner.
- Empty (connected, no sessions anywhere): EmptyState "No sessions connected" / "Start Claude Code, Codex, opencode or
  Antigravity on your PC with the agent-bridge plugin and it appears here."
- Search with no matches: inline "Nothing matches." (same copy as the dashboard).
- Paired PC error: HostHeader shows the status and a one-line HostErrorRow using the dashboard's REMOTE_ERRORS copy
  (e.g. `remote_update_needed`: "The other PC runs an older agent-bridge. Update it (and restart its sessions) to
  see its chats here.").
- Offline / unreachable / reconnecting / stale: ConnectionBanner (section 3), content unchanged.
- Pull to refresh: forces `/state`, `/hosts`, `/questions`.

Interactions: tap SessionRow → S11. Tap ProjectGroup header → collapse/expand (remembered per project).
Tap HostHeader → S14 sheet. Long-press SessionRow → context menu "Copy session name".

API: `GET /api/state` (peers, runs, jobs, remoteErrors, brokerState), `GET /api/approvals` → owner questions count,
G7 hosts summary (until then `GET /api/network` `paired[]`).

### S11 Session

Purpose: one session: its conversation and its subagents.

```
┌────────────────────────────────────────┐
│ ‹ Overview                          ⓘ  │ nav bar; ⓘ opens M04
│ [C] agent-bridge                       │ SessionHeader: avatar 34, title
│     claude · main · ● busy             │ chips row: agent, (main), activity
│     office-pc                          │ host, caption textFaint
│ ┌──────────────────┬─────────────────┐ │
│ │      Chat        │  Subagents  3   │ │ SegmentedControl
│ └──────────────────┴─────────────────┘ │
├────────────────────────────────────────┤
│        ↑ Loading older messages…       │ LoadOlderRow (top of list)
│ ────────── 14:02 ──────────            │ TimeDivider (gap > 30 min)
│                    ┌────────────────┐  │
│                    │You · 14:02     │  │ MessageBubble user (accentSoft,
│                    │Fix the flaky   │  │   right, tail bottom-right)
│                    │test in …       │  │
│                    └────────────────┘  │
│ [C]┌──────────────────────────────┐    │ MessageBubble assistant
│    │I'll look at the test first.  │    │   (panel2 + line border,
│    └──────────────────────────────┘    │    tail bottom-left)
│   │ 14:03 Read   src/core/x.ts         │ StepGroup ≤3 rows inline
│   │ 14:03 Bash   npm test -- x         │
│   │ ▸ 9 steps · last: Edit src/x.ts    │ folded StepGroup (>3)
│   ↳ started its own subagent           │ SubagentLink → S13
│     "Review the fix"                   │
│                              [ ↓ 3 ]   │ JumpToLatest (when scrolled up)
├────────────────────────────────────────┤
│ ┌──────────────────────────────┐ [➤]   │ Composer (optional v1; local
│ │ Message this session as owner│       │   sessions only)
│ └──────────────────────────────┘       │
└────────────────────────────────────────┘
```

Chat segment rules (port of `chatHtml` + `systemTurn`):
- Items come from the transcript endpoint in order. `kind: "user"` → right bubble "You · HH:mm" unless it is a
  system turn: `<task-notification>` → SystemRow with StatusPill ("Background task completed · <summary>");
  `<agent-bridge-message from=… agent=…>` → left PeerBubble "Message from <from>" with that agent's avatar;
  `<channel source=…>` → left PeerBubble titled with the source; `<command-name>` → SystemRow with the command in
  mono and "slash command"; `<local-command-stdout>` → SystemRow, first 300 chars in textFaint; other CLI system tags
  → folded SystemRow "Context added by the CLI" (tap to expand, markdown inside).
- `kind: "assistant"` → left bubble with the session's agent avatar (24), markdown.
- `kind: "tool"` items between two non-tool items form one StepGroup: up to 3 StepRows shown; more than 3 collapse to
  "▸ n steps · last: <tool> <summary first 70 chars>". StepRow: time HH:mm (textFaint, tabular), tool name (accent,
  micro 600), summary (monoSmall, one line, ellipsized). Tap a StepRow → bottom sheet with the full summary (mono,
  selectable, Copy button).
- `kind: "subagent"` → SubagentLink "↳ started its own subagent <title>" → S13.
- User bubbles longer than 600 chars are clamped to 220 pt with a fade and "Show all ▾" (accent); tap expands.
- Bubble max width 88% of the list width. Same `id` → replace the earlier item in place (opencode parts).
- Insert a TimeDivider (centered caption) before an item whose `at` is more than 30 min after the previous item,
  and at the first item of each local day ("Yesterday", weekday, or date).

Subagents segment:

```
│ Delegated (2)                          │ SectionHeader
│ [X] Fix flaky test       (working·42%) │ SubagentRow, running
│     codex · gpt-6-sol · high           │
│     ═══════════════░░░░░░  ~12 min left│ ProgressBar + EtaText
│ [O] Review docs           (done)       │ SubagentRow, finished
│     opencode · 2 turns         14:20   │
│ Its own subagents (1)                  │ SectionHeader
│ [C] Explore tests         (running)    │ NativeSubagentRow
│     started 14:05 · updated 14:09      │
```

- Delegated = the session's job groups from `/api/state` runs (dashboard `buildModel`: runs grouped by `job`,
  owner = `ownerOf`), running first (newest started first), then finished (newest updated first). The order must
  not change while a row only reports progress.
- Its own subagents = `GET /api/sessions/<name>/subagents` (`NativeSubagent[]`, status unknown/running/done/
  failed/interrupted).
- Subagent peers (`peer.subagent`, legacy worktree sessions) whose `parent` is this session are listed under
  Delegated with an "(old-style)" caption.
- Empty: "No subagents yet."

Header facts (M04 Session info sheet): name, agent, project folder, role (main/secondary), host, cwd (mono,
selectable), session id (mono), agent-bridge version, connected since (`startedAt`), wake available yes/no.
Read-only; v1 has no "Make project main" or coordinator controls.

States (Chat segment):
- Loading first page: three skeleton bubbles (left, right, left).
- 409 "This session has no sessionId yet." → EmptyState "No conversation yet" / "This session has not reported its
  CLI session yet: it appears after its next prompt." (dashboard copy).
- 404 / unsupported agent → EmptyState "No conversation to show" / "This CLI's transcript can't be read."
- Remote read error (`code` in REMOTE_ERRORS) → ErrorState with that copy + [Try again].
- Empty transcript → "No messages yet."
- Older loading: LoadOlderRow spinner "Loading older messages…"; older failed: "Couldn't load older messages.
  [Retry]"; reached the start: "Beginning of the conversation" (caption, textFaint); older paging unsupported by the
  PC (no `prev` in the response, gap G5): "Older messages are only on your PC for now." (caption).
- Ended session (not live): header activity "ended", composer hidden, chat still readable if the transcript loads.
- Offline etc.: banner; list keeps its items.

Live updates: while the screen is visible, poll forward from `next` every `pollChatBusyMs` when the session is
busy, `pollChatIdleMs` otherwise. If the user is at the bottom (within 40 pt), stay pinned to the newest item;
otherwise show JumpToLatest with the count of new items and do not move the scroll position.

API: `GET /api/sessions/<name>/chat?from=tail|<next>` (remote: `/api/sessions/<pc>%2F<name>/chat`),
`GET /api/sessions/<name>/subagents`, `/api/state` for header and delegated list; G5 for older pages.
Composer: section 4 M03.

### S12 Subagent (delegated job)

Purpose: one delegated subagent (a job and its follow-up turns) with status, progress, ETA and its conversation.

```
┌────────────────────────────────────────┐
│ ‹ Back                                 │
│ [X] Fix flaky test                     │ title (headline, wraps 2 lines)
│     (working · 42%)                    │ StatusPill
│     (codex) (gpt-6-sol) (high ▂▄▆_)    │ Chips: agent, model, effort meter,
│     (workspace-write)                  │   permission (low/mid/high tint)
│ ═══════════════════░░░░░░░░░░░░░░░░░░  │ ProgressBar large (5 pt)
│ Running the test suite · ~12 min left  │ progressNote · EtaText (callout)
│ started by claude-agent-bridge · 14:02 │ caption textFaint
├────────────────────────────────────────┤
│ ──── Task · 14:02 · (done) ────        │ TurnDivider (only if >1 turn)
│                    ┌────────────────┐  │
│                    │claude-agent-…  │  │ prompt bubble (right, accentSoft,
│                    │Fix the flaky … │  │   "who" = starting session)
│                    │      Show all ▾│  │   clamped >600 chars
│                    └────────────────┘  │
│   │ 14:03 bash   npm test              │ StepGroup
│   │ ▸ 14 steps · last: edit x.ts       │
│ [X]┌──────────────────────────────┐    │ "says" bubble
│    │The test races the timer …    │    │
│    └──────────────────────────────┘    │
│   14:21 · progress 42% Running suite   │ SystemRow
│ ──── Follow-up 1 · 14:30 · (working)── │
│ [X]┃Answer                         ┃   │ AnswerBubble (okSoft, ok 3 pt
│    ┃Fixed. The timer now …         ┃   │   left rule, "Answer" label)
│                                        │
│ Its own subagents                      │ SectionHeader (if any)
│   └ [C] Explore tests   (done)         │ NativeSubagentRow (tree guide)
└────────────────────────────────────────┘
```

Rules (port of `renderConversation`, `stepsHtml`, `parseEntries`, `cleanCmd`):
- Turns = runs of the group in start order; TurnDivider "Task" for the first, "Follow-up n" after, each with time
  and StatusPill, only when there is more than one turn.
- Each turn's log lines `HH:MM:SS text` (with indented continuations) map to: the prompt (right bubble, who = the
  starting session, "follow-up from <owner>" for later turns), `says:` → assistant bubble (dedupe identical
  consecutive says), `answer: ` → AnswerBubble (remove a matching say among the last 4), `message from X:` → right
  bubble "X · while it works", `answer to X:` → assistant bubble unless it repeats a say, `progress n%` and
  `finished after …` → SystemRow "HH:mm · <text>", `started` / `still working` lines dropped, everything else →
  StepRow (label = text before ": " when shorter than 24 chars; command shown through `cleanCmd`).
- A recovered run (`hasLog === false`) shows SystemRow "Recovered from the job record and <agent>'s own transcript"
  then its transcript rendered with the S11 chat rules (from `/api/runs/<name>/chat`).
- When the group is not running and has a `job`: a hint row at the end, warnSoft background, "Continue it with its
  context from <owner>: message_subagent(job="<job>")" (done) or "Recover it …" (failed/interrupted). Read-only,
  long-press copies the call.
- Native children of the job (`GET /api/jobs/<job>/subagents`) listed at the end under "Its own subagents", each →
  S13.
- Header: percent and progressNote only while running; EtaText while running and `etaAt` is set: "~n min left",
  "~n.n h left" from 90 min, "should be done by now" when past (dashboard `etaText`). Outcome chip for finished jobs
  from `/api/job-outcomes?job=<job>` (needs review / held / merged / discarded → outcome ok/warn/faint tints).
- No composer in v1 (messaging a subagent is not in scope).

States: Loading "Loading conversation…" SystemRow + header from `/state` (header renders immediately from the list
data); log read error → SystemRow "Its log could not be read: <error>"; no steps yet → "Waiting for the first
step…"; remote errors → REMOTE_ERRORS copy; the group disappeared from `/state` (archived) → keep showing the last
loaded data with a caption "No longer in the recent list."; banners as section 3.

Live updates: poll the newest turn's log forward (`from=<next>`) every `pollChatBusyMs` while running; stop when
the turn is finished and fully read. Auto-pin to bottom with the same rule as S11.

API: `/api/state` (runs, jobs), `GET /api/runs/<run>?from=<byte>` per turn (remote `/api/runs/<pc>%2F<run>`),
`GET /api/runs/<run>/chat` for recovered turns, `GET /api/jobs/<job>/subagents`, `GET /api/job-outcomes?job=`.
Gap G6 (structured, tail-first run log).

### S13 Native subagent (read-only)

Purpose: a CLI's own subagent conversation (Claude Task tool, Codex child thread, opencode child, Antigravity).

```
┌────────────────────────────────────────┐
│ ‹ agent-bridge                         │
│ [C] Explore tests          (running)   │ title + StatusPill
│     subagent of claude · read-only     │ caption
├────────────────────────────────────────┤
│  (S11 chat rendering, no composer)     │
└────────────────────────────────────────┘
```

API: `GET /api/sessions/<name>/subagents/<id>?from=…` or `GET /api/jobs/<job>/subagents/<id>?from=…`.
States: as S11 Chat. 404 → "This subagent's conversation is no longer available."

### S14 Host details (bottom sheet)

```
┌────────────────────────────────────────┐
│            ───                         │ grabber
│ office-pc                    ● online  │ headline + StatusDot
│ This PC (your phone connects here)     │ caption (gateway only)
│ agent-bridge 0.30.10                   │
│ 5 sessions · 3 subagents working       │
│ Last verified 14:02 · 38 ms            │ paired PCs: health.lastVerifiedAt,
│                                        │   roundTripMs
│ [ Close ]                              │
└────────────────────────────────────────┘
```

States: offline paired PC → "Not connected · last seen <time>"; remote error → REMOTE_ERRORS copy.
API: G7 (or `/api/network` `paired[]` + `/api/state.version`).

### S20 Running (Tab 2 root)

Purpose: every delegated subagent across all hosts, live status, progress and ETA.

```
┌────────────────────────────────────────┐
│ Running                                │ largeTitle
│ (All 12) (Working 3) (Failed 1) (Done 8)│ FilterChips (horizontal scroll)
│                                        │
│ Working now                            │ SectionHeader
│ ┌────────────────────────────────────┐ │
│ │▎[X] Fix flaky test   (working·42%) │ │ SubagentRow, 2 pt busy rule left
│ │     codex · claude-agent-bridge    │ │   subtitle: agent · owner session
│ │     ════════░░░░░░   ~12 min left  │ │
│ │▎[O] Port parser      (working)     │ │
│ │     opencode · laptop/codex-x      │ │ remote owner shows "<pc>/<name>"
│ │       └ [C] Explore  (running)     │ │ nested job (parentJob) indented
│ └────────────────────────────────────┘ │
│ Finished                               │
│ ┌────────────────────────────────────┐ │
│ │ [C] Review docs   (done) (merged)  │ │ + outcome chip
│ │     claude · codex-pair      14:20 │ │
│ │ [X] Try fix       (failed)         │ │
│ │     codex · claude-agent…    13:02 │ │
│ └────────────────────────────────────┘ │
│        [ Load older subagents ]        │ GhostButton, runsNext paging
└────────────────────────────────────────┘
```

Sort: same stable sort as the dashboard (`buildModel` `sorted`). Nested subagents (`parentJob`) are drawn under
their parent with the tree guide (indent 16 per level, max 2 levels, then flat with "↳").
Each row → S12.
States: Loading skeleton (5 rows); empty all → "No subagents yet" / "When a session delegates work to Codex,
opencode, Antigravity or Claude, it shows up here."; empty filter → "No working subagents." / "No failed
subagents." / …; load older failed → inline "Couldn't load older subagents. [Retry]"; banners.
API: `/api/state` (first page, `runsNext`), `GET /api/runs?before=<cursor>&limit=50` for older pages (remote
`/api/runs?host=<pc>&before=…`), `/api/job-outcomes` for finished chips.

### S30 Questions inbox (Tab 3 root)

Purpose: open owner questions, newest first, and their history.

```
┌────────────────────────────────────────┐
│ Questions                              │ largeTitle
│ ┌──────────────────┬─────────────────┐ │
│ │     Open  2      │    History      │ │ SegmentedControl
│ └──────────────────┴─────────────────┘ │
│ ┌────────────────────────────────────┐ │
│ │ (urgent) (blocking)        12 min  │ │ QuestionCard: badges + age
│ │ Release 0.31 today or wait for     │ │ headline, 2 lines max
│ │ the Windows fix?                   │ │
│ │ agent-bridge · claude-agent-bridge │ │ subhead textMuted: project ·
│ │ Blocks: publishing the release     │ │   askers; "Blocks:" if blocking
│ │ Default "wait" at 18:00            │ │ caption warn (if default)
│ └────────────────────────────────────┘ │
│ ┌────────────────────────────────────┐ │
│ │                            2 h     │ │ non-blocking, normal
│ │ Which name for the new tab?        │ │
│ │ pair-desk · codex-pair-desk        │ │
│ └────────────────────────────────────┘ │
└────────────────────────────────────────┘
```

Order (Open): urgent before normal, then blocking before non-blocking, then oldest `askedAt` first (it has waited
longest). New since last visit: a 6 pt accent dot left of the title until opened.
History: answered / cancelled / superseded, newest closed first; card shows a status pill and, when answered, one
line "Answer: <text>" (2 lines max).
States: Loading skeleton (3 cards); Open empty → EmptyState with check icon "Nothing is waiting for you" / "When a
session asks you something, it shows up here."; History empty → "No answered questions yet."; banners; paired PCs'
questions not yet available (G8) → footer caption "Questions from other PCs show on those PCs' dashboards for now."
Pull to refresh. Tap → S31.

Filter rule (owner-only, mandatory): show only items with `kind === "question"`. Drop `kind === "permission"` (out of
v1) and `kind === "job-question"` (agent-to-agent) before counting, badging or alerting.

API: `GET /api/approvals` → `approvals[]` (open) and `questions[]` (history); G9 for a dedicated filtered endpoint.

### S31 Question (detail and answer)

Purpose: read the full question and answer it (or dismiss it with a reason).

```
┌────────────────────────────────────────┐
│ ‹ Questions                        ⋯   │ ⋯ = Dismiss with reason (M02)
│ OWNER QUESTION · OPEN                  │ overline, accent
│ Release 0.31 today or wait for the     │ title
│ Windows fix?                           │
│ agent-bridge · claude-agent-bridge,    │ subhead textMuted (askers, with
│ codex-agent-bridge / fix-job           │   " / job" when set)
│ asked 14:02 (12 min ago)               │ caption
│ ┌────────────────────────────────────┐ │
│ │ <context, pre-wrapped, up to 10    │ │ ContextBlock (panel2)
│ │  lines, selectable>                │ │
│ └────────────────────────────────────┘ │
│ ▎Blocking: publishing the release      │ BlockingNote (warnSoft) or
│ ▎Meanwhile: preparing the changelog    │   "Non-blocking" (panel2)
│ Affected: agent-bridge, pair-desk      │ caption
│ (issue AB-271) (commit 5fb90d3)        │ LinkChips (copy on tap)
│                                        │
│ Choose one                             │ SectionHeader
│ ┌────────────────────────────────────┐ │
│ │ ◉ Wait for the fix    Recommended  │ │ OptionCard selected+recommended
│ │   Release slips one day            │ │   consequence, subhead textMuted
│ └────────────────────────────────────┘ │
│ ┌────────────────────────────────────┐ │
│ │ ○ Release today                    │ │ OptionCard
│ │   Windows users keep the bug       │ │
│ └────────────────────────────────────┘ │
│ ── or write an answer ──               │
│ ┌────────────────────────────────────┐ │
│ │ Your answer                        │ │ TextArea (8000 max)
│ └────────────────────────────────────┘ │
│ [◯] This is a lasting rule             │ Switch → shows ScopeSegment
│     ( This project | All projects )    │
│ Default "wait" after 18:00. This       │ caption textMuted
│ grants no tool permission.             │
├────────────────────────────────────────┤
│ [          Send answer             ]   │ sticky AnswerBar, PrimaryButton
│ An answer is not tool permission or    │ caption textFaint
│ implementation acceptance.             │
└────────────────────────────────────────┘
```

Rules:
- Options sorted recommended first (dashboard order). Selecting an option clears the text field; typing text
  clears the option selection (the API requires exactly one of `option` / `text`).
- Send answer enabled when an option is selected or text is non-blank and the connection allows writes.
- If `authorization`, `destructive` or the chosen option is not the recommended one: Send opens M01 (confirm sheet).
  Otherwise Send posts directly. Either way there is exactly one deliberate tap on Send.
- Pin switch adds `pin: { topic: q.topic, scope: "all" | { project: q.project } }`. Scope default "This project".
- Links: `issue` shows as a chip "issue AB-271"; the Pair Desk URL is 127.0.0.1 on the PC, so on the phone a tap
  copies the id (toast "Copied"). `file`/`commit`/`artifact`/`diff` chips copy their value.
- Default note: with `default` → "Default "<option label>" after <local time>. This grants no tool permission.";
  without → "No answer means no decision. This stays visible until answered or explicitly dismissed."
- Draft text, selection and pin state are kept in memory per question id while the app runs. Leaving with a
  non-empty draft does not prompt; the draft is restored on return.

Write states (AnswerBar):
- Saving: button shows spinner and "Sending…", all inputs disabled, back still allowed (request continues).
- Saved (200): success haptic, toast "Answer saved: <title>", the screen switches to the answered state below and
  the inbox refetches.
- Conflict (409, e.g. already answered on the PC or by another device): refetch; show the question's final state
  with an InfoBanner "This question was already answered on another device." Never resend.
- Validation (400): InfoBanner bad "Choose an option or write an answer." (should not happen with the rules above).
- Timeout (`answerTimeoutMs` 15 s, no response): warn banner "No confirmation yet. The bridge is busy; your answer
  may still be saved. [Check again]". Check again refetches the question; if still open the button re-enables. Never
  auto-retry.
- Offline/unreachable: button disabled, caption "Connect to your PC to answer."

Answered / closed state (also what History opens):

```
│ OWNER QUESTION · ANSWERED              │ overline ok
│ <title>                                │
│ ┃Answer                               ┃│ AnswerBubble style block
│ ┃Wait for the fix                     ┃│
│ owner · 14:15 · owner                  │ author · time · source
│ (declared default, not the owner)      │ when source = declared-default
│ Delivered                              │ SectionHeader
│ ● claude-agent-bridge  read 14:15      │ DeliveryRow per deliveries[]
│ ● codex-agent-bridge   wake requested  │   state → status color
│ Pair Desk: saved                       │ mirror state (caption)
```

Delivery states map: read (readAt set) → ok "read HH:mm"; pending/wake-requested → accent; busy → accent "busy";
offline/wake-unavailable → faint; failed/unconfirmed → bad. Show `detail` as caption under each row.
Cancelled/superseded: overline "DISMISSED" / "SUPERSEDED", the reason in a panel2 block.

States: loading (skeleton title + 3 lines); not found (id no longer listed) → EmptyState "This question is no longer
available." [Back to questions]; banners.
API: `GET /api/approvals` (read), `POST /api/questions/<id>` `{option}|{text}[, pin]`, header `x-agent-bridge: 1`
(through the gateway, G1).

### M01 Answer confirmation (sheet)

```
│ Send this answer?                      │ headline
│ "Release today"                        │ bodyStrong
│ Windows users keep the bug             │ consequence, textMuted
│ ▎Not the recommended option.           │ warn row (when applicable)
│ ▎This question asks for authorization. │ warn row (authorization)
│ ▎This is a destructive change.         │ warn row (destructive)
│ It is not tool permission.             │ caption
│ [ Send answer ]   [ Cancel ]           │
```

### M02 Dismiss question (sheet)

```
│ Dismiss this question                  │ headline
│ The asking session is told you         │ body
│ dismissed it, with your reason.        │
│ ┌────────────────────────────────────┐ │
│ │ Reason (required)                  │ │ TextArea, 1000 chars
│ └────────────────────────────────────┘ │
│ [ Dismiss ] (bad outline)  [ Cancel ]  │ disabled until reason non-blank
```

API: `POST /api/questions/<id>/dismiss` `{status: "cancelled", reason}`. Same write states as S31.

### M03 Composer (optional v1)

Bottom-docked in S11 Chat for live local sessions whose agent is claude/codex/opencode/antigravity. Hidden for
paired-PC sessions (the dashboard rule: "paired-PC sessions are view-only") and ended sessions; in their place a
caption "Sessions on other PCs are read-only here."

```
├────────────────────────────────────────┤
│ ┌──────────────────────────────┐ [➤]   │ TextArea grows to 6 lines; Send
│ │ Message this session as owner│       │   icon button (accentFill)
│ └──────────────────────────────┘       │
│ Queued: awaiting CLI consumption.      │ DeliveryReceipt caption
```

- Send posts `POST /api/sessions/<name>/message {body}`; while in flight the field is read-only.
- Receipt text comes from the server (`text` field), then `GET /api/chat-delivery/<receipt>` every 3 s for up to 60 s:
  "Queued: awaiting CLI consumption." → "Delivered: consumed by the CLI delivery hook. This does not confirm a reply
  or completion." 409 not-supported / not connected → bad caption with the server's error text. 502 unconfirmed →
  warn caption with the server text. The sent text is not inserted into the chat locally; it appears when the
  transcript shows it.
- Body limit: the server's `MAX_BODY_CHARS - 600`; the app caps input at 8000 and shows a counter from 7000.

### S40 Settings (Tab 4 root)

```
┌────────────────────────────────────────┐
│ Settings                               │
│ CONNECTION                             │
│ office-pc                ● connected  ›│ → S41
│ NOTIFICATIONS                          │
│ Owner questions                 On    ›│ → S42
│ APPEARANCE                             │
│ ( System | Light | Dark )              │ ThemeSwitcher (dashboard copy)
│ ABOUT                                  │
│ Version 1.0.0 (PC 0.30.10)            ›│ → S43
│                                        │
│ [ Unpair this phone ] (bad text)       │ confirm alert → S05
└────────────────────────────────────────┘
```

S41 Connection: PC name, PC key fingerprint (mono), addresses tried with the one in use, this phone's name as the PC
knows it, paired since, "Revoke this phone from the PC's dashboard: Network › Phones." (caption).
S42 Notifications: OS permission state (On / Off with [Open Settings]), "Notifications only say that a question is
waiting. The question stays on your PC until you open the app." Test row [Send a test notification] (G4).
S43 About: app version, PC agent-bridge version, open-source licenses, link to docs (opens browser).

Unpair: Alert "Unpair this phone?" / "The phone forgets office-pc and deletes what it loaded. You can pair again
any time." [Unpair] (destructive style) [Cancel] → `DELETE /m/v1/devices/self` (best effort; wipe locally even if
it fails) → S05 variant.

---

## 5. Interactions and gestures

| Gesture | Where | Result |
|---|---|---|
| Tap | rows, cards, chips with actions | navigate / select; pressed state `opacity.pressed` (iOS) or ripple `accentSoft` (Android) |
| Pull to refresh | S10, S20, S30, S31, S11 Subagents | refetch now; the native RefreshControl tinted `accent` |
| Scroll to top edge | S11/S12/S13 chats | load older page (G5) when within 600 pt of the oldest item |
| Swipe back / system back | all pushed screens | native stack back; Android back on a tab root goes to Overview, then exits |
| Swipe down | sheets (M01, M02, M04, S14) | dismiss (blocked while a write is saving) |
| Long-press | message bubble | action sheet: Copy text, Copy as Markdown |
| Long-press | code block, StepRow, cwd, ids, hint rows | copy; toast "Copied" |
| Tap | folded StepGroup / CLI context / clamped bubble | expand in place; state kept while the screen lives |
| Tap | JumpToLatest | animate to newest, hide the button |
| Horizontal scroll | code blocks, tables, FilterChips | inside the element only; never the page |
| Double-tap tab icon | any tab | scroll that tab's root to top |

No swipe actions on questions (prevents accidental answers). No pinch zoom; dynamic type covers size.
Haptics (expo-haptics): selection on OptionCard select and segmented change; success on answer saved; warning on
invalid QR and on write failures. None while scrolling or polling.
Keyboard: the AnswerBar and Composer sit above the keyboard (KeyboardAvoidingView / `keyboardShouldPersistTaps
="handled"`); the focused field scrolls into view.

---

## 6. Notification flows

Scope: one notification type, "owner question waiting". Sent by the PC when an `ask_owner` question opens and as the
existing blocking-question reminder (`questionAlerts.reminderMinutes`). The phone is one more alert channel of
the existing question-alert claim, and `questionAlerts.sound: false` silences it like the others.

Payload (the PC builds it; no question data at all):

```json
{ "title": "agent-bridge", "body": "A question is waiting for you.",
  "data": { "v": 1, "kind": "owner-question", "nonce": "<random 16 bytes, base64url>" },
  "collapseKey": "owner-question", "threadId": "owner-question", "channelId": "owner-questions" }
```

`collapseKey`/`threadId`/a fixed Android notification tag keep at most one visible notification. No badge number
in the payload; the app sets the badge itself after it re-checks.

Android channel: id `owner-questions`, name "Owner questions", importance HIGH, sound default, vibration default,
lock-screen visibility PUBLIC (the text is generic). iOS: default sound, `interruptionLevel` active.

### 6.1 Permission prompt

1. After pairing, S04 explains the notification before the OS prompt.
2. Granted → get the Expo/FCM/APNs device token → `PUT /m/v1/devices/self/push` (G4). Re-send on every app start if
   the token changed.
3. Denied → no further prompts; S42 shows Off with [Open Settings]; the Overview AttentionCard and tab badge still
   work while the app is open.
4. Token registration failed → S42 shows "Couldn't register this phone for notifications. [Try again]".

### 6.2 Arrival

- App in background / closed: the OS shows the generic notification. Nothing else.
- App in foreground: suppress the system banner (`shouldShowAlert: false`), refetch questions at once, then show an
  in-app Toast "New question waiting" with [Open] (accent) when the open count grew; the Questions tab badge updates.
  If the Questions tab is already visible, no toast; the new card appears with its "new" dot.

### 6.3 Tap → detail

```
tap notification
  → app opens (cold: Launch; warm: resume)
  → no credential?                     → S01 (stop)
  → GET /api/approvals (owner questions only)
       revoked (401)                  → S05
       unreachable                    → Questions tab, S30 with Unreachable banner and cached list
       0 open questions               → S30 Open, toast "That question was already answered."
       exactly 1 open question newer
         than lastSeenAskedAt         → S30 then push S31 for it (back goes to the inbox)
       several new                    → S30 Open, new cards marked
  → set lastSeenAskedAt = newest askedAt seen; set the app icon badge to the open count
```

`lastSeenAskedAt` is stored per paired PC in AsyncStorage (a number, not content).
Notifications are cleared from the tray when S30 or S31 becomes visible.

---

## 7. Pairing flow

Security model (decided): private gateway; pairing by a single-use QR shown on the PC and confirmed on the PC;
per-device revocation; contentless push; tap re-checks state.

```
 PC dashboard                          Phone
 ────────────                          ─────
 Network › Pair a phone
   POST /api/mobile/pairings  (G2)
   shows QR + "expires in 4:59"
                                       S02 scans QR (or system camera
                                       opens agentbridge://pair?…)
                                       parses v, gateway addresses,
                                       token, fingerprint, PC name, exp
                                       S03: TLS to the first reachable
                                       address, pin cert fingerprint
                                       POST /m/v1/pair/claim
                                         {token, deviceName, platform,
                                          devicePublicKey}
 Shows request:                         ← 202 {claimId, matchCode}
 "Renne's Pixel 8 (Android) wants      S03 shows matchCode 482 913,
  to connect. Code 482 913.             polls GET /m/v1/pair/claim/<id>
  [Allow] [Reject]"
 owner checks code, Allow
                                        ← 200 {state: approved,
                                          deviceId, credential}
                                       credential → SecureStore
                                       S04 → Overview
```

QR payload (`agentbridge://pair?` URL, query parameters, all required unless noted):

| Param | Meaning |
|---|---|
| `v` | `1` |
| `n` | PC display name (URL-encoded, ≤ 40 chars) |
| `a` | gateway addresses, comma-separated `host:port` (LAN and private-network/VPN), tried in order |
| `t` | one-time pairing token (≥ 128 bits, base64url) |
| `fp` | SHA-256 fingerprint of the gateway TLS key (base64url) |
| `exp` | expiry, Unix seconds (now + 5 min) |

Rules:
- The token is single-use and expires after 5 min (`pairingQrTtlMs`) or after its first claim, whichever comes first.
- `matchCode` = 6 digits derived on both sides from `token` + `devicePublicKey`; the owner compares before Allow.
- Approval happens only on the PC. The phone has no way to approve itself.
- The credential is a per-device secret (or a device-key-signed token) stored with expo-secure-store
  (Keychain / Android Keystore), `requireAuthentication: false`, never in AsyncStorage, never logged.
- Every request sends `Authorization: Bearer <credential>` plus `x-agent-bridge: 1` on writes; TLS is pinned to `fp`.
- Revocation: PC dashboard › Network › Phones lists devices (name, platform, paired at, last seen) with [Revoke]. A
  revoked device gets 401 `{code: "device_revoked"}` on its next request → S05. Its push token is deleted on the PC.
- One phone pairs with one gateway PC in v1. Paired PCs are reached through that PC's existing pairing
  (dashboard-read-v1). Pairing a second gateway is out of scope; S41 shows only one.

---

## 8. Accessibility

Dynamic type
- Every Text uses a typography token; `allowFontScaling` stays on. Caps per token `maxFontSizeMultiplier` (body
  2.0, chips/pills/time 1.4) so badges never explode while content scales.
- Rows never truncate the title to one line at large sizes: titles allow 2 lines, subtitles 2 lines, then ellipsis.
  At font scale ≥ 1.35 the SubagentRow moves the StatusPill below the title instead of beside it, and the StatsStrip
  stacks vertically.
- Touch targets ≥ 44 pt (iOS) / 48 dp (Android); add `hitSlop` to small chips that act.

Contrast (WCAG 2.1 AA, measured; see `tokens.json` meta)
- Body text on panel: 17.2:1 light, 14.4:1 dark. Muted 5.7:1 / 7.8:1. Tertiary text uses `textFaint` (4.7:1 on
  bg light, 5.75:1 on panel dark). `faint` is for icons, rules and hollow dots only.
- Status text on soft fills: ok 4.50, warn 4.57, bad 4.57 (light); 7.7, 8.0, 6.3 (dark). Accent on accentSoft 5.55 /
  4.53.
- Primary buttons: white on `accentFill` 6.29:1 light, 5.54:1 dark.
- Focus ring for hardware keyboards: 2 pt `focusRing`.

Screen readers (VoiceOver / TalkBack)
- Each row is one accessible element with a composed label and a hint; inner chips are not separately focusable.
  - SessionRow: "agent-bridge, Claude, main session, busy, 2 subagents working. Opens the session."
  - SubagentRow: "Fix flaky test, Codex, working, 42 percent, about 12 minutes left, started by
    claude-agent-bridge."
  - QuestionCard: "Urgent, blocking question: Release 0.31 today or wait for the Windows fix? From
    claude-agent-bridge in agent-bridge, 12 minutes ago."
  - OptionCard: role radio, `accessibilityState={{ checked }}`, label "Wait for the fix, recommended. Release
    slips one day."
- Avatars, dots and decorative icons: `accessible={false}` / `importantForAccessibility="no"`.
- Headers use `accessibilityRole="header"` (screen titles, section headers, HostHeader).
- Progress: `accessibilityRole="progressbar"` with `accessibilityValue={{ min: 0, max: 100, now }}`.
- Live updates: never announce poll refreshes. Announce (`AccessibilityInfo.announceForAccessibility`) only: answer
  saved / failed, a new question arriving while the app is open, connection lost / restored, and a status change of
  the subagent on the visible S12 (e.g. "Fix flaky test finished: done").
- Chat lists: newest-last reading order; the LoadOlderRow is a button "Load older messages"; custom action on the
  list "Jump to latest".
- Folded StepGroup: button "9 steps, last: Edit src/x.ts. Expand."; `accessibilityState={{ expanded }}`.

Motion
- Respect Reduce Motion: no pulsing dots (static ring instead), no progress tweening, sheets fade instead of slide.

Language: English only (tool policy). Strings live in one `strings.ts` table so copy stays consistent.

---

## 9. Light and dark mode

- Default follows the OS (`useColorScheme`). Settings › Appearance offers System / Light / Dark, exactly the
  dashboard's three-way switcher; the choice is stored in AsyncStorage (`theme`).
- Colors come only from `tokens.json` `color.light` / `color.dark`; the dashboard's dark theme is "every surface the
  same navy hue": `sunk` (tab bar, nav bar background in dark), `bg` (screen), `panel` (cards, rows), `panel2`
  (assistant bubbles, code, inputs).
- Light surfaces: nav bar and tab bar `panel` with a hairline `line`; screen `bg`; cards `panel` with elevation 1.
- Dark surfaces: nav bar and tab bar `sunk`; screen `bg`; cards `panel`; no shadows (elevation 1 = none), sheets
  elevation 2.
- Status bar: dark-content in light, light-content in dark. Android navigation bar color = tab bar color.
- Agent colors and the logo do not change between themes (same as the dashboard).
- Markdown code blocks use `codeBg`; inline code `inlineCodeBg` in both.
- The QR scanner screen is always dark (camera), regardless of theme.

---

## 10. Data, polling and caching rules

- One `ApiClient` with the gateway base URL, bearer credential, 10 s timeout (`requestTimeoutMs`), JSON only.
- Foreground polling (AppState `active` only; everything stops in background):
  - `/state`: every 3 s while S10, S11, S12 or S20 is visible; every 15 s otherwise.
  - questions: every 5 s on S30/S31, every 15 s elsewhere (badge).
  - chats: section 4 S11/S12 rules.
  - On failure: backoff 1, 2, 4, 8, 15 s (`reconnectBackoffMs`); back to normal on the first success.
- No polling request starts while the previous one for the same resource is in flight (the dashboard's `polling`
  guard).
- Cache: in memory only (state, questions, up to `maxChatItems` = 3000 items per open chat, dropping the oldest).
  Nothing with content is written to disk. AsyncStorage keeps only: theme, collapsed project groups,
  `lastSeenAskedAt`, last chosen Running filter.
- On resume from background: refetch `/state` and questions immediately; banners show "Reconnecting…" until done.
- Remote identities: sessions on paired PCs are `"<pc>/<name>"`; their read routes encode the whole identity as one
  segment (`/api/sessions/<pc>%2F<name>/chat`), exactly like the page.
- Older paired PCs reject `from=tail` with 400: retry the same chat once from the start (`from` omitted), as the
  dashboard does.

---

## 11. API map

All paths are today's dashboard paths; through the gateway they are served under the gateway origin (G1).

| Screen | Reads | Writes |
|---|---|---|
| S10 Overview | `GET /api/state` (`peers`, `runs`, `runsNext`, `jobs`, `remoteErrors`, `brokerState`, `version`); `GET /api/approvals` (count of `kind: "question"`); `GET /api/network` `paired[]` (→ G7) | — |
| S11 Session | `/api/state`; `GET /api/sessions/<name>/chat?from=tail|<next>`; `GET /api/sessions/<name>/subagents` | `POST /api/sessions/<name>/message` (M03); `GET /api/chat-delivery/<id>` |
| S12 Subagent | `/api/state`; `GET /api/runs/<run>?from=<byte>`; `GET /api/runs/<run>/chat?from=`; `GET /api/jobs/<job>/subagents`; `GET /api/job-outcomes?job=<job>` | — |
| S13 Native subagent | `GET /api/sessions/<name>/subagents/<id>?from=` or `GET /api/jobs/<job>/subagents/<id>?from=` | — |
| S14 Host | G7 (today: `/api/network` + `/api/state.version`) | — |
| S20 Running | `/api/state`; `GET /api/runs?before=<cursor>&limit=`; `GET /api/runs?host=<pc>&before=`; `GET /api/job-outcomes?limit=` | — |
| S30 Inbox | `GET /api/approvals` (`approvals[]` open, `questions[]` history) | — |
| S31 / M01 / M02 | `GET /api/approvals` | `POST /api/questions/<id>`; `POST /api/questions/<id>/dismiss` |
| S01–S05, S40–S43 | G2, G3, G4, G14 | G2, G3, G4 |

Response shapes the client relies on (from the source):
- `TranscriptPage { items: TranscriptItem[]; next: string }`, `TranscriptItem { kind: "user"|"assistant"|"tool"|
  "subagent"; at; text?; tool?; summary?; subagent?: {id,title,agent}; id? }` (`src/core/transcripts/common.ts`).
- `NativeSubagent { id; title; status: "unknown"|"running"|"done"|"failed"|"interrupted"; startedAt; updatedAt }`.
- Run log page `{ text, next, size }` (128 KB chunks from byte `from`), recovered `{ recovered: true, hasLog: false }`.
- `RunSummary` (`src/core/dashboard-read.ts`): `name, agent, job?, title?, status, startedAt, updatedAt, task, last,
  percent?, progressNote?, etaAt?, model?, effort?, permission?, access?, parentJob?, by?, host?, hasLog?, recovered?`.
- `OwnerQuestion` (`src/core/owner-questions.ts`): `id, kind: "question", project, title, context, topic, options[
  {id,label,consequence,recommended}], links[], affectedProjects[], job?, blocking, blocks, meanwhile, destructive,
  authorization, urgency, default?, status, askedAt, askers[], answer?, deliveries[], dismissal?, mirror?`.
- Remote errors: `{ code: "remote_offline"|"remote_update_needed"|"remote_timeout"|"remote_busy"|
  "remote_rate_limited"|"remote_response_too_large"|"remote_read_failed", host? }`.

---

## 12. API gaps the implementer must add

| # | Gap | Why | Proposed shape |
|---|---|---|---|
| G1 | Mobile gateway transport and auth | The dashboard listens on 127.0.0.1 only, checks `ALLOWED_HOSTS`, authenticates by an HttpOnly cookie from `?t=`, and the message route requires a local `Origin`. A phone can't use any of that. | A gateway listener on the private network (LAN / VPN interface chosen on the PC), TLS with a self-generated key whose fingerprint goes into the QR, `Authorization: Bearer <device credential>`; serves the read and write routes listed in 11 under `/m/v1/…` (or the same `/api/…` paths) with the same validation; `x-agent-bridge: 1` stays required on writes, the Origin check is replaced by the bearer check for the gateway listener only. Rate-limit per device. |
| G2 | Pairing | No phone pairing exists (`/api/network/pair` pairs PCs). | PC: `POST /api/mobile/pairings` → `{qrUrl, expiresAt}`; `GET /api/mobile/pairings/pending`; `POST /api/mobile/pairings/<claimId>` `{decision: "allow"|"reject"}`; dashboard UI "Network › Pair a phone" with QR and the Allow/Reject card showing device name, platform and match code. Phone: `POST /m/v1/pair/claim` `{token, deviceName, platform, devicePublicKey}` → `202 {claimId, matchCode}`; `GET /m/v1/pair/claim/<claimId>` → `{state: "pending"|"approved"|"rejected"|"expired", deviceId?, credential?}` (credential returned once). |
| G3 | Device registry and revocation | Per-device revocation is part of the security model. | PC: `GET /api/mobile/devices` → `[{id, name, platform, pairedAt, lastSeenAt, push: boolean}]`, `DELETE /api/mobile/devices/<id>`; dashboard list "Network › Phones". Phone: `DELETE /m/v1/devices/self`. All gateway routes return `401 {code: "device_revoked"}` for a revoked credential (distinct from `401 {code: "unauthorized"}`). Never deletes anything but the device record and its push token (retention = archive). |
| G4 | Push | No push channel exists; question alerts are browser/desktop only. | `PUT /m/v1/devices/self/push` `{provider: "expo"|"fcm"|"apns", token}`; `POST /m/v1/devices/self/push/test`. Broker: when a question opens (and on the blocking reminder) send the contentless payload of section 6 to every non-revoked device, as one more channel in the existing `question_alerts` claim, honoring `questionAlerts.sound`/`toast`. Owner-only: never for `job-question` or permission approvals. Needs outbound HTTPS from the PC to the push provider. |
| G5 | Older transcript pages | Transcript reads only move forward (`from=0|<next>|tail`); "load older on scroll" needs a backward cursor. | Every transcript response (sessions chat, session/job native subagents, runs chat) adds `prev: string | null`, the cursor of the page before its first item; requests accept `before=<prev>` returning `{items, prev}` (items oldest-first, ≤ 512 KB). `from=tail` responses must include `prev`. Must also pass through dashboard-read-v1 so paired PCs support it (the request schema already allows a `before` key). |
| G6 | Run log for phones | `/api/runs/<run>` returns raw log text in 128 KB chunks from the start; a long job costs megabytes and the client must duplicate the dashboard's log parser. | `GET /api/runs/<run>?from=tail` + `prev` like G5, and preferably `?format=items` returning parsed entries `{kind: "prompt"|"say"|"answer"|"live"|"sys"|"step", at, who?, label?, text}` produced by the same parser the page uses. Until then the app ports `parseEntries`/`stepsHtml`/`cleanCmd`. |
| G7 | Hosts summary | `/api/network` returns config, addresses, discovery and firewall data the phone must not need. | `GET /m/v1/hosts` → `[{name, self: boolean, connected, version?, lastVerifiedAt?, roundTripMs?, error?: {code}}]`. |
| G8 | Owner questions on paired PCs | `/api/approvals` reads only the gateway PC's `owner-questions.db`; dashboard-read-v1 has no question path. | Add a read-only `/api/questions` path to dashboard-read-v1 and an answer/dismiss forward over the paired link (authenticated as the owner from the gateway PC), then aggregate with `host` per question. Until then the inbox shows the gateway PC's questions only, with the footer note in S30. |
| G9 | Owner-only question endpoint | `/api/approvals` mixes permission approvals and agent-to-agent `job-question` items; the owner-only rule is enforced only by client filtering. | `GET /m/v1/questions?status=open` and `?status=closed&before=<cursor>&limit=` returning `OwnerQuestion[]` only, plus `{openCount}`; the server never returns `job-question` or permission items to the phone. History paginated (it grows forever). |
| G10 | Change detection | Polling full `/api/state` every 3 s on mobile data is heavy. | `ETag` / `If-None-Match` (304) on `/api/state`, questions and hosts; optionally an SSE stream `GET /m/v1/events` with `{type: "state"|"questions"|"chat", key}` invalidation hints (no content). |
| G11 | Phone writes to sessions | `POST /api/sessions/<name>/message` requires a local Origin and the dashboard cookie. | Accept the gateway bearer instead (G1); keep every other check (local sessions only, body limits, supported agents); return the same `{state, transport, text, receipt}`. |
| G12 | Slim overview payload (optional) | `/api/state` also carries `messages`, `health` and all `jobs` settings the phone ignores. | `GET /m/v1/overview` → `{version, brokerState, peers, runs, runsNext, remoteErrors, openQuestionCount}`. |
| G13 | Project grouping for paired PCs (verify) | The page groups only local sessions by `projectGroup` (`!pcOf(x.name)`); confirm that remote peers carry `projectGroup`/`projectMain`/`projectRoot`, else paired PCs show standalone rows. | Forward the three fields in the remote peer projection if missing. |
| G14 | Version handshake | The app must detect an old PC ("Update needed"). | `GET /m/v1/hello` → `{version, pcName, capabilities: ["mobile-v1", "transcript-prev", "run-items", "questions-v1", "push-v1"]}`; the app enables features by capability and shows "Update needed" when `mobile-v1` is missing. |
