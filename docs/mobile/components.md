# agent-bridge mobile: component inventory

Reusable components for the React Native + Expo app described in `DESIGN.md`. All colors, sizes, radii, type
styles and timings come from `tokens.json` through a `useTheme()` hook that returns
`{ colors, status, agent, spacing, radius, type, elevation, size, motion, timing, scheme }` for the active scheme.
No component takes a raw color prop.

Conventions
- Props are TypeScript. `?` = optional. Every pressable component accepts `onPress?`, `disabled?`, `testID?`, and
  sets `accessibilityRole`, `accessibilityLabel` (composed as listed), `accessibilityHint` where noted.
- "States" lists visual states the component must render. Loading skeletons are separate (`Skeleton*`).
- Shared types:

```ts
type AgentKind = "claude" | "codex" | "opencode" | "antigravity" | string;
type Activity = "busy" | "idle" | "connected" | "unavailable" | "offline" | "ended";
type RunStatus = "running" | "done" | "failed" | "interrupted" | "cancelled" | "unknown";
type QuestionStatus = "open" | "answered" | "cancelled" | "superseded";
type Tone = "neutral" | "accent" | "ok" | "warn" | "bad" | "faint";
```

---

## 1. Foundations

### ThemeProvider / useTheme
- Props: `children`, `preference: "system" | "light" | "dark"`.
- Resolves the scheme from `preference` and `useColorScheme()`; exposes tokens; sets StatusBar style and the
  Android navigation bar color (tab bar color).

### AppText
- Props: `variant: keyof typography.scale` (default `body`), `tone?: "text" | "muted" | "faint" | "accent" | "ok" |
  "warn" | "bad" | "onAccent"` (default `text`; `faint` maps to `textFaint`), `numberOfLines?`, `selectable?`,
  `children`.
- Applies `maxFontSizeMultiplier` from the variant. All text in the app goes through AppText.

### Icon
- Props: `name` (from one icon set, e.g. `@expo/vector-icons` Feather/Lucide-style outline), `size?` (default 20),
  `tone?` (as AppText), `accessibilityLabel?` (omit = decorative).
- Names used: grid, activity, help-circle, settings, search, chevron-right, chevron-left, more-horizontal, x,
  check, wifi-off, alert-triangle, link-2-off, bell, camera, zap (torch), copy, arrow-down, send, info.

### Pressable surfaces
- `PressableRow`: full-width pressable with `opacity.pressed` on iOS and an `accentSoft` ripple on Android; min
  height `size.touchTargetMin`.

---

## 2. Status vocabulary

### StatusDot
- Props: `status: Activity | RunStatus`, `size?: "sm" | "md"` (6 / 8).
- Variants: filled dot in `status[x].dot`; `busy`/`running` add a 3 pt ring in `status[x].ring` and pulse
  (`motion.pulse`) unless Reduce Motion; `offline`/`ended` are hollow (1.5 pt border `faint`).
- Decorative (`accessible={false}`): the parent label carries the word.

### StatusPill
- Props: `status: RunStatus | QuestionStatus`, `percent?: number | null`.
- Text: `running` → "working" or "working · 42%"; others their name; question statuses their name.
- Style: radius `pill`, padding 1×8, `caption` weight 600, fg/bg from `status[x]`; `running` shows a 6 pt pulsing dot
  before the text (static under Reduce Motion).
- Max font multiplier 1.4.

### ActivityLabel
- Props: `activity: Activity`, `role?: "main" | "secondary"`.
- Renders `StatusDot` + text "busy" / "idle" / "connected" / "unavailable" / "offline" / "ended", preceded by
  "main ·" / "secondary ·" when grouped. Tone: busy accent, idle ok, unavailable warn, others muted.

### Chip
- Props: `label: string`, `variant?: "neutral" | "main" | "model" | "next" | "own" | "perm-low" | "perm-mid" |
  "perm-high" | "outcome-ok" | "outcome-warn" | "outcome-faint" | "urgent" | "blocking" | "new"`, `icon?`,
  `onPress?` (copy actions), `meter?: 0|1|2|3|4` (effort).
- Style: radius `chip`, padding 1×7, `micro` (not uppercase), transparent border. neutral: `panel2` bg, `textMuted`.
  main/next/own: `accentSoft`/`accent`. perm-*: `status.permission.*`. outcome-*: `status.outcome.*`. urgent:
  `status.urgent`; blocking: `status.blocking`.
- `meter`: four bars 2.5 pt wide, heights 4/6/8/10, `accent` for on, `line` for off (dashboard `.meter`). Effort
  mapping: minimal/low 1, medium 2, high 3, xhigh/max 4; unknown effort names show text only.
- Pressable chips get `hitSlop` to reach the touch target.

### AgentAvatar
- Props: `agent: AgentKind`, `size?: "md" | "sm"` (34 / 24).
- Rounded square (radius `avatar` / `avatarSm`), bg `agent[agent]` or `agent.other`, white initial = first letter
  uppercased, weight 700. Decorative.

### ProgressBar
- Props: `percent: number` (0–100, clamped), `size?: "row" | "large"` (3 / 5 pt), `tone?: "busy"`.
- Track `line` (row) or `panel2` (large); fill `accent`; radius 2; width animates 400 ms ease-out (none under Reduce
  Motion). `accessibilityRole="progressbar"`, value now/min/max.

### EtaText
- Props: `etaAt: number` (ms), `now?: number`.
- Text: minutes = ceil((etaAt − now)/60000); ≤ 0 → "should be done by now"; < 90 → "~n min left"; else "~n.n h left"
  (one decimal, locale formatting). Re-renders every 30 s. `caption`, tone muted; "should be done by now" tone warn.

### RelativeTime
- Props: `at: number`, `style?: "ago" | "clock" | "both"`.
- "ago": "now" (< 1 min), "12 min", "2 h", "Yesterday", weekday, date. "clock": local `HH:mm`. Updates every 30 s.
  `time` type token (tabular numbers).

---

## 3. Layout and navigation

### ScreenHeader (large title root screens)
- Props: `title`, `right?: ReactNode`, `searchField?: ReactNode`.
- iOS-style large title that collapses into the nav bar on scroll (`headerLargeTitle` on native-stack); Android
  shows the same large title in the content that scrolls under a small top app bar. `accessibilityRole="header"`.

### TabBar (bottom tabs)
- Tabs: Overview (grid), Running (activity), Questions (help-circle), Settings (settings).
- Background: `panel` light / `sunk` dark, top hairline `line`; active tint `accent`, inactive `textMuted`; labels
  `micro`.
- Questions tab badge: `Badge` with the open owner-question count (hidden at 0).

### Badge
- Props: `count: number`, `tone?: "warn" | "accent"` (default `warn` for questions, the dashboard's "needs the
  owner" amber).
- Min width 18, height 18, radius 9, `micro` bold tabular; "99+" over 99; fill `warn`, text `onStatusFill`.
  Label "n questions waiting".

### SegmentedControl
- Props: `segments: { key: string; label: string; count?: number }[]`, `value`, `onChange`.
- Track `panel2`, radius `button`; selected segment `panel` with elevation 1 (light) / `accentSoft` (dark), text
  `text` 600; others `textMuted`. Each segment ≥ 44 pt tall. Selection haptic. Role tablist/tab with selected state.

### FilterChips
- Props: `options: { key; label; count? }[]`, `value`, `onChange`.
- Horizontal ScrollView of pill-shaped toggles (radius `round`); selected `accentSoft` bg + `accent` text, others
  `panel` bg + `line` border + `textMuted`.

### SectionHeader
- Props: `title`, `count?`, `right?`.
- `subheadStrong`, `textMuted`; count in `textFaint` after the title. Padding 16 top, 6 bottom.

### HostHeader
- Props: `name`, `isSelf: boolean`, `connected: boolean`, `sessionCount: number`, `onPress`.
- Row: `overline` "THIS PC · office-pc" (self) or "LAPTOP"; right: StatusDot + count or "offline". Tone `textMuted`;
  offline `textFaint`. Label "office-pc, this PC, connected, 5 sessions. Opens host details."

### HostStatusRow
- Props: `kind: "offline" | "error"`, `lastSeenAt?`, `errorCode?`.
- offline: "Not connected · last seen 13:41". error: REMOTE_ERRORS copy (DESIGN.md S10). `callout`, tone muted;
  inside a card with `panel` bg.

### Card / Panel
- Props: `children`, `padded?` (default true), `tone?: "default" | "attention" | "ended"`.
- `panel` bg, radius `card`, elevation 1. `attention`: `warnSoft` bg with a 3 pt `warn` left rule. `ended`: transparent
  bg, 1 pt dashed `line` border.

### Sheet
- Props: `visible`, `onClose`, `title?`, `children`, `dismissible?` (false while saving).
- Bottom sheet, radius `sheet` on top corners, `panel` bg, elevation 2, grabber 36×4 `line`, scrim `scrim`. iOS may use
  `presentation: "formSheet"`; Android a modal bottom sheet. Same layout on both.

### Toast
- Props: `message`, `tone?: "neutral" | "ok" | "warn" | "bad"`, `action?: { label; onPress }`, `duration?`
  (`motion.toastVisibleMs`).
- Top of the screen under the safe area, `panel` bg, elevation 2, radius `card`, 1 pt left rule in the tone color.
  Announced to screen readers. One at a time; a new one replaces the old.

### ConnectionBanner
- Props: `state: "update-needed" | "offline" | "unreachable" | "reconnecting" | "stale" | "bridge-slow"`,
  `pcName`, `lastUpdatedAt?`, `onRetry?`.
- Full-width strip under the nav bar, `subhead`, padding 8×16. offline/reconnecting/stale/bridge-slow: `panel2` bg,
  `textMuted`; unreachable/update-needed: `warnSoft` bg, `text`. Leading icon (wifi-off, spinner, clock,
  alert-triangle). Copy exactly as DESIGN.md section 3. Announces on appearance and on recovery ("Connected
  again").

### InfoBanner
- Props: `tone: "ok" | "warn" | "bad" | "neutral"`, `text`, `action?`.
- Inline (inside content) version of the banner: soft bg of the tone, 3 pt left rule, radius `card`.

### EmptyState
- Props: `icon`, `title`, `body?`, `action?: { label; onPress }`.
- Centered, icon 40 `faint`, title `headline`, body `callout` muted, max width 300.

### ErrorState
- Same as EmptyState with `tone="bad"` icon and a required `action` (usually "Try again").

### Skeletons
- `SkeletonBlock` (`width`, `height`, `radius`), and composed `SkeletonSessionRow`, `SkeletonSubagentRow`,
  `SkeletonQuestionCard`, `SkeletonBubble({ side: "left" | "right" })`. Color `skeleton`, shimmer to
  `skeletonHighlight` over `motion.skeletonShimmerMs` (static under Reduce Motion). Hidden from screen readers; the
  screen sets `accessibilityLabel="Loading"` on its container.

### PrimaryButton / GhostButton / DangerButton
- Props: `label`, `onPress`, `disabled?`, `loading?`, `loadingLabel?`, `icon?`, `fullWidth?`.
- Height 48, radius `button`, `bodyStrong`. Primary: `accentFill` bg, `onAccent` text. Ghost: transparent, 1 pt `line`
  border, `textMuted`; pressed `accentSoft` + `accent` border. Danger: text/border `bad` (outline) or `bad` fill with
  `onStatusFill` for the final confirm. Disabled `opacity.disabled`. Loading: spinner + `loadingLabel` ("Sending…"),
  `accessibilityState={{ busy: true }}`.

### SearchField
- Props: `value`, `onChangeText`, `placeholder` ("Search sessions and subagents").
- `panel` bg (`sunk` in light when on `bg`), radius `button`, focus border `accent`, clear button.

### ThemeSwitcher
- Props: `value: "system" | "light" | "dark"`, `onChange`.
- SegmentedControl with labels "System", "Light", "Dark".

### SettingsRow
- Props: `title`, `value?`, `status?: Activity`, `onPress?`, `destructive?`.
- 48 pt min row, chevron when pressable, value in `textMuted`, destructive title in `bad`.

---

## 4. Overview and lists

### StatsStrip
- Props: `items: { key; value: number; label: string; tone: "busy" | "text" | "ok" | "bad"; onPress? }[]`.
- One `panel` card split into equal cells with 1 pt `line` dividers (dashboard `#ovStats`). Value `stat`, label
  `subhead` muted. Stacks vertically at font scale ≥ 1.35. Each cell label "3 working".

### AttentionCard
- Props: `count: number`, `onPress`.
- Card tone `attention`; text "1 question is waiting for you" / "n questions are waiting for you", chevron. Hidden at 0.

### ProjectGroup
- Props: `title` (project folder), `workingCount: number`, `collapsed`, `onToggle`, `children` (member SessionRows).
- Header row `bodyStrong` with count chip (`accentSoft`/`accent`, "2") and chevron; members are indented 14 pt with a
  1.5 pt `line` left guide (dashboard `.tree-sess.member`). The header is a button with `accessibilityState={{
  expanded }}`, label "agent-bridge project, 2 subagents working, expanded".

### SessionRow
- Props:
  ```ts
  { title: string; name: string; agent: AgentKind; activity: Activity; role?: "main" | "secondary";
    member?: boolean; workingCount?: number; host?: string; ended?: boolean; onPress: () => void }
  ```
- Layout: AgentAvatar (sm when `member`, md otherwise) · title (`bodyStrong`; `member` shows the agent name as
  title like the dashboard sidebar) + "main" Chip when `role === "main"` · second line `subhead` muted: short name ·
  ActivityLabel · "n working" in `accent` when > 0. Right: chevron.
- Variants: standalone, member-main (title `text` 600), member-secondary (title `textMuted` 500), ended
  (`opacity.ended`, activity "ended").
- Label: "<title>, <agent>, <main session|secondary session>, <activity>, <n subagents working>. Opens the session."

### SubagentRow
- Props:
  ```ts
  { title?: string; task: string; agent: AgentKind; model?: string; effort?: string; permission?: string;
    turns: number; status: RunStatus; percent?: number | null; progressNote?: string; etaAt?: number | null;
    updatedAt: number; owner?: string; outcome?: "ok" | "warn" | "faint"; outcomeLabel?: string;
    depth?: 0 | 1 | 2; onPress: () => void }
  ```
- Layout (dashboard `groupRow`): avatar md · line 1 `title` bold (or agent name when no title) + StatusPill (+
  outcome Chip) · line 2 `subhead` muted: "agent · model · effort effort · permission · n turns" (when titled) or the
  task (2 lines) · right column: EtaText while running with `etaAt`, else RelativeTime ago; owner name prefix in the
  Running tab ("claude-agent-bridge · 14:20"). ProgressBar row-size along the bottom edge when `percent` is a
  number. Running rows get a 2 pt `accent` rule on the left edge.
- `depth` 1–2: indented 16 pt per level with the tree guide (1.5 pt `line`, 7 pt bottom-left radius) like `.leaf`.
- At font scale ≥ 1.35 the StatusPill moves under the title.

### NativeSubagentRow
- Props: `title`, `agent`, `status: NativeSubagent["status"]`, `startedAt`, `updatedAt`, `depth?`, `onPress`.
- Compact: avatar sm, title, StatusPill (unknown → "unknown" faint), caption "started 14:05 · updated 14:09".

### LoadMoreButton
- Props: `label` ("Load older subagents"), `loading`, `error?`, `onPress`.
- GhostButton full width; error shows "Couldn't load older subagents. Retry".

---

## 5. Chat

### ChatList
- Props:
  ```ts
  { items: ChatRenderItem[]; onLoadOlder?: () => void; olderState: "idle" | "loading" | "error" | "start" | "unsupported";
    pinnedToLatest: boolean; newCount: number; onJumpToLatest: () => void; header?: ReactNode; footer?: ReactNode }
  ```
- FlatList (or FlashList) rendering newest at the bottom. Recommended: `inverted` list with data reversed so the
  first paint is at the newest item without a scroll jump; `maintainVisibleContentPosition` (iOS and Android with
  RN ≥ 0.72) keeps the position when older items are prepended. `onEndReached` of the inverted list (= top edge)
  calls `onLoadOlder` with threshold 600 pt.
- Padding horizontal `chatPaddingH` 12, gap `chatItemGap` 12.
- `ChatRenderItem` is the output of a pure `buildChatItems(transcriptItems, agent)` (S11 rules) or
  `buildRunItems(logText, agent, owner)` (S12 rules) function, keyed by stable ids (`item.id` or `kind:at:index`).

### MessageBubble
- Props: `side: "left" | "right"`, `variant: "assistant" | "user" | "peer" | "answer" | "live"`, `who?: string`,
  `time?: number`, `agent?: AgentKind`, `markdown: string`, `clamp?: boolean`, `onExpand?`.
- assistant: left, avatar sm, `panel2` bg, 1 pt `line` border, radius 14/14/14/4 (bottom-left tail). user: right,
  `accentSoft` bg, no border, radius 14/14/4/14, `who` "You · 14:02". peer: as assistant with `who` "Message from
  <from>" and the sender agent's avatar. live: right, `who` "<name> · while it works". answer: left, `okSoft` bg, 3 pt
  `ok` left rule, `who` "Answer" in `ok`.
- Padding 10×14, `chat` type, max width 88% of the list. Content via `MarkdownText`.
- Clamp: when `clamp` (user/prompt text > 600 chars) show 220 pt with a fade to the bubble bg and a 30 pt footer "Show
  all ▾" in `accent` on `accentSoft`; tap expands.
- Long-press: action sheet Copy text / Copy as Markdown.
- Label: "<who or agent>, <time>: <first 200 chars>".

### MarkdownText
- Props: `source: string`, `tone?`.
- Uses a markdown renderer (e.g. `react-native-markdown-display`) styled from tokens: paragraphs margin bottom 0.55em,
  headings `headline`, lists indented 1.4em, inline code `monoSmall` on `inlineCodeBg` radius 4, links `accent`
  (open in the system browser after a confirm alert showing the URL), blockquote 3 pt `line` rule + muted, tables
  horizontally scrollable with 1 pt `line` cells, hr 1 pt `line`. Code blocks render `CodeBlock`. No images, no
  HTML.

### CodeBlock
- Props: `code: string`, `language?`.
- `codeBg`, radius 8, padding 10×12, `mono`, horizontal ScrollView, selectable text, long-press copies. No syntax
  highlighting in v1.

### StepGroup
- Props: `steps: { at: number | string; label?: string; text: string }[]`, `foldOver?: number` (3), `expanded`,
  `onToggle`.
- Indent 12 pt, 1 pt `line` left rule, inner padding-left 16 (dashboard `.steps`). ≤ foldOver: all StepRows.
  More: a summary row "▸ n steps · last: <label> <text, 70 chars>" (`subhead` muted, one line); expanded "▾" + all
  rows.
- Button with `expanded` state; label "9 steps, last: …".

### StepRow
- Props: `time: string`, `label?: string`, `text: string`, `onPress`.
- One line: time (`time` token, 44 pt fixed width, `textFaint`), label (`micro` 600 `accent`), text (`monoSmall`
  `textMuted`, ellipsized). Tap opens a Sheet with the full text (CodeBlock) and Copy.

### SystemRow
- Props: `variant: "plain" | "task" | "command" | "output" | "fold"`, `text`, `status?: RunStatus`, `expanded?`,
  `onToggle?`.
- plain: caption `textFaint`, left-aligned with a 36 pt inset (dashboard `.chat .sys`). task: `panel2` pill row with
  StatusPill + "Background task <status> · <summary>". command: `panel2` row, command in `monoSmall accent` + "slash
  command". output: `textFaint`, first 300 chars. fold: "▸ Context added by the CLI", expands to MarkdownText.

### TurnDivider
- Props: `label` ("Task" | "Follow-up n"), `time`, `status: RunStatus`.
- Centered row: hairlines on both sides, `caption` `textFaint` "Task · 14:02" + StatusPill.

### TimeDivider
- Props: `at: number`. Centered caption "14:02", "Yesterday 18:40", or a date.

### SubagentLink
- Props: `title`, `agent?`, `onPress`.
- Row "↳ started its own subagent <title>" with the title in `accent`; `caption`; 36 pt inset.

### LoadOlderRow
- Props: `state: "idle" | "loading" | "error" | "start" | "unsupported"`, `onRetry`.
- loading: spinner + "Loading older messages…"; error: "Couldn't load older messages. Retry"; start: "Beginning of
  the conversation"; unsupported: "Older messages are only on your PC for now."; idle renders a 1 pt spacer.

### JumpToLatest
- Props: `newCount: number`, `visible`, `onPress`.
- Floating round button 44 pt, bottom-right 16 pt above the composer/tab bar, `panel` bg, elevation 2, arrow-down
  icon `accent`, small Badge (accent) with `newCount` when > 0. Label "Jump to latest, n new".

### Composer (optional v1)
- Props: `value`, `onChangeText`, `onSend`, `sending`, `disabled`, `disabledReason?`, `receipt?: { tone; text }`.
- Docked above the keyboard; `panel` bg with top hairline `line`; TextArea `panel2` bg radius `input`, grows to 6
  lines; send IconButton 44 pt `accentFill` with `send` icon. Receipt caption under the field in its tone. Counter
  "7,412 / 8,000" from 7,000 chars.

### SessionHeader / SubagentHeader
- SessionHeader props: `title`, `agent`, `activity`, `role?`, `host`, `onInfo`.
- SubagentHeader props: `title`, `agent`, `model?`, `effort?`, `permission?`, `status`, `percent?`, `progressNote?`,
  `etaAt?`, `owner`, `startedAt`, `workdir?`, `outcome?`.
- Layout per DESIGN.md S11/S12; background `panel`, bottom hairline `line`; wraps freely at large text.

---

## 6. Questions

### QuestionCard (inbox)
- Props:
  ```ts
  { id: string; title: string; project: string; askers: { session: string; job?: string }[]; askedAt: number;
    urgency: "normal" | "urgent"; blocking: boolean; blocks?: string; defaultAt?: number; defaultLabel?: string;
    status: QuestionStatus; answerText?: string; isNew: boolean; onPress: () => void }
  ```
- Card `panel`, radius `card`, padding 16, 1 pt border `accent` at 40% mix with `line` for open questions (dashboard
  `.question-card`). Top row: Chips urgent/blocking + RelativeTime ago (right). Title `headline` 2 lines. Subhead
  muted "project folder · askers". Blocking: "Blocks: <blocks>" caption. Default: caption `warn` "Default
  "<label>" at 18:00". Closed: StatusPill + "Answer: …" 2 lines. `isNew`: 6 pt `accent` dot before the title.

### QuestionHeader
- Props: `status`, `title`, `project`, `askers`, `askedAt`.
- Overline "OWNER QUESTION · OPEN" (`accent`; answered `ok`; dismissed/superseded `textMuted`), title `title`,
  subhead, caption time.

### ContextBlock
- Props: `text`. `panel2` bg, radius `card`, padding 12, `callout`, pre-wrapped, selectable.

### BlockingNote
- Props: `blocking: boolean`, `blocks?: string`, `meanwhile: string`.
- Blocking: `warnSoft` bg with 3 pt `warn` rule: "Blocking: <blocks>" bold + "Meanwhile: <meanwhile>". Non-blocking:
  `panel2` bg: "Non-blocking" + "Meanwhile: …".

### LinkChips
- Props: `links: { kind: "issue" | "file" | "commit" | "artifact" | "diff"; value: string }[]`.
- Wrapping row of neutral Chips "<kind> <value shortened to 24 chars>"; tap copies the full value with toast "Copied".

### OptionCard
- Props: `label`, `consequence`, `recommended: boolean`, `selected: boolean`, `disabled?`, `onSelect`.
- Card with radio indicator (20 pt circle, `accent` when selected), label `bodyStrong`, "Recommended" Chip (main
  variant) on the right when recommended, consequence `subhead` muted. Recommended unselected: 1 pt `accent` border
  and `accent` 10% tint (dashboard `.q-options .recommended`). Selected: 1.5 pt `accent` border, `accentSoft` bg.
  Min height 56. Role radio.

### AnswerTextArea
- Props: `value`, `onChangeText`, `disabled?`, `maxLength` 8000.
- Placeholder "Your answer". `panel2` bg, radius `input`, min 3 lines, grows to 8.

### PinToggle
- Props: `pinned`, `onPinnedChange`, `scope: "project" | "all"`, `onScopeChange`.
- Switch "This is a lasting rule" + caption "Pin it as a decision"; when on, a SegmentedControl "This project | All
  projects" under it.

### AnswerBar
- Props: `canSend`, `state: "idle" | "saving" | "timeout" | "error"`, `disabledReason?`, `onSend`, `onCheckAgain`.
- Sticky bottom, `panel` bg + top hairline; PrimaryButton "Send answer" (`loadingLabel` "Sending…"); caption
  "An answer is not tool permission or implementation acceptance." (`textFaint`). Timeout/error render an InfoBanner
  above the button (DESIGN.md S31 copy).

### AnsweredBlock
- Props: `answer: { text; option?; author: { name }; at; source: "owner" | "declared-default"; decisionId? }`,
  `deliveries: { recipient; state; detail; readAt }[]`, `mirror?`, `dismissal?`.
- Answer in AnswerBubble style (okSoft + ok rule), meta caption, "declared default, not the owner" Chip (warn) when
  applicable, DeliveryRow list, Pair Desk mirror caption.

### DeliveryRow
- Props: `recipient`, `state`, `detail`, `readAt?`.
- StatusDot (read → ok, pending/wake-requested/busy → accent, offline/wake-unavailable → faint, failed/unconfirmed →
  bad) + recipient + state text ("read 14:15") + detail caption.

---

## 7. Pairing

### QrScanner
- Props: `onCode(data: string)`, `torch`, `onTorchChange`.
- expo-camera `CameraView` with `barcodeScannerSettings={{ barcodeTypes: ["qr"] }}`; dark overlay with a 248 pt
  clear square and four `accent` corner marks (4 pt, 28 pt long). Debounces scans (one per 1.5 s).

### PairingCode
- Props: `code: string` (6 digits).
- Mono 32 pt, letter spacing 4, split "482 913", in an `accentSoft` box radius `card`, padding 16×24. Read digit by
  digit by screen readers ("4 8 2, 9 1 3").

### FingerprintText
- Props: `fingerprint: string`. `monoSmall` `textFaint`, grouped in 4s with "·", first 4 and last 4 groups shown.

### FeatureRow
- Props: `icon`, `text`. Icon 20 `accent` + `callout`.
