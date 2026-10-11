import React, { useState } from "react";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Linking, Modal, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { Dashboard } from "../useDashboard";
import { enableNotifications } from "../notifications";
import { ThemeProvider, useTheme } from "../theme";
import { AppText, Button, Logo, Panel } from "../components/primitives";
import { Header, Page } from "../components/layout";
import { PairingCode, QrFrame } from "../components/pairing";
import { strings as copyStrings } from "../strings";
export function PairingScreen({ d }: { d: Dashboard }) {
  const { tokens } = useTheme(),
    [camera, requestCamera] = useCameraPermissions(),
    [torch, setTorch] = useState(false);
  const scan = () =>
    d.safe(async () => {
      const p = camera?.granted ? camera : await requestCamera();
      d.setScanning(true);
      if (!p.granted) d.setNotice("Camera access is off. Enable it in phone Settings to scan.");
    });
  return (
    <Page>
      {d.primer ? (
        <>
          <Header title={copyStrings.copy.getToldWhenAnAgentAsksYou} />
          <AppText>{copyStrings.copy.notificationsContainOnlyAQuestionIsWaitingForYouOpenTheApp}</AppText>
          <Button
            label={copyStrings.copy.turnOnNotifications}
            primary
            disabled={!d.client.writesEnabled}
            onPress={() =>
              d.safe(async () => {
                await enableNotifications(d.client, __DEV__ ? "development" : "production");
                d.setPrimer(false);
              })
            }
          />
          <Button label={copyStrings.copy.notNow} onPress={() => d.setPrimer(false)} />
          <AppText variant="caption" tone="textMuted">
            {copyStrings.copy.registrationDoesNotProveProviderDeliverySignedBuildsOwnerProjectIdentityAnd}
          </AppText>
        </>
      ) : (
        <>
          <Header
            title={
              d.claim
                ? "Confirm on your PC"
                : d.qr
                  ? "Review private PC addresses"
                  : d.state.connection === "revoked"
                    ? "Pairing no longer usable"
                    : "Your agents, on your phone"
            }
          />
          {!d.qr && !d.claim && (
            <>
              <Logo />
              <AppText variant="largeTitle" tone="accent" style={{ textAlign: "center" }}>
                {copyStrings.copy.agentBridge}
              </AppText>
              <AppText tone="textMuted">{copyStrings.copy.yourAgentsDashboardOnYourPhone}</AppText>
              {[
                "See which sessions and subagents are working",
                "Read their conversations",
                "Answer local owner questions",
              ].map((label) => (
                <Panel key={label}>
                  <AppText variant="callout">
                    {copyStrings.copy.message2}
                    {label}
                  </AppText>
                </Panel>
              ))}
              {d.state.connection === "revoked" && (
                <AppText variant="callout" tone="warn">
                  {copyStrings.copy.savedCredentialsAndLoadedContentWereClearedCheckThePcRemovalIdentity}
                </AppText>
              )}
              <Button label={copyStrings.copy.pairWithYourPc} primary onPress={scan} />
              <AppText variant="caption" tone="textMuted">
                {copyStrings.copy.openTheDesktopDashboardSPhonesPageScanItsSingleUseQr}
              </AppText>
            </>
          )}
          {d.qr && (
            <>
              <Panel>
                <AppText variant="overline" tone="accent">
                  {copyStrings.copy.approvedAddressReview}
                </AppText>
                {d.qr.origins.map((origin) => (
                  <AppText key={origin} variant="monoSmall" selectable>
                    {origin}
                  </AppText>
                ))}
                <AppText variant="caption" tone="textMuted">
                  {copyStrings.copy.pcIdentity}
                  {d.qr.pcId}
                </AppText>
              </Panel>
              <AppText variant="caption" tone="textMuted">
                {copyStrings.copy.qrExpires}
                {new Date(d.qr.expiresAt).toLocaleTimeString()}
                {copyStrings.copy.message}
                {Math.max(0, Math.ceil((d.qr.expiresAt - d.now) / 1000))}
                {copyStrings.copy.sLeft}
              </AppText>
              {!d.claim && (
                <Button
                  label={copyStrings.copy.connectToThesePcAddresses}
                  primary
                  busy={d.pairBusy}
                  disabled={d.now >= d.qr.expiresAt}
                  onPress={() => d.safe(d.pair)}
                />
              )}
              <AppText variant="caption" tone="textFaint">
                {copyStrings.copy.normalPhoneTrustedHttpsRequiredNoFingerprintPinningOrTlsBypass}
              </AppText>
            </>
          )}
          {d.claim && (
            <>
              <PairingCode code={d.claim.comparisonCode} />
              <AppText>{copyStrings.copy.compareEveryDigitWithThePcSRequestOnlyTheDesktopOwner}</AppText>
              <AppText variant="subhead" tone="textMuted">
                {copyStrings.copy.waitingForYourPc}
              </AppText>
            </>
          )}
          {(d.qr || d.claim) && <Button label={copyStrings.copy.cancelUseANewQr} onPress={d.cancelPair} />}
        </>
      )}
      <Modal visible={d.scanning} onRequestClose={() => d.setScanning(false)}>
        <ThemeProvider preference="dark">
          <SafeAreaView style={{ flex: 1, backgroundColor: tokens.color.dark.bg }}>
            <View style={{ padding: 16, gap: 12 }}>
              <Button label={copyStrings.copy.back} onPress={() => d.setScanning(false)} />
              <AppText variant="title" style={{ color: tokens.color.dark.text }}>
                {copyStrings.copy.scanPairingCode}
              </AppText>
            </View>
            {camera?.granted ? (
              <View style={{ flex: 1 }}>
                <CameraView
                  style={{ flex: 1 }}
                  enableTorch={torch}
                  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                  onBarcodeScanned={({ data }) => {
                    if (d.scanning) d.scan(data);
                  }}
                />
                <QrFrame />
              </View>
            ) : (
              <View style={{ flex: 1, padding: 24, gap: 16 }}>
                <AppText style={{ color: tokens.color.dark.text }}>{copyStrings.copy.cameraAccessIsOff}</AppText>
                <Button
                  label={copyStrings.copy.openPhoneSettings}
                  onPress={() => {
                    void Linking.openSettings();
                  }}
                />
              </View>
            )}
            <View style={{ padding: 16, gap: 12 }}>
              <AppText variant="callout" style={{ color: tokens.color.dark.text }}>
                {copyStrings.copy.pointAtYourPcSSingleUseCodeExpiresAfter120Seconds}
              </AppText>
              {d.notice && (
                <AppText variant="caption" tone="warn">
                  {d.notice}
                </AppText>
              )}
              <Button
                label={torch ? "Turn off torch" : "Turn on torch"}
                disabled={!camera?.granted}
                onPress={() => setTorch((v) => !v)}
              />
            </View>
          </SafeAreaView>
        </ThemeProvider>
      </Modal>
    </Page>
  );
}
