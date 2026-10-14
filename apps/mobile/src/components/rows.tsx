import React from "react";
import { View } from "react-native";
import type { Job, Question, Session } from "../client";
import { age, eta } from "../view-model";
import { useTheme } from "../theme";
import { AppText, Icon, Row } from "./primitives";
import { Avatar, Chip, Pill, Progress } from "./status";
import { strings as copyStrings } from "../strings";
export function SessionRow({ item, onPress }: { item: Session; onPress: () => void }) {
  return (
    <Row onPress={onPress} label={`${item.name}, ${item.agent}, ${item.activity}, ${item.connection}. Opens session.`}>
      <Avatar agent={item.agent} />
      <View style={{ flex: 1, gap: 5 }}>
        <AppText variant="bodyStrong" numberOfLines={2}>
          {item.name}
        </AppText>
        <AppText variant="subhead" tone="textMuted" numberOfLines={2}>
          {item.agent}
        </AppText>
        <Pill
          status={
            item.connection === "connected"
              ? item.activity === "unknown"
                ? "connected"
                : item.activity
              : item.connection
          }
        />
      </View>
      <Icon name="next" />
    </Row>
  );
}
export function JobRow({ item, onPress }: { item: Job; onPress: () => void }) {
  const { large, colors } = useTheme();
  return (
    <Row
      onPress={onPress}
      label={`${item.title}, ${item.status}, ${item.progress.percent ?? "unknown"} percent, ${eta(item.progress.etaAt)}. Opens job.`}
    >
      <View
        style={{
          width: 3,
          alignSelf: "stretch",
          backgroundColor: item.status === "running" ? colors.accent : colors.line,
        }}
      />
      <View style={{ flex: 1, gap: 8 }}>
        <View style={{ flexDirection: large ? "column" : "row", gap: 6, alignItems: large ? "flex-start" : "center" }}>
          <AppText variant="bodyStrong" numberOfLines={2} style={{ flexShrink: 1 }}>
            {item.title}
          </AppText>
          <Pill status={item.status} percent={item.status === "running" ? item.progress.percent : undefined} />
        </View>
        {item.progress.note && (
          <AppText variant="subhead" tone="textMuted" numberOfLines={2}>
            {item.progress.note}
          </AppText>
        )}
        {item.status === "running" && (
          <>
            <AppText variant="caption" tone="textFaint">
              {eta(item.progress.etaAt)}
            </AppText>
            {item.progress.percent != null && <Progress percent={item.progress.percent} />}
          </>
        )}
        {item.recovered && <Chip label={copyStrings.copy.recovered} />}
      </View>
      <Icon name="next" />
    </Row>
  );
}
export function QuestionRow({ item, onPress, isNew }: { item: Question; onPress: () => void; isNew: boolean }) {
  return (
    <Row
      onPress={onPress}
      label={`${item.urgency}, ${item.blocking ? "blocking" : "non-blocking"} owner question, ${item.title}, ${age(item.askedAt)}. Opens question.`}
    >
      <View style={{ flex: 1, gap: 8 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {item.urgency === "urgent" && <Chip label={copyStrings.copy.urgent} tone="warn" />}
          {item.blocking && <Chip label={copyStrings.copy.blocking} tone="warn" />}
          <AppText variant="caption" tone="textFaint">
            {age(item.askedAt)}
          </AppText>
          {item.status !== "open" && <Pill status={item.status} />}
        </View>
        <AppText variant="headline" numberOfLines={2}>
          {isNew ? "• " : ""}
          {item.title}
        </AppText>
        {item.blocking && (
          <AppText variant="caption" tone="textMuted">
            {copyStrings.copy.blocks}
            {item.blocks}
          </AppText>
        )}
        {item.declaredDefault && (
          <AppText variant="caption" tone="warn">
            {copyStrings.copy.default}
            {item.options.find((o) => o.id === item.declaredDefault?.option)?.label ?? item.declaredDefault.option}
            {copyStrings.copy.at}
            {new Date(item.declaredDefault.deadline).toLocaleTimeString()}
          </AppText>
        )}
        {item.answer && (
          <AppText variant="subhead" tone="textMuted" numberOfLines={2}>
            {copyStrings.copy.answer2}
            {item.answer.text}
          </AppText>
        )}
      </View>
    </Row>
  );
}
