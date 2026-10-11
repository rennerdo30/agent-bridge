import React, { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, View, type ScrollViewProps } from "react-native";
import { useTheme } from "../theme";
import { AppText, Button, Icon } from "./primitives";
import type { Tab } from "../navigation";
import { strings as copyStrings } from "../strings";
export function Toast({ message }: { message: string }) {
  const { colors, tokens } = useTheme(),
    [shown, setShown] = useState(true);
  useEffect(() => {
    setShown(true);
    const timer = setTimeout(() => setShown(false), tokens.motion.toastVisibleMs);
    return () => clearTimeout(timer);
  }, [message]);
  return shown ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Dismiss status message"
      onPress={() => setShown(false)}
      style={{
        backgroundColor: colors.panel,
        borderLeftColor: colors.accent,
        borderLeftWidth: 3,
        borderRadius: tokens.radius.card,
        margin: 8,
        padding: 12,
      }}
    >
      <AppText variant="subhead">{message}</AppText>
    </Pressable>
  ) : null;
}
export function Page({ children, ...props }: ScrollViewProps) {
  const { tokens } = useTheme();
  return (
    <ScrollView
      {...props}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[
        { padding: tokens.spacing.alias.screenGutter, paddingBottom: 32, gap: 16 },
        props.contentContainerStyle,
      ]}
    >
      {children}
    </ScrollView>
  );
}
export function Header({ title, back, subtitle }: { title: string; back?: () => void; subtitle?: string }) {
  return (
    <View style={{ gap: 6 }}>
      {back && <Button label={copyStrings.copy.back} onPress={back} />}
      <AppText variant={back ? "title" : "largeTitle"} accessibilityRole="header">
        {title}
      </AppText>
      {subtitle && (
        <AppText variant="caption" tone="textFaint">
          {subtitle}
        </AppText>
      )}
    </View>
  );
}
export function Section({ title }: { title: string }) {
  return (
    <AppText accessibilityRole="header" variant="subheadStrong" tone="textMuted" style={{ marginTop: 8 }}>
      {title}
    </AppText>
  );
}
export function Segments({
  options,
  value,
  onChange,
}: {
  options: {
    key: string;
    label: string;
  }[];
  value: string;
  onChange: (key: string) => void;
}) {
  const { colors, touch } = useTheme();
  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        backgroundColor: colors.panel2,
        padding: 4,
        borderRadius: 8,
        gap: 4,
      }}
    >
      {options.map((o) => (
        <Pressable
          key={o.key}
          accessibilityRole="tab"
          accessibilityState={{ selected: value === o.key }}
          onPress={() => onChange(o.key)}
          style={({ pressed }) => ({
            flexGrow: 1,
            minHeight: touch,
            padding: 8,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 6,
            opacity: pressed ? 0.7 : 1,
            backgroundColor: value === o.key ? colors.accentSoft : colors.panel2,
          })}
        >
          <AppText variant="subheadStrong" tone={value === o.key ? "accent" : "textMuted"}>
            {o.label}
          </AppText>
        </Pressable>
      ))}
    </View>
  );
}
export function Tabs({
  tab,
  count,
  bounded,
  onChange,
}: {
  tab: Tab;
  count: number;
  bounded: boolean;
  onChange: (tab: Tab) => void;
}) {
  const { colors, scheme } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        backgroundColor: scheme === "dark" ? colors.sunk : colors.panel,
        borderTopWidth: 1,
        borderTopColor: colors.line,
      }}
    >
      {(["overview", "running", "questions", "settings"] as const).map((t) => (
        <Pressable
          key={t}
          accessibilityRole="tab"
          accessibilityLabel={`${t}${t === "questions" ? `, ${count}${bounded ? " loaded" : ""} questions waiting` : ""}`}
          accessibilityState={{ selected: tab === t }}
          onPress={() => onChange(t)}
          style={{ flex: 1, minHeight: 64, paddingVertical: 8, gap: 4, alignItems: "center", justifyContent: "center" }}
        >
          <View style={{ flexDirection: "row", gap: 2 }}>
            <Icon name={t} size={24} tone={tab === t ? "accent" : "textMuted"} />
            {t === "questions" && count > 0 && (
              <View style={{ borderRadius: 9, paddingHorizontal: 4, minWidth: 18, backgroundColor: colors.warn }}>
                <AppText variant="micro" style={{ color: colors.onStatusFill }}>
                  {count > 99 ? "99+" : count}
                  {bounded ? "+" : ""}
                </AppText>
              </View>
            )}
          </View>
          <AppText variant="micro" tone={tab === t ? "accent" : "textMuted"}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </AppText>
        </Pressable>
      ))}
    </View>
  );
}
export function Sheet({
  visible,
  title,
  children,
  onClose,
  busy = false,
}: {
  visible: boolean;
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const { colors, tokens, reduced } = useTheme();
  return (
    <Modal
      visible={visible}
      transparent
      animationType={reduced ? "fade" : "slide"}
      onRequestClose={() => {
        if (!busy) onClose();
      }}
    >
      <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: colors.scrim }}>
        <View
          style={{
            maxHeight: "90%",
            backgroundColor: colors.panel,
            borderTopLeftRadius: tokens.radius.sheet,
            borderTopRightRadius: tokens.radius.sheet,
          }}
        >
          <Page>
            <View
              accessible={false}
              style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: colors.line, alignSelf: "center" }}
            />
            <AppText variant="headline" accessibilityRole="header">
              {title}
            </AppText>
            {children}
            <Button label={copyStrings.copy.cancel} onPress={onClose} disabled={busy} />
          </Page>
        </View>
      </View>
    </Modal>
  );
}
export function Banner({
  message,
  action,
  label = "Refresh",
}: {
  message: string;
  action?: () => void;
  label?: string;
}) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        backgroundColor: colors.warnSoft,
        padding: 12,
        borderLeftWidth: 3,
        borderLeftColor: colors.warn,
        gap: 8,
      }}
    >
      <AppText variant="subhead">{message}</AppText>
      {action && <Button label={label} onPress={action} />}
    </View>
  );
}
