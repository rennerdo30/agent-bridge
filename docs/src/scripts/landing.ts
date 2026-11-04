// Landing page behaviour: the switchboard demo, the dashboard tabs and copy buttons.
// Everything is progressive: without JavaScript the page still reads top to bottom.

type Tone = "msg" | "job" | "ask" | "done" | "remote";
type Step =
  | { at: number; send: [string, string]; tone?: Tone }
  | { at: number; state: [string, string, ("busy" | "idle" | "ask" | "off")?] }
  | { at: number; log: string; tone?: Tone };

const scenes: Record<string, Step[]> = {
  review: [
    { at: 0, log: "you → claude-shop  “Ask Codex to review src/auth.”", tone: "msg" },
    { at: 0, send: ["you", "claude"], tone: "msg" },
    { at: 900, state: ["claude", "busy", "busy"] },
    { at: 1300, send: ["claude", "codex"], tone: "msg" },
    { at: 1300, log: "claude-shop → codex-shop  review request: diff in src/auth", tone: "msg" },
    { at: 2300, state: ["codex", "woken · reviewing", "busy"] },
    { at: 4300, send: ["codex", "claude"], tone: "done" },
    { at: 4300, log: "codex-shop → claude-shop  2 findings: token expiry, missing test", tone: "done" },
    { at: 5300, state: ["codex", "idle", "idle"] },
    { at: 5600, send: ["claude", "you"], tone: "done" },
    { at: 5600, log: "claude-shop → you  “Codex found 2 issues. Fixing the expiry check now.”" },
    { at: 6600, state: ["claude", "idle", "idle"] },
  ],
  split: [
    { at: 0, log: "you → claude-shop  “Two Codex subagents in worktrees: tests and fix.”", tone: "msg" },
    { at: 0, send: ["you", "claude"], tone: "msg" },
    { at: 1000, send: ["claude", "codex"], tone: "job" },
    { at: 1000, log: "spawn codex · edit · worktree agent-bridge/write-tests", tone: "job" },
    { at: 1300, send: ["claude", "opencode"], tone: "job" },
    { at: 1300, log: "spawn opencode · edit · worktree agent-bridge/fix-parser", tone: "job" },
    { at: 2100, state: ["codex", "job · tests 12%", "busy"] },
    { at: 2400, state: ["opencode", "job · fix 18%", "busy"] },
    { at: 3300, state: ["codex", "job · tests 64% · ~2 min", "busy"] },
    { at: 3600, state: ["opencode", "job · fix 71% · ~1 min", "busy"] },
    { at: 4800, send: ["opencode", "claude"], tone: "done" },
    { at: 4800, log: "opencode job done · 3 files changed · checklist 4/4", tone: "done" },
    { at: 5200, state: ["opencode", "idle", "idle"] },
    { at: 5800, send: ["codex", "claude"], tone: "done" },
    { at: 5800, log: "codex job done · 9 tests added · all passing", tone: "done" },
    { at: 6200, state: ["codex", "idle", "idle"] },
  ],
  ask: [
    { at: 0, state: ["antigravity", "writing docs", "busy"] },
    { at: 0, log: "agy-docs is rewriting the install guide" },
    { at: 1200, send: ["antigravity", "you"], tone: "ask" },
    { at: 1200, log: "ask_owner  “Keep the old flag name, or rename it?”", tone: "ask" },
    { at: 2200, state: ["you", "1 question · chime", "ask"] },
    { at: 2200, state: ["antigravity", "continues meanwhile", "busy"] },
    { at: 4000, send: ["you", "antigravity"], tone: "done" },
    { at: 4000, log: "you answered  “Keep it.”  · pinned as a project decision", tone: "done" },
    { at: 4500, state: ["you", "watching", "idle"] },
    { at: 5200, state: ["antigravity", "idle", "idle"] },
    { at: 5200, log: "every later session in this project sees the decision" },
  ],
  handoff: [
    { at: 0, state: ["claude", "3 subagents running", "busy"] },
    { at: 0, state: ["muse", "job · refactor 40%", "busy"] },
    { at: 0, log: "claude-shop supervises 3 running jobs" },
    { at: 1000, log: "you → claude-shop  “Hand your subagents to codex-shop, I'm closing.”", tone: "msg" },
    { at: 1000, send: ["you", "claude"], tone: "msg" },
    { at: 2200, send: ["claude", "codex"], tone: "job" },
    { at: 2200, log: "handoff_subagents → codex-shop  3 jobs, chats and checklists", tone: "job" },
    { at: 3200, state: ["claude", "closed", "off"] },
    { at: 3200, state: ["codex", "supervising 3 jobs", "busy"] },
    { at: 4300, send: ["muse", "codex"], tone: "done" },
    { at: 4300, log: "muse job done → reported to codex-shop, nothing lost", tone: "done" },
    { at: 4900, state: ["muse", "idle", "idle"] },
    { at: 6000, state: ["claude", "idle", "idle"] },
    { at: 6000, state: ["codex", "idle", "idle"] },
  ],
  remote: [
    { at: 0, log: "claude-shop → studio-pc  spawn codex in E:/repos/shop (remote job)", tone: "remote" },
    { at: 0, send: ["claude", "pc"], tone: "remote" },
    { at: 1100, state: ["pc", "codex job · Mac build", "busy"] },
    { at: 1100, log: "studio-pc accepted: allowed agent, allowed folder" },
    { at: 3200, send: ["pc", "claude"], tone: "done" },
    { at: 3200, log: "studio-pc → claude-shop  build passed · send_files: build.log", tone: "done" },
    { at: 4200, state: ["pc", "paired · TLS 1.3", "idle"] },
    { at: 4400, send: ["claude", "you"], tone: "done" },
    { at: 4400, log: "claude-shop → you  “The Mac build passes on studio-pc.”" },
  ],
};

const HOP = 520; // ms per wire, node to hub or hub to node

function setupBoard(root: HTMLElement) {
  const stage = root.querySelector<HTMLElement>("[data-board]");
  const packets = root.querySelector<HTMLElement>("[data-packets]");
  const feed = root.querySelector<HTMLOListElement>("[data-feed]");
  const buttons = [...root.querySelectorAll<HTMLButtonElement>("[data-scene]")];
  if (!stage || !packets || !feed || !buttons.length) return;

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pos = (id: string) => {
    const el = stage.querySelector<HTMLElement>(`[data-node="${id}"]`);
    return { x: parseFloat(el?.style.left ?? "50"), y: parseFloat(el?.style.top ?? "50") };
  };
  const defaults: Record<string, string> = { you: "watching", pc: "paired · TLS 1.3" };

  let timers: number[] = [];
  let current = 0;
  let pinned = false;
  let visible = true;

  function reset() {
    timers.forEach(clearTimeout);
    timers = [];
    packets!.replaceChildren();
    feed!.replaceChildren();
    stage!.querySelectorAll<HTMLElement>("[data-node]").forEach((n) => {
      n.dataset.mode = "idle";
      const s = n.querySelector<HTMLElement>("[data-state]");
      if (s) s.textContent = defaults[n.dataset.node!] ?? "idle";
    });
    stage!.querySelectorAll("line").forEach((l) => l.classList.remove("hot"));
  }

  function flash(id: string) {
    const line = stage!.querySelector(`[data-wire="${id}"]`);
    line?.classList.add("hot");
    timers.push(window.setTimeout(() => line?.classList.remove("hot"), HOP * 2));
  }

  function send(from: string, to: string, tone: Tone = "msg") {
    flash(from);
    timers.push(window.setTimeout(() => flash(to), HOP));
    if (reduced) return;
    const dot = document.createElement("span");
    dot.className = `packet ${tone}`;
    packets!.append(dot);
    const a = pos(from), b = pos(to);
    const anim = dot.animate(
      [
        { left: `${a.x}%`, top: `${a.y}%`, opacity: 0 },
        { opacity: 1, offset: 0.08 },
        { left: "50%", top: "50%", offset: 0.5 },
        { opacity: 1, offset: 0.92 },
        { left: `${b.x}%`, top: `${b.y}%`, opacity: 0 },
      ],
      { duration: HOP * 2, easing: "cubic-bezier(.45,0,.55,1)" },
    );
    anim.onfinish = () => dot.remove();
  }

  function log(text: string, tone?: Tone) {
    const li = document.createElement("li");
    if (tone) li.className = tone;
    li.textContent = text;
    feed!.append(li);
    while (feed!.children.length > 5) feed!.firstElementChild?.remove();
  }

  function play(index: number) {
    reset();
    current = index;
    buttons.forEach((b, i) => b.setAttribute("aria-pressed", String(i === index)));
    const steps = scenes[buttons[index].dataset.scene!] ?? [];
    let end = 0;
    for (const step of steps) {
      end = Math.max(end, step.at);
      timers.push(
        window.setTimeout(() => {
          if ("send" in step) send(step.send[0], step.send[1], step.tone);
          else if ("state" in step) {
            const n = stage!.querySelector<HTMLElement>(`[data-node="${step.state[0]}"]`);
            if (n) {
              n.dataset.mode = step.state[2] ?? "busy";
              const s = n.querySelector<HTMLElement>("[data-state]");
              if (s) s.textContent = step.state[1];
            }
          } else log(step.log, step.tone);
        }, reduced ? 0 : step.at),
      );
    }
    if (!reduced) {
      timers.push(
        window.setTimeout(() => {
          if (visible) play((current + 1) % buttons.length);
          else pinned = false;
        }, end + 3200),
      );
    }
  }

  buttons.forEach((b, i) =>
    b.addEventListener("click", () => {
      pinned = true;
      play(i);
    }),
  );

  // Pause the loop while the board is off screen and resume where it was.
  new IntersectionObserver(([entry]) => {
    const was = visible;
    visible = entry.isIntersecting;
    if (visible && !was && !pinned) play(current);
  }).observe(root);

  play(0);
}

function setupTabs() {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('.tabs [role="tab"]')];
  const select = (tab: HTMLButtonElement) => {
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(t.getAttribute("aria-controls")!);
      if (panel) panel.hidden = !on;
    });
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!d) return;
      const next = tabs[(i + d + tabs.length) % tabs.length];
      next.focus();
      select(next);
    });
  });
}

function setupCopy() {
  document.querySelectorAll<HTMLElement>("[data-copy]").forEach((box) => {
    const button = box.querySelector<HTMLButtonElement>(".copy");
    button?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(box.dataset.copy!);
        button.textContent = "Copied";
      } catch {
        button.textContent = "Select it";
      }
      setTimeout(() => (button.textContent = "Copy"), 1600);
    });
  });
}

export function initLanding() {
  const board = document.querySelector<HTMLElement>(".board");
  if (board) setupBoard(board);
  setupTabs();
  setupCopy();
}
