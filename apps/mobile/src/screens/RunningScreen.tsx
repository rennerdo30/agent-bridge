import { strings as copyStrings } from "../strings";
import React from "react";
import { RefreshControl, View } from "react-native";
import type { Dashboard } from "../useDashboard";
import { filterJobs, type JobFilter } from "../view-model";
import { useTheme } from "../theme";
import { AppText, Button, Empty, Panel, Skeleton } from "../components/primitives";
import { Header, Page, Section, Segments } from "../components/layout";
import { JobRow } from "../components/rows";
export function RunningScreen({ d, visible }: {
    d: Dashboard;
    visible: boolean;
}) { const { colors } = useTheme(), items = filterJobs(d.jobs, d.filter); return <View style={{ flex: 1, display: visible ? "flex" : "none" }}><Page refreshControl={<RefreshControl refreshing={false} onRefresh={() => d.safe(() => d.client.sync())} tintColor={colors.accent}/>}><Header title={copyStrings.copy.running}/><Segments value={d.filter} onChange={v => d.setFilter(v as JobFilter)} options={(["all", "working", "failed", "done"] as const).map(key => ({ key, label: `${key.charAt(0).toUpperCase() + key.slice(1)} ${filterJobs(d.jobs, key).length}` }))}/>{!d.state.snapshot ? <Skeleton rows={5}/> : <>{[true, false].map(running => { const section = items.filter(j => (j.status === "running") === running); return section.length ? <View key={String(running)} style={{ gap: 10 }}><Section title={running ? "Working now" : "Finished / other"}/><Panel>{section.map(item => <JobRow key={item.id} item={item} onPress={() => d.open({ kind: "job", id: item.id })}/>)}</Panel></View> : null; })}{!items.length && <Empty title={d.filter === "all" ? "No granted subagents yet" : `No ${d.filter} subagents in loaded pages`} body={copyStrings.copy.delegatedJobsAppearHereWhenGrantedOnThePc}/>}{d.pages.jobs && <Button label={copyStrings.copy.loadMoreJobs} busy={d.pageBusy} disabled={d.state.connection !== "ready"} onPress={() => d.safe(() => d.loadMore("jobs"))}/>}<AppText variant="caption" tone="textFaint">{copyStrings.copy.countsCoverLoadedGrantsAgentModelOwnerMetadataAndNativeChildLinks}</AppText></>}</Page></View>; }
