import React, { useEffect, useState } from "react";
import { AccessibilityInfo, AppState, FlatList, Modal, Platform, Pressable, ScrollView, StatusBar, StyleSheet, Text, TextInput, useColorScheme, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { client } from "./src/native";
import { enableNotifications, watchNotificationTaps } from "./src/notifications";
import { ClientFault, parseQr, type ChatItem, type Job, type Page, type Question, type Session } from "./src/client";
import type { PairingClaim, PairingQr } from "../../src/mobile/contract";
import tokens from "./src/tokens.json";
import { strings as s } from "./src/strings";

type Tab = "overview" | "running" | "inbox" | "phone";
type Detail = { kind: "session"; item: Session } | { kind: "job"; item: Job } | { kind: "question"; item: Question };
export default function App() { return <SafeAreaProvider><Dashboard /></SafeAreaProvider>; }
function Dashboard() {
  const system = useColorScheme(), [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  const color = tokens.color[theme === "system" ? system === "dark" ? "dark" : "light" : theme];
  const [state, setState] = useState(client.state), [tab, setTab] = useState<Tab>("overview"), [detail, setDetail] = useState<Detail | null>(null);
  const [notice, setNotice] = useState<string | null>(null), [qr, setQr] = useState<PairingQr | null>(null), [claim, setClaim] = useState<PairingClaim | null>(null), [scanning, setScanning] = useState(false);
  const [camera, requestCamera] = useCameraPermissions(), [pairBusy, setPairBusy] = useState(false);
  const [older, setOlder] = useState<{ sessions: Session[]; jobs: Job[]; questions: Question[] }>({ sessions: [], jobs: [], questions: [] });
  const [pages, setPages] = useState<{ sessions: string | null; jobs: string | null; questions: string | null }>({ sessions: null, jobs: null, questions: null });
  const [pageBusy, setPageBusy] = useState(false);
  const [content, setContent] = useState<ChatItem[]>([]), [nextContent, setNextContent] = useState<string | null>(null), [steps, setSteps] = useState<string[]>([]), [nextSteps, setNextSteps] = useState<string | null>(null), [contentBusy, setContentBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null), [answerText, setAnswerText] = useState(""), [confirm, setConfirm] = useState(false);
  const [pushQuestionId, setPushQuestionId] = useState<string | null>(null);
  const safe = (action: () => Promise<unknown>) => { void action().catch(error => setNotice(error instanceof ClientFault ? error.message : "Request failed. Reconnect to check current state.")); };
  useEffect(() => {
    const unsubscribe = client.subscribe(() => setState(client.state));
    const appState = AppState.addEventListener("change", value => client.setForeground(value === "active"));
    void client.initialize().catch(error => setNotice(error instanceof Error ? error.message : "Reconnect to the PC"));
    const taps = watchNotificationTaps(client, id => { setTab("inbox"); setPushQuestionId(id); }, setNotice);
    let stopped = false, timer: ReturnType<typeof setTimeout>, backoff = 3000;
    const poll = async () => {
      if (stopped) return;
      await client.sync().catch(() => {});
      backoff = client.state.connection === "ready" ? 3000 : Math.min(15_000, backoff * 2);
      if (!stopped) timer = setTimeout(() => { void poll(); }, backoff + Math.random() * 400);
    };
    timer = setTimeout(() => { void poll(); }, 3000);
    return () => { stopped = true; clearTimeout(timer); taps(); unsubscribe(); appState.remove(); client.setForeground(false); };
  }, []);
  useEffect(() => {
    setOlder({ sessions: [], jobs: [], questions: [] }); setPages(state.snapshot?.pages ?? { sessions: null, jobs: null, questions: null });
    if (detail?.kind === "question") { const current = state.snapshot?.questions.find(q => q.id === detail.item.id); if (current) setDetail({ kind: "question", item: current }); }
  }, [state.snapshot?.cursor]);
  useEffect(() => {
    if (!pushQuestionId || !state.snapshot) return;
    const q = state.snapshot.questions.find(q => q.id === pushQuestionId);
    if (q) { setDetail({ kind: "question", item: q }); setPushQuestionId(null); }
    else { setNotice("The question is outside the first page or is no longer available. Refresh the inbox."); setPushQuestionId(null); }
  }, [pushQuestionId, state.snapshot]);
  useEffect(() => {
    if (!claim) return;
    let active = true, inFlight = false;
    const timer = setInterval(() => {
      if (inFlight || !active) return;
      inFlight = true;
      void client.pollPairing().then(result => { if (!active) return; if (result.state !== "pending") { setClaim(null); setQr(null); if (result.state !== "approved") setNotice("Pairing " + result.state + ". Revoke on the PC and start a new pairing if issuance was lost."); } }).catch(error => { if (active) { setClaim(null); setNotice(error instanceof Error ? error.message : "Pairing unconfirmed"); } }).finally(() => { inFlight = false; });
    }, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [claim]);
  useEffect(() => {
    setContent([]); setNextContent(null); setSteps([]); setNextSteps(null); setSelected(null); setAnswerText("");
    if (!detail || detail.kind === "question") return;
    let active = true, inFlight = false;
    const load = async () => {
      if (inFlight || state.connection !== "ready") return;
      inFlight = true;
      try {
        if (detail.item.chatId) { const page = await client.page<ChatItem>(`/chats/${detail.item.chatId}`); if (active) { setContent(page.items); setNextContent(page.next); } }
        if (detail.kind === "job" && detail.item.hasSteps) { const page = await client.page<{ text: string }>(`/jobs/${detail.item.id}/steps`); if (active) { setSteps(page.items.map(i => i.text)); setNextSteps(page.next); } }
      } catch (error) { if (active) setNotice(error instanceof Error ? error.message : "Chat unavailable"); }
      finally { inFlight = false; }
    };
    void load(); const timer = setInterval(() => { void load(); }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [detail?.kind, detail?.item.id, state.connection]);
  const text = (value: string, muted = false) => <Text style={{ color: muted ? color.textMuted : color.text, fontSize: 16, lineHeight: 24 }} maxFontSizeMultiplier={2}>{value}</Text>;
  const button = (label: string, onPress: () => void, disabled = false, primary = false) => <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={[styles.button, { backgroundColor: primary ? color.accentFill : color.panel2, borderColor: color.line, opacity: disabled ? 0.5 : 1 }]}><Text style={{ color: primary ? color.onAccent : color.accent, fontSize: 16, fontWeight: "600" }} maxFontSizeMultiplier={2}>{label}</Text></Pressable>;
  const card = (key: string, title: string, subtitle: string, onPress?: () => void) => <Pressable key={key} disabled={!onPress} accessibilityRole={onPress ? "button" : undefined} accessibilityLabel={`${title}, ${subtitle}`} onPress={onPress}
    style={[styles.card, { backgroundColor: color.panel, borderColor: color.line }]}><Text style={{ color: color.text, fontSize: 17, fontWeight: "600" }} numberOfLines={2} maxFontSizeMultiplier={2}>{title}</Text><Text style={{ color: color.textMuted, marginTop: 6, fontSize: 14, lineHeight: 22 }} numberOfLines={2} maxFontSizeMultiplier={2}>{subtitle}</Text></Pressable>;
  const sessions = [...(state.snapshot?.sessions ?? []), ...older.sessions], jobs = [...(state.snapshot?.jobs ?? []), ...older.jobs], questions = [...(state.snapshot?.questions ?? []), ...older.questions];
  const loadMore = async (kind: "sessions" | "jobs" | "questions") => {
    const cursor = pages[kind]; if (!cursor || pageBusy) return; setPageBusy(true);
    try { const page = await client.page<Session | Job | Question>(`/${kind}?cursor=${encodeURIComponent(cursor)}`); setOlder(prior => ({ ...prior, [kind]: [...prior[kind], ...page.items].slice(-3000) })); setPages(prior => ({ ...prior, [kind]: page.next })); }
    finally { setPageBusy(false); }
  };
  const loadContent = async (kind: "chat" | "steps") => {
    if (!detail || detail.kind === "question" || contentBusy) return; setContentBusy(true);
    try {
      if (kind === "chat" && nextContent && detail.item.chatId) { const page = await client.page<ChatItem>(`/chats/${detail.item.chatId}?cursor=${encodeURIComponent(nextContent)}`); setContent(prior => [...new Map([...prior, ...page.items].map(i => [i.id, i])).values()].slice(-3000)); setNextContent(page.next); }
      if (kind === "steps" && nextSteps) { const page = await client.page<{ text: string }>(`/jobs/${detail.item.id}/steps?cursor=${encodeURIComponent(nextSteps)}`); setSteps(prior => [...prior, ...page.items.map(i => i.text)].slice(-100)); setNextSteps(page.next); }
    } finally { setContentBusy(false); }
  };
  const sendAnswer = async () => {
    if (detail?.kind !== "question") return; setConfirm(false);
    const result = await client.answer(detail.item, selected ? { option: selected } : { text: answerText });
    setDetail({ kind: "question", item: result }); AccessibilityInfo.announceForAccessibility(s.answerSaved);
  };
  const main = detail ? <ScrollView contentContainerStyle={styles.body}>
    {button("‹ Back", () => setDetail(null))}
    <Text accessibilityRole="header" style={[styles.title, { color: color.text }]}>{detail.kind === "session" ? detail.item.name : detail.item.title}</Text>
    {detail.kind === "question" ? <>
      {text(`${detail.item.urgency === "urgent" ? "Urgent · " : ""}${detail.item.status}`)}
      {text(detail.item.context)}
      {detail.item.blocking && card("blocking", "Blocking", detail.item.blocks)}
      {detail.item.destructive && card("destructive", "Destructive action", "Review the consequences before recording owner intent.")}
      {detail.item.authorization && card("auth", "Authorization question", "An answer records owner intent. Permission approvals remain separate.")}
      {card("meanwhile", "Meanwhile", detail.item.meanwhile)}
      {detail.item.declaredDefault && card("default", "Declared default", `${detail.item.declaredDefault.option} at ${new Date(detail.item.declaredDefault.deadline).toLocaleString()}`)}
      {detail.item.links.map((link, index) => card("link" + index, link.kind, link.display))}
      {detail.item.options.map(option => <Pressable key={option.id} accessibilityRole="radio" accessibilityState={{ checked: selected === option.id, disabled: !client.writesEnabled || detail.item.status !== "open" }} disabled={!client.writesEnabled || detail.item.status !== "open"} onPress={() => { setSelected(option.id); setAnswerText(""); }} style={[styles.card, { backgroundColor: selected === option.id ? color.accentSoft : color.panel, borderColor: selected === option.id ? color.accent : color.line }]}>
        {text(option.label + (option.recommended ? " · Recommended" : ""))}{text(option.consequence, true)}</Pressable>)}
      {detail.item.status === "open" && <><TextInput accessibilityLabel="Free text answer" multiline value={answerText} maxLength={8000} onChangeText={value => { setAnswerText(value); setSelected(null); }} placeholder="Or write an exact answer" placeholderTextColor={color.textMuted} editable={client.writesEnabled} style={[styles.input, { color: color.text, backgroundColor: color.panel, borderColor: color.line }]} />
        {button(s.confirm, () => setConfirm(true), !client.writesEnabled || (!selected && !answerText.trim()), true)}</>}
      {detail.item.answer && card("answer", "Recorded answer", detail.item.answer.text)}
      {detail.item.deliveries.map((delivery, index) => card("delivery" + index, delivery.recipientLabel, `${delivery.state}${delivery.consumedAt ? " · consumed" : " · consumption unknown"}`))}
      {detail.item.dismissal && card("dismissal", detail.item.status, detail.item.dismissal.reason)}
    </> : <>
      {detail.kind === "job" && <>{card("status", detail.item.status, detail.item.progress.note ?? "Progress unknown")}{detail.item.progress.percent !== null && <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: detail.item.progress.percent }} style={{ height: 6, backgroundColor: color.panel2 }}><View style={{ height: 6, width: `${detail.item.progress.percent}%`, backgroundColor: color.accentFill }} /></View>}{text(detail.item.progress.etaAt ? `Reported ETA ${new Date(detail.item.progress.etaAt).toLocaleTimeString()}` : "ETA unknown", true)}</>}
      {text("Chat", true)}
      {!content.length && text(detail.item.chatId ? "No chat items in this page. Source may be unavailable." : s.unsupported, true)}
      {content.map(item => <View key={item.id} style={[styles.card, { backgroundColor: item.kind === "user" ? color.accentSoft : color.panel2, borderColor: color.line }]}>{text(item.kind, true)}<Text selectable style={{ color: color.text, fontSize: 16, lineHeight: 24 }}>{item.text ?? item.summary ?? item.tool ?? ""}{item.truncated ? "\n[Truncated source preview]" : ""}</Text></View>)}
      {nextContent && button("Load next chat page", () => safe(() => loadContent("chat")), contentBusy || state.connection !== "ready")}
      {detail.kind === "job" && <>{text("Live steps", true)}{steps.map((step, index) => <View key={index} style={[styles.card, { backgroundColor: color.codeBg, borderColor: color.line }]}><Text selectable style={{ fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", color: color.text, fontSize: 13, lineHeight: 20 }}>{step}</Text></View>)}{nextSteps && button("Load next steps page", () => safe(() => loadContent("steps")), contentBusy || state.connection !== "ready")}</>}
      {text(s.sendUnsupported, true)}
    </>}
  </ScrollView> : tab === "phone" || state.connection === "unpaired" || state.connection === "revoked" ? <ScrollView contentContainerStyle={styles.body}>
    <Text accessibilityRole="header" style={[styles.title, { color: color.text }]}>{s.pair}</Text>{text(s.pairHelp, true)}
    {state.connection === "unpaired" || state.connection === "revoked" ? <>
      {!qr && button("Scan PC QR", () => { safe(async () => { const permission = camera?.granted ? camera : await requestCamera(); if (permission.granted) setScanning(true); else setNotice("Camera permission is needed to scan the PC QR."); }); }, pairBusy, true)}
      {qr && <>{card("origin", "Private PC addresses", qr.origins.join("\n"))}{text(`Expires ${new Date(qr.expiresAt).toLocaleTimeString()}`, true)}{!claim && button("Connect to these PC addresses", () => safe(async () => { setPairBusy(true); try { setClaim(await client.beginPairing(qr, Device.deviceName ?? "Phone", Platform.OS === "ios" ? "ios" : "android")); } finally { setPairBusy(false); } }), pairBusy, true)}</>}
      {claim && <>{card("code", "Compare this code on the PC", claim.comparisonCode)}{text("Waiting for the desktop owner to confirm the same code and exact grants.")}</>}
      {qr && button("Start a new pairing", () => { setQr(null); setClaim(null); setNotice("Cancel or revoke the prior pairing on the PC if needed."); })}
    </> : <>{card("addresses", "Approved private addresses", client.approvedOrigins.join("\n"))}{card("preferred", "Connected through", client.preferredOrigin ?? "Unknown")}
      {button("Reconnect and refresh", () => safe(() => client.reconnect()))}
      {button("Enable generic owner-question push", () => safe(() => enableNotifications(client, __DEV__ ? "development" : "production")), !client.writesEnabled || !Constants.easConfig?.projectId)}
      {text("Push needs an owner-provisioned project, signed build and actual device verification.", true)}
      {button("Forget credentials on this phone", () => safe(() => client.forget()))}{text("Revoke the phone from your desktop to invalidate server credentials.", true)}</>}
    {text("Appearance", true)}<View style={styles.actions}>{(["system", "light", "dark"] as const).map(value => <View key={value}>{button(value, () => setTheme(value), theme === value)}</View>)}</View>
    {text(s.localQuestions, true)}
  </ScrollView> : <FlatList data={tab === "overview" ? sessions : tab === "running" ? jobs : questions} keyExtractor={item => item.id} contentContainerStyle={styles.body}
    ListHeaderComponent={<><Text accessibilityRole="header" style={[styles.title, { color: color.text }]}>{s[tab]}</Text>{state.snapshot && text(`Sampled ${new Date(state.snapshot.sampledAt).toLocaleTimeString()}`, true)}{tab === "inbox" && text(s.localQuestions, true)}</>}
    ListEmptyComponent={text(tab === "overview" ? s.noSessions : tab === "running" ? s.noJobs : s.noQuestions, true)}
    renderItem={({ item }) => "kind" in item ? card(item.id, item.title, `${item.urgency} · ${item.status}${item.blocking ? " · blocking" : ""}`, () => setDetail({ kind: "question", item })) : "generation" in item ? card(item.id, item.name, `${item.agent} · ${item.activity} · ${item.connection}`, () => setDetail({ kind: "session", item })) : card(item.id, item.title, `${item.status} · ${item.progress.percent === null ? "Progress unknown" : item.progress.percent + "%"}${item.progress.note ? " · " + item.progress.note : ""}`, () => setDetail({ kind: "job", item }))}
    ListFooterComponent={pages[tab === "overview" ? "sessions" : tab === "running" ? "jobs" : "questions"] ? button("Load more", () => safe(() => loadMore(tab === "overview" ? "sessions" : tab === "running" ? "jobs" : "questions")), pageBusy || state.connection !== "ready") : null} />;
  return <SafeAreaView style={{ flex: 1, backgroundColor: color.bg }}>
    <StatusBar barStyle={color === tokens.color.dark ? "light-content" : "dark-content"} />
    <View style={[styles.header, { borderBottomColor: color.line, backgroundColor: color.panel }]}><Text accessibilityRole="header" style={{ color: color.accent, fontSize: 20, fontWeight: "700" }}>{s.app}</Text><Text style={{ color: state.connection === "ready" ? color.ok : color.warn, fontSize: 13 }}>{state.connection}</Text></View>
    {["offline", "stale", "reconnecting"].includes(state.connection) && <View style={[styles.banner, { backgroundColor: color.warnSoft }]}>{text(state.connection === "offline" ? s.offline : state.connection === "stale" ? s.stale : s.reconnecting)}{button(s.refresh, () => safe(() => client.reconnect()))}</View>}
    {(notice || state.notice) && <Pressable accessibilityRole="button" accessibilityLabel="Dismiss status message" onPress={() => setNotice(null)} style={[styles.banner, { backgroundColor: color.accentSoft }]}>{text(notice ?? state.notice ?? "")}</Pressable>}
    {main}
    <View style={[styles.tabs, { backgroundColor: color.panel, borderTopColor: color.line }]}>{(["overview", "running", "inbox", "phone"] as const).map(value => <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: tab === value && !detail }} onPress={() => { setTab(value); setDetail(null); }} style={styles.tab}><Text maxFontSizeMultiplier={1.4} style={{ color: tab === value ? color.accent : color.textMuted, fontSize: 13, fontWeight: "600" }}>{s[value]}{value === "inbox" ? ` (${questions.filter(q => q.status === "open").length})` : ""}</Text></Pressable>)}</View>
    <Modal visible={scanning} onRequestClose={() => setScanning(false)}><SafeAreaView style={{ flex: 1, backgroundColor: tokens.color.dark.bg }}><CameraView style={{ flex: 1 }} barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={({ data }) => { if (!scanning) return; setScanning(false); try { setQr(parseQr(data)); } catch { setNotice("QR is invalid, expired or does not specify trusted HTTPS addresses."); } }} />{button(s.cancel, () => setScanning(false))}</SafeAreaView></Modal>
    <Modal visible={confirm} transparent onRequestClose={() => setConfirm(false)}><View style={[styles.scrim, { backgroundColor: color.scrim }]}><View style={[styles.dialog, { backgroundColor: color.panel }]}>{text(s.confirm)}{text(detail?.kind === "question" ? detail.item.options.find(o => o.id === selected)?.label ?? answerText : "")}{text("Record this exact owner intent? Delivery and task acceptance are separate.", true)}{button("Record answer", () => safe(sendAnswer), !client.writesEnabled, true)}{button(s.cancel, () => setConfirm(false))}</View></View></Modal>
  </SafeAreaView>;
}
const styles = StyleSheet.create({
  header: { paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  body: { padding: 20, gap: 12, paddingBottom: 32 }, title: { fontSize: 28, fontWeight: "700", marginBottom: 8 },
  card: { padding: 16, borderRadius: 14, borderWidth: 1, minHeight: 64, marginVertical: 4 }, button: { paddingHorizontal: 16, paddingVertical: 14, minHeight: 48, borderRadius: 10, borderWidth: 1, alignItems: "center", justifyContent: "center", marginVertical: 4 },
  input: { padding: 16, borderRadius: 12, borderWidth: 1, minHeight: 110, textAlignVertical: "top", fontSize: 16 }, actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  banner: { paddingHorizontal: 20, paddingVertical: 10 }, tabs: { flexDirection: "row", borderTopWidth: 1 }, tab: { flex: 1, minHeight: 56, justifyContent: "center", alignItems: "center", padding: 6 },
  scrim: { flex: 1, padding: 24, alignItems: "center", justifyContent: "center" }, dialog: { width: "100%", maxWidth: 480, padding: 24, borderRadius: 18, gap: 12 },
});
