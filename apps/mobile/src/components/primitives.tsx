import React from "react";
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  Text,
  View,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { useTheme } from "../theme";
import { strings as copyStrings } from "../strings";
export type Tone = "text" | "textMuted" | "textFaint" | "accent" | "ok" | "warn" | "bad" | "onAccent";
export function AppText({
  variant = "body",
  tone = "text",
  style,
  ...props
}: TextProps & {
  variant?: keyof ReturnType<typeof useTheme>["tokens"]["typography"]["scale"];
  tone?: Tone;
}) {
  const { colors, tokens } = useTheme(),
    t = tokens.typography.scale[variant];
  return (
    <Text
      {...props}
      allowFontScaling
      maxFontSizeMultiplier={t.maxFontSizeMultiplier}
      style={[
        {
          color: colors[tone],
          fontSize: t.size,
          lineHeight: t.lineHeight,
          fontWeight: t.weight as TextStyle["fontWeight"],
          letterSpacing: t.letterSpacing,
          fontFamily: variant.startsWith("mono")
            ? tokens.typography.family.mono[Platform.OS === "ios" ? "ios" : "android"]
            : undefined,
        },
        style,
      ]}
    />
  );
}
export function Panel({
  children,
  attention = false,
  style,
}: {
  children: React.ReactNode;
  attention?: boolean;
  style?: ViewStyle;
}) {
  const { colors, tokens } = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: attention ? colors.warnSoft : colors.panel,
          borderRadius: tokens.radius.card,
          borderWidth: 1,
          borderColor: colors.line,
          padding: tokens.spacing.alias.cardPadding,
          gap: 8,
          ...(attention ? { borderLeftWidth: 3, borderLeftColor: colors.warn } : {}),
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
export function Button({
  label,
  onPress,
  disabled = false,
  busy = false,
  primary = false,
  danger = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  primary?: boolean;
  danger?: boolean;
}) {
  const { colors, tokens, touch } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      android_ripple={{ color: colors.accentSoft }}
      style={({ pressed }) => ({
        minHeight: Math.max(touch, tokens.size.buttonHeight),
        padding: 12,
        borderRadius: tokens.radius.button,
        backgroundColor: primary ? colors.accentFill : colors.panel,
        borderColor: danger ? colors.bad : colors.line,
        borderWidth: 1,
        opacity: disabled || busy ? tokens.opacity.disabled : pressed ? tokens.opacity.pressed : 1,
        flexDirection: "row",
        gap: 8,
        alignItems: "center",
        justifyContent: "center",
      })}
    >
      {busy && <ActivityIndicator color={primary ? colors.onAccent : colors.accent} />}
      <AppText variant="bodyStrong" tone={primary ? "onAccent" : danger ? "bad" : "textMuted"}>
        {label}
      </AppText>
    </Pressable>
  );
}
export function Row({
  children,
  onPress,
  label,
  expanded,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  label?: string;
  expanded?: boolean;
}) {
  const { colors, tokens, touch } = useTheme();
  return (
    <Pressable
      disabled={!onPress}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={label}
      accessibilityState={expanded === undefined ? undefined : { expanded }}
      onPress={onPress}
      android_ripple={{ color: colors.accentSoft }}
      style={({ pressed }) => ({
        minHeight: touch,
        flexDirection: "row",
        gap: 12,
        alignItems: "center",
        paddingVertical: tokens.spacing.alias.rowPaddingV,
        opacity: pressed ? tokens.opacity.pressed : 1,
      })}
    >
      {children}
    </Pressable>
  );
}
export function Logo() {
  return (
    <Image
      accessible={false}
      source={require("../../assets/logo.png")}
      style={{ width: 72, height: 72, alignSelf: "center", marginVertical: 16 }}
    />
  );
}
export function Icon({ name, size = 20, tone = "accent" }: { name: string; size?: number; tone?: Tone }) {
  const { colors } = useTheme(),
    ink = colors[tone];
  const line = (x: number, y: number, length: number, angle: number, key: number) => (
    <View
      key={key}
      style={{
        position: "absolute",
        left: (x * size) / 24,
        top: (y * size) / 24,
        width: (length * size) / 24,
        height: 1.5,
        borderRadius: 1,
        backgroundColor: ink,
        transform: [{ rotate: `${angle}deg` }],
      }}
    />
  );
  const ring = (
    <View style={{ width: size * 0.8, height: size * 0.8, borderWidth: 1.5, borderColor: ink, borderRadius: size }} />
  );
  const content =
    name === "overview" ? (
      <View style={{ width: size, height: size, flexDirection: "row", flexWrap: "wrap", gap: 3 }}>
        {[0, 1, 2, 3].map((i) => (
          <View
            key={i}
            style={{
              width: (size - 3) / 2,
              height: (size - 3) / 2,
              borderWidth: 1.5,
              borderRadius: 2,
              borderColor: ink,
            }}
          />
        ))}
      </View>
    ) : name === "running" ? (
      <>
        {line(0, 12, 6, 0, 0)}
        {line(4, 9, 10, -65, 1)}
        {line(8, 12, 12, 65, 2)}
        {line(16, 14, 8, -55, 3)}
        {line(20, 11, 4, 0, 4)}
      </>
    ) : name === "settings" ? (
      <>
        {ring}
        {[0, 45, 90, 135].map((angle, i) => line(0, 11.5, 24, angle, i))}
        <View
          style={{
            width: size * 0.45,
            height: size * 0.45,
            borderRadius: size,
            backgroundColor: colors.panel,
            borderWidth: 1.5,
            borderColor: ink,
            position: "absolute",
          }}
        />
      </>
    ) : name === "next" || name === "back" ? (
      <>
        {line(7, 8, 10, name === "next" ? 45 : -45, 0)}
        {line(7, 15, 10, name === "next" ? -45 : 45, 1)}
      </>
    ) : name === "down" ? (
      <>
        {line(3, 10, 18, 90, 0)}
        {line(4, 16, 10, 45, 1)}
        {line(11, 16, 10, -45, 2)}
      </>
    ) : name === "check" ? (
      <>
        {line(3, 13, 8, 45, 0)}
        {line(8, 10, 15, -45, 1)}
      </>
    ) : (
      <>
        {ring}
        <AppText variant="micro" tone={tone} style={{ position: "absolute" }}>
          {name === "questions" ? "?" : "i"}
        </AppText>
      </>
    );
  return (
    <View
      accessible={false}
      importantForAccessibility="no"
      style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}
    >
      {content}
    </View>
  );
}
export function Empty({ title, body }: { title: string; body?: string }) {
  return (
    <View style={{ paddingVertical: 40, alignItems: "center", gap: 12 }}>
      <Icon name="check" size={40} />
      <AppText variant="headline" style={{ textAlign: "center" }}>
        {title}
      </AppText>
      {body && (
        <AppText variant="callout" tone="textMuted" style={{ maxWidth: 300, textAlign: "center" }}>
          {body}
        </AppText>
      )}
    </View>
  );
}
export function Skeleton({ rows = 4 }: { rows?: number }) {
  const { colors } = useTheme();
  return (
    <View accessibilityLabel={copyStrings.copy.loading} style={{ gap: 12 }}>
      {Array.from({ length: rows }, (_, i) => (
        <View
          key={i}
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          style={{ backgroundColor: colors.skeleton, height: 68, borderRadius: 10 }}
        />
      ))}
    </View>
  );
}
