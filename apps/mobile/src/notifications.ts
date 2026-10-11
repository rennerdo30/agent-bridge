import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { ClientFault, type MobileClient } from "./client";

/** Opt-in registration seam only. Project identity/provider credentials are owner-managed. */
export async function enableNotifications(client: MobileClient, environment: "development" | "production"): Promise<void> {
  const projectId: unknown = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
  if (!Device.isDevice || typeof projectId !== "string" || !["android", "ios"].includes(Platform.OS)) throw new ClientFault("push_unsupported");
  if (Platform.OS === "android") await Notifications.setNotificationChannelAsync("owner-updates", { name: "Owner updates", importance: Notifications.AndroidImportance.DEFAULT });
  const permissions = await Notifications.requestPermissionsAsync();
  if (permissions.status !== "granted") throw new ClientFault("notification_permission_denied");
  const token = await Notifications.getExpoPushTokenAsync({ projectId });
  await client.registerPush({ expoPushToken: token.data, platform: Platform.OS as "android" | "ios", projectId, environment });
}
export function watchNotificationTaps(client: MobileClient, openQuestion: (id: string) => void, report: (message: string) => void): () => void {
  let lastIdentifier: string | undefined;
  const handle = async (response: Notifications.NotificationResponse) => {
    if (lastIdentifier === response.notification.request.identifier) return;
    lastIdentifier = response.notification.request.identifier;
    const data = response.notification.request.content.data;
    if (data.v !== 1 || typeof data.notificationId !== "string") return;
    try { const id = await client.resolveNotification(data.notificationId); if (id) openQuestion(id); }
    catch { report("Reconnect to fetch the current question. The notification carries no answer action."); }
  };
  const subscription = Notifications.addNotificationResponseReceivedListener(response => { void handle(response); });
  void Notifications.getLastNotificationResponseAsync().then(response => { if (response) void handle(response); });
  return () => subscription.remove();
}
