import React, { useState } from "react";
import { View } from "react-native";
import type { Dashboard } from "../useDashboard";
import { eta } from "../view-model";
import { AppText, Button, Empty, Panel } from "../components/primitives";
import { Header, Page, Segments, Sheet } from "../components/layout";
import { Avatar, Pill, Progress } from "../components/status";
import { ChatList } from "../components/chat";
import { strings as copyStrings } from "../strings";
export function ConversationScreen({ d }: { d: Dashboard }) {
  const [segment, setSegment] = useState("chat"),
    [info, setInfo] = useState(false),
    item = d.session ?? d.job;
  if (!item)
    return (
      <Page>
        <Header title={copyStrings.copy.conversationUnavailable} back={d.goBack} />
        <Empty
          title={copyStrings.copy.outsideTheAuthoritativeView}
          body={copyStrings.copy.returnAndRefreshNoStaleEntityLinkIsFollowed}
        />
      </Page>
    );
  return (
    <View style={{ flex: 1 }}>
      <View style={{ padding: 16, gap: 12 }}>
        <Header title={d.session?.name ?? d.job?.title ?? "Conversation"} back={d.goBack} />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          {d.session && (
            <>
              <Avatar agent={d.session.agent} />
              <AppText variant="subhead" tone="textMuted">
                {d.session.agent}
                {copyStrings.copy.thisPc}
              </AppText>
              <Pill status={d.session.connection === "connected" ? d.session.activity : d.session.connection} />
            </>
          )}
          {d.job && (
            <Pill status={d.job.status} percent={d.job.status === "running" ? d.job.progress.percent : undefined} />
          )}
        </View>
        {d.job?.status === "running" && (
          <>
            {d.job.progress.percent != null && <Progress percent={d.job.progress.percent} />}
            <AppText variant="caption" tone="textMuted">
              {d.job.progress.note ?? "Progress not reported"}
              {copyStrings.copy.message}
              {eta(d.job.progress.etaAt)}
            </AppText>
          </>
        )}
        <Button label={copyStrings.copy.sessionHostFacts} onPress={() => setInfo(true)} />
        <Segments
          value={segment}
          onChange={setSegment}
          options={[
            { key: "chat", label: "Chat" },
            { key: "steps", label: d.job ? "Steps" : "Subagents" },
          ]}
        />
      </View>
      {segment === "chat" ? (
        item.chatId ? (
          <ChatList
            items={d.content}
            loading={d.contentBusy}
            next={!!d.nextContent}
            onNext={() => d.safe(() => d.loadContent("chat"))}
            disabled={d.state.connection !== "ready"}
          />
        ) : (
          <Page>
            <Empty
              title={copyStrings.copy.conversationUnsupported}
              body={copyStrings.copy.thisEntityHasNoReadableChatSource}
            />
          </Page>
        )
      ) : (
        <Page>
          {d.job?.hasSteps ? (
            <>
              {d.steps.map((text, i) => (
                <Panel key={i}>
                  <AppText variant="mono" selectable>
                    {text}
                  </AppText>
                </Panel>
              ))}
              {!d.steps.length && <Empty title={copyStrings.copy.waitingForSourceSteps} />}
              {d.nextSteps && (
                <Button
                  label={copyStrings.copy.loadNextStepsPage}
                  busy={d.contentBusy}
                  disabled={d.state.connection !== "ready"}
                  onPress={() => d.safe(() => d.loadContent("steps"))}
                />
              )}
            </>
          ) : (
            <Empty
              title={copyStrings.copy.unsupportedInV1}
              body={copyStrings.copy.nativeSubagentLinksAndSessionOwnedJobRelationshipsAreUnavailableInThis}
            />
          )}
        </Page>
      )}
      <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
        <AppText variant="caption" tone="textFaint">
          {copyStrings.copy.sessionAndSubagentSendingIsUnsupported}
        </AppText>
      </View>
      <Sheet visible={info} title={copyStrings.copy.readOnlyFacts} onClose={() => setInfo(false)}>
        <AppText variant="monoSmall" selectable>
          {copyStrings.copy.pc}
          {item.pcId}
        </AppText>
        <AppText variant="caption" tone="textFaint">
          {copyStrings.copy.thisPcSnapshot}
          {new Date(item.sampledAt).toLocaleString()}
        </AppText>
        {d.session && (
          <AppText selectable>
            {copyStrings.copy.name}
            {d.session.name}
            {copyStrings.copy.agent}
            {d.session.agent}
          </AppText>
        )}
        <AppText variant="callout" tone="textMuted">
          {copyStrings.copy.projectNamesRolesNativeChildrenPcVersionAndHostLatencyAreUnavailable}
        </AppText>
      </Sheet>
    </View>
  );
}
