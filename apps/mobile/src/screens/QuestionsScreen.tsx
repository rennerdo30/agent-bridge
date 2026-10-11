import React from "react";
import { KeyboardAvoidingView, Platform, RefreshControl, View } from "react-native";
import type { Dashboard } from "../useDashboard";
import { choice, questionList } from "../view-model";
import { useTheme } from "../theme";
import { AppText, Button, Empty, Panel, Skeleton } from "../components/primitives";
import { Banner, Header, Page, Section, Segments, Sheet } from "../components/layout";
import { QuestionRow } from "../components/rows";
import { AnsweredBlock, AnswerTextArea, OptionCard } from "../components/questions";
import { Chip } from "../components/status";
import { strings as copyStrings } from "../strings";
export function QuestionsScreen({ d, visible, detail = false }: { d: Dashboard; visible: boolean; detail?: boolean }) {
  const { colors, scheme } = useTheme(),
    q = d.question,
    allowed = !!q && d.client.canAnswer(q) && !d.answerBusy,
    uncertain = !!q && d.unconfirmed.includes(q.id);
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1, display: visible ? "flex" : "none" }}
    >
      <Page
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={() => d.safe(() => d.client.sync())}
            tintColor={colors.accent}
          />
        }
      >
        {!detail ? (
          <>
            <Header title={copyStrings.copy.questions} />
            <Segments
              value={d.history ? "history" : "open"}
              onChange={(v) => d.setHistory(v === "history")}
              options={[
                {
                  key: "open",
                  label: `Open ${d.questions.filter((q) => q.status === "open").length}${d.pages.questions ? "+" : ""}`,
                },
                { key: "history", label: "History" },
              ]}
            />
            {!d.state.snapshot ? (
              <Skeleton rows={3} />
            ) : (
              <>
                {questionList(d.questions, d.history).map((item) => (
                  <Panel key={item.id}>
                    <QuestionRow
                      item={item}
                      isNew={!d.seen.includes(item.id) && item.status === "open"}
                      onPress={() => d.open({ kind: "question", id: item.id })}
                    />
                  </Panel>
                ))}
                {!questionList(d.questions, d.history).length && (
                  <Empty
                    title={d.history ? "No closed questions in this page" : "Nothing is waiting in this page"}
                    body={copyStrings.copy.localOwnerQuestionsOnlyLoadMoreIfFurtherPagesAreAvailable}
                  />
                )}
                {d.pages.questions && (
                  <Button
                    label={copyStrings.copy.loadMoreQuestions}
                    busy={d.pageBusy}
                    disabled={d.state.connection !== "ready"}
                    onPress={() => d.safe(() => d.loadMore("questions"))}
                  />
                )}
              </>
            )}
            <AppText variant="caption" tone="textFaint">
              {copyStrings.copy.otherPcsQuestionsRemainOnThosePcsPermissionsDecisionsAndAgentTo}
            </AppText>
          </>
        ) : !q ? (
          <>
            <Header title={copyStrings.copy.questionUnavailable} back={d.goBack} />
            <Empty
              title={copyStrings.copy.thisQuestionIsOutsideTheAuthoritativeView}
              body={copyStrings.copy.returnToQuestionsAndRefreshNoAnswerWillBeSentFromOld}
            />
          </>
        ) : (
          <>
            <Header title={q.title} back={d.goBack} />
            <AppText variant="overline" tone={q.status === "answered" ? "ok" : "accent"}>
              {copyStrings.copy.ownerQuestion}
              {q.status.toUpperCase()}
            </AppText>
            <AppText variant="caption" tone="textFaint">
              {copyStrings.copy.asked}
              {new Date(q.askedAt).toLocaleString()}
            </AppText>
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
              {q.urgency === "urgent" && <Chip label={copyStrings.copy.urgent} tone="warn" />}
              {q.blocking && <Chip label={copyStrings.copy.blocking} tone="warn" />}
            </View>
            <Panel style={{ backgroundColor: colors.panel2 }}>
              <AppText variant="callout" selectable>
                {q.context}
              </AppText>
            </Panel>
            <Panel attention={q.blocking}>
              <AppText variant="bodyStrong">{q.blocking ? `Blocking: ${q.blocks}` : "Non-blocking"}</AppText>
              <AppText variant="callout">
                {copyStrings.copy.meanwhile}
                {q.meanwhile}
              </AppText>
            </Panel>
            {q.destructive && (
              <Banner message={copyStrings.copy.thisQuestionConcernsADestructiveChangeReviewItsConsequences} />
            )}
            {q.authorization && (
              <Banner message={copyStrings.copy.anAnswerRecordsOwnerIntentItGrantsNoToolPermission} />
            )}
            {q.links.map((l, i) => (
              <Panel key={i}>
                <AppText variant="monoSmall" selectable>
                  {l.kind}
                  {copyStrings.copy.message3}
                  {l.display}
                </AppText>
              </Panel>
            ))}
            {q.status === "open" ? (
              <>
                <Section title={copyStrings.copy.chooseOne} />
                {[...q.options]
                  .sort((a, b) => Number(b.recommended) - Number(a.recommended))
                  .map((o) => (
                    <OptionCard
                      key={o.id}
                      option={o}
                      selected={d.draft.option === o.id}
                      disabled={!allowed || uncertain}
                      onSelect={() => d.updateDraft({ option: o.id })}
                    />
                  ))}
                <AppText variant="caption" tone="textFaint">
                  {copyStrings.copy.orWriteAnAnswer}
                </AppText>
                <AnswerTextArea
                  value={d.draft.text}
                  disabled={!allowed || uncertain}
                  onChange={(text) => d.updateDraft({ text })}
                />
                <AppText variant="caption" tone="textFaint">
                  {d.draft.text.length.toLocaleString()}
                  {copyStrings.copy.text8000}
                </AppText>
                <AppText variant="caption" tone="textMuted">
                  {q.declaredDefault
                    ? `Declared default “${q.options.find((o) => o.id === q.declaredDefault?.option)?.label ?? q.declaredDefault.option}” after ${new Date(q.declaredDefault.deadline).toLocaleTimeString()}.`
                    : "No answer means no decision."}
                  {copyStrings.copy.thisGrantsNoToolPermission}
                </AppText>
              </>
            ) : (
              <AnsweredBlock q={q} />
            )}
          </>
        )}
      </Page>
      {detail && q?.status === "open" && (
        <View
          style={{
            backgroundColor: scheme === "dark" ? colors.sunk : colors.panel,
            padding: 16,
            borderTopWidth: 1,
            borderTopColor: colors.line,
            gap: 8,
          }}
        >
          {uncertain ? (
            <>
              <Banner message={copyStrings.copy.noConfirmationYetReadThePcStateBeforeReviewingANewAnswer} />
              <Button
                label={copyStrings.copy.checkAgain}
                onPress={() => d.safe(d.checkAnswer)}
                disabled={d.state.connection !== "ready"}
              />
            </>
          ) : (
            <Button
              label={d.answerBusy ? "Sending…" : "Review answer"}
              busy={d.answerBusy}
              primary
              disabled={!allowed || !choice(d.draft)}
              onPress={d.review}
            />
          )}
          <AppText variant="caption" tone="textFaint">
            {!allowed ? "A fresh authoritative connection is required. " : ""}
            {copyStrings.copy.anAnswerIsNotToolPermissionOrImplementationAcceptance}
          </AppText>
        </View>
      )}
      <Sheet
        visible={visible && !!d.confirmation}
        title={copyStrings.copy.sendThisExactAnswer}
        onClose={() => d.setConfirmation(null)}
        busy={d.answerBusy}
      >
        {d.confirmation && (
          <>
            <AppText variant="bodyStrong">
              {d.confirmation.question.options.find((o) => o.id === d.confirmation?.draft.option)?.label ??
                d.confirmation.draft.text}
            </AppText>
            {d.confirmation.draft.option && (
              <AppText tone="textMuted">
                {d.confirmation.question.options.find((o) => o.id === d.confirmation?.draft.option)?.consequence}
              </AppText>
            )}
            {d.confirmation.question.destructive && <Banner message={copyStrings.copy.thisIsADestructiveChange} />}
            {d.confirmation.question.authorization && (
              <Banner message={copyStrings.copy.thisQuestionAsksForOwnerAuthorizationNotToolPermission} />
            )}
            {d.confirmation.draft.option &&
              !d.confirmation.question.options.find((o) => o.id === d.confirmation?.draft.option)?.recommended && (
                <Banner message={copyStrings.copy.thisIsNotTheRecommendedOption} />
              )}
            <AppText variant="caption" tone="textFaint">
              {copyStrings.copy.deliveryAndTaskAcceptanceRemainSeparate}
            </AppText>
            <Button
              label={copyStrings.copy.recordAnswer}
              primary
              disabled={!q || !d.client.canAnswer(q)}
              onPress={() => d.safe(d.sendAnswer)}
            />
          </>
        )}
      </Sheet>
    </KeyboardAvoidingView>
  );
}
