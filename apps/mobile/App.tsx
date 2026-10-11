import React, { useState } from "react";
import { View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { ThemeProvider, useTheme, type Preference } from "./src/theme";
import { useDashboard } from "./src/useDashboard";
import { Banner, Tabs, Toast } from "./src/components/layout";
import { OverviewScreen } from "./src/screens/OverviewScreen";
import { RunningScreen } from "./src/screens/RunningScreen";
import { QuestionsScreen } from "./src/screens/QuestionsScreen";
import { ConversationScreen } from "./src/screens/ConversationScreen";
import { PairingScreen } from "./src/screens/PairingScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
export default function App() { const [preference, setPreference] = useState<Preference>("system"); return <SafeAreaProvider><ThemeProvider preference={preference}><Dashboard preference={preference} setPreference={setPreference}/></ThemeProvider></SafeAreaProvider>; }
function Dashboard({ preference, setPreference }: {
    preference: Preference;
    setPreference: (value: Preference) => void;
}) {
    const d = useDashboard(), { colors } = useTheme(), paired = d.state.connection !== "unpaired" && d.state.connection !== "revoked", route = d.nav.route;
    const banner = d.state.connection === "reconnecting" ? "Reconnecting… Answers unlock only after a fresh authoritative fetch." : d.state.connection === "offline" ? "Can't reach the PC. Showing only the last in-memory view; answers disabled." : d.state.connection === "stale" || (d.state.snapshot && !d.client.writesEnabled && !d.state.writePending && d.state.connection === "ready") ? "The authoritative view is stale. Refresh before answering." : d.state.connection === "background" ? "App suspended. A fresh fetch is required on resume." : d.state.snapshot?.sourceState !== "ready" && d.state.snapshot ? "PC source unavailable or slow. Answers disabled." : null;
    return <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
    {banner && <Banner message={banner} action={() => d.safe(() => d.client.reconnect())}/>}
    {(d.notice || d.state.notice) && <Toast message={d.notice ?? d.state.notice ?? ""}/>}
    {!paired || d.primer ? <PairingScreen d={d}/> : <View style={{ flex: 1 }}>
      <OverviewScreen d={d} visible={!route && d.nav.tab === "overview"}/>
      <RunningScreen d={d} visible={!route && d.nav.tab === "running"}/>
      <QuestionsScreen d={d} visible={!route && d.nav.tab === "questions"}/>
      <SettingsScreen d={d} preference={preference} setPreference={setPreference} visible={route ? !["session", "job", "question"].includes(route.kind) : d.nav.tab === "settings"}/>
      {(route?.kind === "session" || route?.kind === "job") && <ConversationScreen key={`${route.kind}:${route.id}`} d={d}/>}
      {route?.kind === "question" && <QuestionsScreen d={d} visible detail/>}
    {!route && <Tabs tab={d.nav.tab} count={d.questions.filter(q => q.status === "open").length} bounded={!!d.pages.questions} onChange={d.tab}/>}</View>}
  </SafeAreaView>;
}
