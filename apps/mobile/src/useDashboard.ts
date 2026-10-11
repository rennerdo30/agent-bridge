import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, AppState, BackHandler, Platform } from "react-native";
import * as Device from "expo-device";
import { client } from "./native";
import { ClientFault, parseQr, type ChatItem, type Job, type Question, type Session } from "./client";
import type { PairingClaim, PairingQr } from "../../../src/mobile/contract";
import { watchNotificationTaps } from "./notifications";
import { back, type Navigation, type Route, type Tab } from "./navigation";
import { AnswerLatch, choice, choose, draftKey, emptyDraft, mergeChat, stillConfirmed, type Draft, type JobFilter } from "./view-model";
export function useDashboard() {
  const [state, setState] = useState(client.state), [nav, setNav] = useState<Navigation>({ tab: "overview", route: null });
  const [notice, setNotice] = useState<string | null>(null), [now, setNow] = useState(Date.now());
  const [search, setSearch] = useState(""), [filter, setFilter] = useState<JobFilter>("all"), [history, setHistory] = useState(false), [collapsed, setCollapsed] = useState<string[]>([]);
  const [qr, setQr] = useState<PairingQr | null>(null), [claim, setClaim] = useState<PairingClaim | null>(null), [pairBusy, setPairBusy] = useState(false), [scanning, setScanning] = useState(false), [primer, setPrimer] = useState(false);
  const [older, setOlder] = useState<{ sessions: Session[]; jobs: Job[]; questions: Question[] }>({ sessions: [], jobs: [], questions: [] });
  const [pages, setPages] = useState({ sessions: null as string | null, jobs: null as string | null, questions: null as string | null }), [pageBusy, setPageBusy] = useState(false);
  const [content, setContent] = useState<ChatItem[]>([]), [nextContent, setNextContent] = useState<string | null>(null), [steps, setSteps] = useState<string[]>([]), [nextSteps, setNextSteps] = useState<string | null>(null), [contentBusy, setContentBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({}), [seen, setSeen] = useState<string[]>([]), [unconfirmed, setUnconfirmed] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<{ key: string; question: Question; draft: Draft } | null>(null), [answerBusy, setAnswerBusy] = useState(false);
  const sending = useRef(new AnswerLatch()), alive = useRef(true), current = useRef({ state, nav, older }); current.current = { state, nav, older };
  const sessions = [...(state.snapshot?.sessions ?? []), ...older.sessions], jobs = [...(state.snapshot?.jobs ?? []), ...older.jobs], questions = [...(state.snapshot?.questions ?? []), ...older.questions];
  const routeId = nav.route && "id" in nav.route ? nav.route.id : null;
  const session = nav.route?.kind === "session" ? sessions.find(i => i.id === routeId) : undefined;
  const job = nav.route?.kind === "job" ? jobs.find(i => i.id === routeId) : undefined;
  const question = nav.route?.kind === "question" ? questions.find(i => i.id === routeId) : undefined;
  const key = state.snapshot && question ? draftKey(state.snapshot, question) : "", draft = drafts[key] ?? emptyDraft();
  const safe = (action: () => Promise<unknown>) => { void action().catch(e => { if (alive.current) setNotice(e instanceof ClientFault ? e.message : "Request unavailable. Check the PC and refresh."); }); };
  const open = (route: Route) => { setNav(n => ({ ...n, route })); if (route.kind === "question") setSeen(s => [...new Set([...s, route.id])]); };
  const tab = (value: Tab) => setNav({ tab: value, route: null });
  const goBack = () => { setConfirmation(null); setNav(n => back(n) ?? n); };
  useEffect(() => {
    alive.current = true;
    const sub = client.subscribe(() => setState(client.state));
    const app = AppState.addEventListener("change", v => client.setForeground(v === "active"));
    void client.initialize().catch(() => setNotice("Reconnect to the PC to check this connection."));
    const taps = watchNotificationTaps(client, id => {
      setNav({ tab: "questions", route: null });
      // The resolver already reauthenticates and fetches. Do not route from notification content.
      if (client.state.snapshot?.questions.some(q => q.id === id)) open({ kind: "question", id });
      else setNotice("This question is outside the current page or unavailable. Refresh the inbox.");
    }, setNotice);
    let stopped = false, timer: ReturnType<typeof setTimeout>, delay = 3000;
    const poll = async () => { if (stopped) return; await client.sync().catch(() => {}); delay = client.state.connection === "ready" ? 3000 : Math.min(15000, delay * 2); if (!stopped) timer = setTimeout(() => { void poll(); }, delay + Math.random() * 400); };
    timer = setTimeout(() => { void poll(); }, 3000);
    // Redraw freshness/expiry and relative times; this never changes client authority.
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { alive.current = false; stopped = true; clearTimeout(timer); clearInterval(clock); sub(); taps(); app.remove(); client.setForeground(false); };
  }, []);
  useEffect(() => { const sub = BackHandler.addEventListener("hardwareBackPress", () => { if (scanning) { setScanning(false); return true; } if (confirmation && !sending.current.busy) { setConfirmation(null); return true; } if (back(nav)) { goBack(); return true; } return false; }); return () => sub.remove(); }, [nav, scanning, confirmation]);
  useEffect(() => {
    setOlder({ sessions: [], jobs: [], questions: [] }); setPages(state.snapshot?.pages ?? { sessions: null, jobs: null, questions: null });
    const valid = new Set(state.snapshot?.questions.map(q => draftKey(state.snapshot!, q)) ?? []);
    setDrafts(d => Object.fromEntries(Object.entries(d).filter(([k]) => valid.has(k))));
    if (confirmation && !valid.has(confirmation.key)) setConfirmation(null);
    setUnconfirmed(ids => ids.filter(id => state.snapshot?.questions.some(q => q.id === id && q.status === "open")));
  }, [state.snapshot?.cursor]);
  useEffect(() => { if (state.connection === "unpaired" || state.connection === "revoked") { setNav({ tab: "overview", route: null }); setDrafts({}); setConfirmation(null); setContent([]); setSteps([]); setOlder({ sessions: [], jobs: [], questions: [] }); setSeen([]); setUnconfirmed([]); } }, [state.connection]);
  useEffect(() => {
    if (!claim) return; let active = true, busy = false;
    const timer = setInterval(() => { if (busy || !active) return; busy = true; void client.pollPairing().then(result => { if (!active || result.state === "pending") return; setClaim(null); setQr(null); if (result.state === "approved") setPrimer(true); else setNotice(`Pairing ${result.state}. Check the PC before starting a new QR.`); }).catch(() => { if (active) { setClaim(null); setQr(null); setNotice("Pairing unconfirmed. Check/revoke the phone on the PC and use a new QR; do not retry issuance."); } }).finally(() => { busy = false; }); }, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [claim]);
  useEffect(() => {
    setContent([]); setNextContent(null); setSteps([]); setNextSteps(null);
    const item = session ?? job; if (!item) return; let active = true, busy = false;
    const load = async () => { if (busy || client.state.connection !== "ready") return; busy = true; setContentBusy(true); try { if (item.chatId) { const page = await client.page<ChatItem>(`/chats/${item.chatId}`); if (active) { setContent(prior => mergeChat(prior, page.items)); setNextContent(page.next); } } if (job?.hasSteps) { const page = await client.page<{ text: string }>(`/jobs/${job.id}/steps`); if (active) { setSteps(page.items.map(i => i.text)); setNextSteps(page.next); } } } catch { if (active) setNotice("Conversation unavailable. Refresh the authoritative view."); } finally { busy = false; if (active) setContentBusy(false); } };
    void load(); const timer = setInterval(() => { void load(); }, 5000); return () => { active = false; clearInterval(timer); };
  }, [session?.id, session?.generation, job?.id, state.connection]);
  const loadMore = async (kind: "sessions" | "jobs" | "questions") => { const cursor = pages[kind], view = client.state.snapshot?.cursor; if (!cursor || pageBusy) return; setPageBusy(true); try { const page = await client.page<Session | Job | Question>(`/${kind}?cursor=${encodeURIComponent(cursor)}`); if (view !== client.state.snapshot?.cursor) return; setOlder(p => ({ ...p, [kind]: [...p[kind], ...page.items].slice(-3000) })); setPages(p => ({ ...p, [kind]: page.next })); } finally { setPageBusy(false); } };
  const loadContent = async (kind: "chat" | "steps") => { if (contentBusy) return; const item = session ?? job, id = nav.route?.kind === "session" || nav.route?.kind === "job" ? nav.route.id : null; if (!item) return; setContentBusy(true); try { if (kind === "chat" && nextContent && item.chatId) { const p = await client.page<ChatItem>(`/chats/${item.chatId}?cursor=${encodeURIComponent(nextContent)}`); if (current.current.nav.route && "id" in current.current.nav.route && current.current.nav.route.id === id) { setContent(v => mergeChat(v, p.items)); setNextContent(p.next); } } if (kind === "steps" && nextSteps && job) { const p = await client.page<{ text: string }>(`/jobs/${job.id}/steps?cursor=${encodeURIComponent(nextSteps)}`); if (current.current.nav.route && "id" in current.current.nav.route && current.current.nav.route.id === id) { setSteps(v => [...v, ...p.items.map(i => i.text)].slice(-100)); setNextSteps(p.next); } } } finally { setContentBusy(false); } };
  const updateDraft = (change: { option: string } | { text: string }) => { if (question && client.canAnswer(question) && !sending.current.busy) setDrafts(d => ({ ...d, [key]: choose(d[key] ?? emptyDraft(), change) })); };
  const review = () => { if (question && client.canAnswer(question) && choice(draft) && !unconfirmed.includes(question.id) && !sending.current.busy) setConfirmation({ key, question, draft: { ...draft } }); };
  const sendAnswer = async () => {
    const captured = confirmation, s = client.state.snapshot, currentQuestions = [...(s?.questions ?? []), ...current.current.older.questions], q = captured && currentQuestions.find(q => q.id === captured.question.id);
    if (!captured || sending.current.busy || !q || !stillConfirmed(captured.key, s, q, client.canAnswer(q))) { setConfirmation(null); setNotice("Question or connection changed. Refresh and review the current terms."); return; }
    const intent = choice(captured.draft); if (!intent) return; sending.current.take(); setAnswerBusy(true); setConfirmation(null);
    try { await client.answer(q, intent); if (alive.current) { setDrafts(d => { const copy = { ...d }; delete copy[captured.key]; return copy; }); setNotice("Answer saved. Delivery and task acceptance are separate."); AccessibilityInfo.announceForAccessibility("Answer saved"); } }
    catch (e) { if (alive.current) { if (e instanceof ClientFault && e.unconfirmed) { setUnconfirmed(v => [...new Set([...v, q.id])]); setNotice("Answer unconfirmed. Check again to read the PC state; no automatic resend."); } else setNotice(e instanceof ClientFault ? e.message : "Answer unconfirmed. Check the PC before submitting again."); AccessibilityInfo.announceForAccessibility("Answer not confirmed"); } }
    finally { sending.current.release(); if (alive.current) setAnswerBusy(false); }
  };
  const checkAnswer = async () => { await client.sync(); if (client.state.connection !== "ready") return; setUnconfirmed(ids => ids.filter(i => i !== question?.id)); setConfirmation(null); if (key) setDrafts(d => ({ ...d, [key]: emptyDraft() })); setNotice("Current PC state fetched. Review its terms before any new answer."); };
  const scan = (data: string) => { try { const parsed = parseQr(data); setQr(parsed); setScanning(false); } catch { setNotice("QR invalid or expired. Show a new 120-second QR on the PC."); } };
  const pair = async () => { if (!qr || pairBusy) return; setPairBusy(true); try { setClaim(await client.beginPairing(qr, Device.deviceName ?? "Phone", Platform.OS === "ios" ? "ios" : "android")); } catch (e) { setQr(null); setNotice(e instanceof ClientFault ? `${e.message}. Check/revoke on the PC before a new QR.` : "Pairing unconfirmed. Check/revoke on the PC before a new QR."); } finally { setPairBusy(false); } };
  return { state, nav, notice, setNotice, now, search, setSearch, filter, setFilter, history, setHistory, collapsed, setCollapsed, qr, claim, pairBusy, scanning, setScanning, primer, setPrimer, scan, pair, cancelPair: () => { setQr(null); setClaim(null); setNotice("Cancel/revoke the previous pairing on the PC before using a new QR."); }, sessions, jobs, questions, session, job, question, pages, pageBusy, loadMore, content, steps, nextContent, nextSteps, contentBusy, loadContent, draft, updateDraft, confirmation, setConfirmation, answerBusy, unconfirmed, review, sendAnswer, checkAnswer, seen, safe, open, tab, goBack, client };
}
export type Dashboard = ReturnType<typeof useDashboard>;
