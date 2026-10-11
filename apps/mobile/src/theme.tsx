import React, { createContext, useContext, useEffect, useState } from "react";
import { AccessibilityInfo, Platform, StatusBar, useColorScheme, useWindowDimensions } from "react-native";
import tokens from "./tokens.json";
export type Preference = "system" | "light" | "dark";
const Context = createContext({ colors: tokens.color.light, scheme: "light" as "light" | "dark", large: false, reduced: true });
export function ThemeProvider({ preference, children }: { preference: Preference; children: React.ReactNode }) {
  const system = useColorScheme(), { fontScale } = useWindowDimensions(), [reduced, setReduced] = useState(true);
  const scheme = preference === "system" ? system === "dark" ? "dark" : "light" : preference;
  useEffect(() => { let active = true; void AccessibilityInfo.isReduceMotionEnabled().then(v => { if (active) setReduced(v); }); const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced); return () => { active = false; sub.remove(); }; }, []);
  return <Context.Provider value={{ colors: tokens.color[scheme], scheme, large: fontScale >= 1.35, reduced }}><StatusBar barStyle={scheme === "dark" ? "light-content" : "dark-content"} />{children}</Context.Provider>;
}
export const useTheme = () => ({ ...useContext(Context), tokens, touch: tokens.size.touchTargetMin[Platform.OS === "ios" ? "ios" : "android"] });
