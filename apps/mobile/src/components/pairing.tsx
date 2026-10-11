import React from "react";
import { View } from "react-native";
import { useTheme } from "../theme";
import { AppText } from "./primitives";
export function PairingCode({ code }: { code: string }) { const { colors } = useTheme(); return <View style={{ backgroundColor: colors.accentSoft, borderRadius: 10, padding: 24, alignItems: "center" }}><AppText variant="mono" accessibilityLabel={code.split("").join(" ")} style={{ fontSize: 32, lineHeight: 42, letterSpacing: 4 }}>{code.slice(0,3)} {code.slice(3)}</AppText></View>; }
export function QrFrame() { const { colors, tokens } = useTheme(); return <View pointerEvents="none" accessible={false} style={{ position: "absolute", alignSelf: "center", top: "25%", width: tokens.size.qrFrame, height: tokens.size.qrFrame }}>{[0,1,2,3].map(i => <View key={i} style={{ position: "absolute", width: 28, height: 28, borderColor: colors.accent, borderTopWidth: i < 2 ? 4 : 0, borderBottomWidth: i > 1 ? 4 : 0, borderLeftWidth: i % 2 === 0 ? 4 : 0, borderRightWidth: i % 2 ? 4 : 0, top: i < 2 ? 0 : undefined, bottom: i > 1 ? 0 : undefined, left: i % 2 === 0 ? 0 : undefined, right: i % 2 ? 0 : undefined }} />)}</View>; }
