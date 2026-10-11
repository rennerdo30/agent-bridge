import React, { useRef } from "react";
import { RefreshControl, TextInput, View } from "react-native";
import type { Dashboard } from "../useDashboard";
import { groups, stats } from "../view-model";
import { useTheme } from "../theme";
import { AppText, Button, Empty, Panel, Row, Skeleton } from "../components/primitives";
import { Header, Page, Section } from "../components/layout";
import { SessionRow } from "../components/rows";
import { strings as copyStrings } from "../strings";
export function OverviewScreen({ d, visible }: { d: Dashboard; visible: boolean }) {
  const { colors, large } = useTheme(),
    scroll = useRef(0),
    waiting = d.questions.filter((q) => q.status === "open").length;
  return (
    <View style={{ flex: 1, display: visible ? "flex" : "none" }}>
      <Page
        onScroll={(e) => {
          scroll.current = e.nativeEvent.contentOffset.y;
        }}
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={() => d.safe(() => d.client.sync())}
            tintColor={colors.accent}
          />
        }
      >
        <Header
          title={copyStrings.copy.overview}
          subtitle={
            d.state.snapshot
              ? `Authoritative view · ${new Date(d.state.snapshot.sampledAt).toLocaleTimeString()}`
              : undefined
          }
        />
        <TextInput
          accessibilityLabel={copyStrings.copy.searchLoadedSessions}
          value={d.search}
          onChangeText={d.setSearch}
          placeholder={copyStrings.copy.searchSessions}
          placeholderTextColor={colors.textMuted}
          style={{
            minHeight: 48,
            padding: 12,
            backgroundColor: colors.panel,
            borderRadius: 8,
            color: colors.text,
            borderWidth: 1,
            borderColor: colors.line,
          }}
        />
        {waiting > 0 && (
          <Panel attention>
            <Row
              onPress={() => d.tab("questions")}
              label={`${waiting} loaded owner questions waiting. Opens questions.`}
            >
              <AppText variant="bodyStrong">
                {waiting} {d.pages.questions ? "loaded " : ""}
                {waiting === 1 ? "question is" : "questions are"}
                {copyStrings.copy.waitingForYou}
              </AppText>
            </Row>
          </Panel>
        )}
        {!d.state.snapshot ? (
          <Skeleton />
        ) : (
          <>
            <Panel>
              <View style={{ flexDirection: large ? "column" : "row", gap: 16 }}>
                {stats(d.sessions, d.jobs, !!(d.pages.sessions || d.pages.jobs)).map((stat, i) => (
                  <View key={stat.label} style={{ flex: 1 }}>
                    <Row
                      onPress={
                        i === 1
                          ? undefined
                          : () => {
                              d.setFilter(i === 0 ? "working" : "failed");
                              d.tab("running");
                            }
                      }
                    >
                      <View>
                        <AppText variant="stat" tone={stat.tone}>
                          {stat.value}
                        </AppText>
                        <AppText variant="subhead" tone="textMuted">
                          {stat.label}
                        </AppText>
                      </View>
                    </Row>
                  </View>
                ))}
              </View>
            </Panel>
            <Section title={copyStrings.copy.thisPcGrantedSessions} />
            {groups(d.sessions, d.search).map((group) => (
              <Panel key={group.title}>
                <Row
                  onPress={() =>
                    d.setCollapsed((p) =>
                      p.includes(group.title) ? p.filter((i) => i !== group.title) : [...p, group.title]
                    )
                  }
                  expanded={!d.collapsed.includes(group.title)}
                >
                  <AppText variant="bodyStrong">
                    {d.collapsed.includes(group.title) ? "▸" : "▾"} {group.title}
                    {copyStrings.copy.message}
                    {group.sessions.length}
                  </AppText>
                </Row>
                {!d.collapsed.includes(group.title) &&
                  group.sessions.map((item) => (
                    <SessionRow key={item.id} item={item} onPress={() => d.open({ kind: "session", id: item.id })} />
                  ))}
              </Panel>
            ))}
            {!d.sessions.length && (
              <Empty
                title={copyStrings.copy.noGrantedSessions}
                body={copyStrings.copy.chooseExactSessionGrantsOnYourPcSPhonesPage}
              />
            )}
            {d.sessions.length > 0 && !groups(d.sessions, d.search).length && (
              <Empty title={copyStrings.copy.nothingMatches} />
            )}
            {d.pages.sessions && (
              <Button
                label={copyStrings.copy.loadMoreSessions}
                busy={d.pageBusy}
                disabled={d.state.connection !== "ready"}
                onPress={() => d.safe(() => d.loadMore("sessions"))}
              />
            )}
            <AppText variant="caption" tone="textFaint">
              {copyStrings.copy.projectNamesAndSessionRolesAreUnavailableInThisContractPairedPc}
            </AppText>
          </>
        )}
      </Page>
    </View>
  );
}
