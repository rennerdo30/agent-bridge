import React from "react";
import { View } from "react-native";
import { useTheme } from "../theme";
import { AppText } from "./primitives";
export function Pill({ status, percent }: { status: string; percent?: number | null }) {
  const { colors, tokens } = useTheme();
  const kind = tokens.status[status as keyof typeof tokens.status];
  const fg = typeof kind === "object" && "fg" in kind ? kind.fg : "textMuted",
    bg = typeof kind === "object" && "bg" in kind ? kind.bg : "panel2";
  const label = status === "running" ? "working" : status;
  return (
    <View
      style={{
        alignSelf: "flex-start",
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        backgroundColor: colors[bg as keyof typeof colors],
        paddingVertical: 2,
        paddingHorizontal: 8,
        borderRadius: tokens.radius.pill,
      }}
    >
      <View
        accessible={false}
        style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors[fg as keyof typeof colors] }}
      />
      <AppText variant="caption" style={{ color: colors[fg as keyof typeof colors] }}>
        {label}
        {percent != null ? ` · ${percent}%` : ""}
      </AppText>
    </View>
  );
}
export function Chip({ label, tone = "neutral" }: { label: string; tone?: "neutral" | "accent" | "warn" }) {
  const { colors, tokens } = useTheme();
  return (
    <View
      style={{
        alignSelf: "flex-start",
        borderRadius: tokens.radius.chip,
        paddingHorizontal: 7,
        paddingVertical: 3,
        backgroundColor: tone === "neutral" ? colors.panel2 : tone === "warn" ? colors.warnSoft : colors.accentSoft,
      }}
    >
      <AppText variant="micro" tone={tone === "neutral" ? "textMuted" : tone}>
        {label}
      </AppText>
    </View>
  );
}
export function Avatar({ agent, small = false }: { agent: string; small?: boolean }) {
  const { tokens } = useTheme();
  return (
    <View
      accessible={false}
      style={{
        width: small ? tokens.size.avatarSm : tokens.size.avatar,
        height: small ? tokens.size.avatarSm : tokens.size.avatar,
        borderRadius: tokens.radius.avatar,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: ["claude", "codex", "opencode", "antigravity", "muse"].includes(agent)
          ? tokens.agent[agent as "claude"]
          : tokens.agent.other,
      }}
    >
      <AppText variant="micro" style={{ color: tokens.agent.initialColor }}>
        {agent[0]?.toUpperCase() ?? "?"}
      </AppText>
    </View>
  );
}
export function Progress({ percent }: { percent: number }) {
  const { colors, tokens } = useTheme();
  const value = Math.min(100, Math.max(0, percent));
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: value }}
      style={{ height: tokens.size.progressBarHeightLarge, backgroundColor: colors.line, borderRadius: 2 }}
    >
      <View style={{ width: `${value}%`, height: "100%", backgroundColor: colors.accent, borderRadius: 2 }} />
    </View>
  );
}
