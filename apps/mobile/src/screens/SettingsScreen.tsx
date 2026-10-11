import { strings as copyStrings } from "../strings";
import React, { useEffect, useState } from "react";
import { Linking, View } from "react-native";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import type { Dashboard } from "../useDashboard";
import type { Preference } from "../theme";
import { enableNotifications } from "../notifications";
import { AppText, Button, Empty, Panel, Row } from "../components/primitives";
import { Header, Page, Section, Segments, Sheet } from "../components/layout";
export function SettingsScreen({ d, preference, setPreference, visible }: {
    d: Dashboard;
    preference: Preference;
    setPreference: (value: Preference) => void;
    visible: boolean;
}) {
    const [permission, setPermission] = useState("Not checked"), [forget, setForget] = useState(false);
    useEffect(() => {
        if (!visible)
            return;
        let active = true;
        void Notifications.getPermissionsAsync().then(p => {
            if (active)
                setPermission(p.granted ? "Allowed by phone OS" : "Off / not granted");
        }).catch(() => {
            if (active)
                setPermission(copyStrings.copy.unavailable);
        });
        return () => { active = false; };
    }, [visible, d.nav.route?.kind]);
    const sub = d.nav.route?.kind;
    return <View style={{ flex: 1, display: visible ? "flex" : "none" }}><Page>
  {sub === "connection" ? <><Header title={copyStrings.copy.connection} back={d.goBack}/><Panel><AppText variant="bodyStrong">{copyStrings.copy.thisPc2}{d.state.connection}</AppText>{d.state.snapshot && <AppText variant="monoSmall" selectable>{d.state.snapshot.pcId}</AppText>}<AppText variant="caption" tone="textFaint">{copyStrings.copy.source}{d.state.snapshot?.sourceState ?? "unavailable"}{copyStrings.copy.sample}{d.state.snapshot ? new Date(d.state.snapshot.sampledAt).toLocaleString() : "not loaded"}</AppText></Panel><Section title={copyStrings.copy.approvedHttpsAddresses}/>{d.client.approvedOrigins.map(origin => <Panel key={origin}><AppText variant="monoSmall" selectable>{origin}</AppText><AppText variant="caption" tone={origin === d.client.preferredOrigin ? "accent" : "textMuted"}>{origin === d.client.preferredOrigin ? "Preferred origin" : "Approved alternate"}</AppText></Panel>)}<Button label={copyStrings.copy.reconnectAndFetchFreshState} onPress={() => d.safe(() => d.client.reconnect())}/><AppText variant="caption" tone="textMuted">{copyStrings.copy.revokeFromTheDesktopPhonesPageLostIssuanceOrRefreshRequiresRe}</AppText></> : sub === "notifications" ? <><Header title={copyStrings.copy.ownerNotifications} back={d.goBack}/><Panel><AppText>{permission}</AppText><AppText variant="caption" tone="textMuted">{copyStrings.copy.osPermissionIsSeparateFromRegistrationProviderDeliveryAndQuestionAcceptance}</AppText></Panel><Button label={copyStrings.copy.enableGenericNotifications} disabled={!d.client.writesEnabled} primary onPress={() => d.safe(async () => { await enableNotifications(d.client, __DEV__ ? "development" : "production"); setPermission(copyStrings.copy.registrationRequestedDeliveryUnverified); })}/><Button label={copyStrings.copy.openPhoneSettings} onPress={() => { void Linking.openSettings(); }}/><AppText variant="caption" tone="textFaint">{copyStrings.copy.ownerProvisionedProjectSignedBuildAndDeviceRequiredNoTestNotificationApi}</AppText></> : sub === "about" ? <><Header title={copyStrings.copy.about} back={d.goBack}/><Panel><AppText variant="headline">{copyStrings.copy.agentBridge}</AppText><AppText>{copyStrings.copy.app}{Constants.expoConfig?.version ?? "version unavailable"}{copyStrings.copy.gatewayApi}{d.state.snapshot?.apiVersion ?? "unavailable"}</AppText><AppText variant="caption" tone="textFaint">{copyStrings.copy.privateLanTailscaleHttpsNoRelayPinningClaimOrContentDiskCache}</AppText></Panel><AppText selectable variant="monoSmall">{copyStrings.copy.ownerSetupDocsMobileSetupMdInTheDesktopCheckout}</AppText><AppText variant="callout">{copyStrings.copy.reactNativeExpoAndDependenciesRetainTheirPackageLicensesDeviceDistributionAnd}</AppText></> : sub === "native" || sub === "subagents" ? <><Header title={copyStrings.copy.unsupported} back={d.goBack}/><Empty title={copyStrings.copy.noAuthoritativeNativeLink} body={copyStrings.copy.thisApiDoesNotExposeASafeNativeChildDestinationOrOwnership}/></> : <><Header title={copyStrings.copy.settings}/><Section title={copyStrings.copy.connection}/><Panel><Row onPress={() => d.open({ kind: "connection" })}><AppText variant="bodyStrong">{copyStrings.copy.thisPc3}</AppText><AppText variant="subhead" tone="textMuted">{d.state.connection}{copyStrings.copy.message4}</AppText></Row></Panel><Section title={copyStrings.copy.notifications}/><Panel><Row onPress={() => d.open({ kind: "notifications" })}><AppText variant="bodyStrong">{copyStrings.copy.ownerQuestions}</AppText><AppText variant="subhead" tone="textMuted">{copyStrings.copy.message5}</AppText></Row></Panel><Section title={copyStrings.copy.appearance}/><Segments value={preference} onChange={v => setPreference(v as Preference)} options={[{ key: "system", label: "System" }, { key: "light", label: "Light" }, { key: "dark", label: "Dark" }]}/><Section title={copyStrings.copy.about}/><Panel><Row onPress={() => d.open({ kind: "about" })}><AppText>{copyStrings.copy.app}{Constants.expoConfig?.version ?? "unknown"}</AppText><AppText tone="textMuted">{copyStrings.copy.message5}</AppText></Row></Panel><Button label={copyStrings.copy.forgetThisPhoneSConnection} danger onPress={() => setForget(true)}/><AppText variant="caption" tone="textFaint">{copyStrings.copy.appearanceAndPreferencesLastOnlyWhileTheAppRunsDesktopSettingsPermission}</AppText></>}
  </Page><Sheet title={copyStrings.copy.forgetThisConnection} visible={forget} onClose={() => setForget(false)}><AppText>{copyStrings.copy.thisClearsThisPhoneSSavedCredentialsAndLoadedContentRevokeIt}</AppText><Button label={copyStrings.copy.forgetOnThisPhone} danger onPress={() => d.safe(async () => { await d.client.forget(); setForget(false); })}/></Sheet></View>;
}
