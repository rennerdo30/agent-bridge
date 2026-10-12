import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { fetch as expoFetch } from "expo/fetch";
import { MobileClient, type StoredDevice, type WireFetch } from "./client";

const KEY = "agent-bridge.mobile.device.v1";
const options: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
// Expo native fetch enforces redirect:error (Android followRedirects(false), iOS redirection delegate).
// Never use React Native's global fetch, whose redirect controls differ across runtimes.
const wire: WireFetch = async (url, init) => expoFetch(url, init);
export const client = new MobileClient(wire, {
  load: async () => { const value = await SecureStore.getItemAsync(KEY, options); return value ? JSON.parse(value) as StoredDevice : null; },
  save: async device => { await SecureStore.setItemAsync(KEY, JSON.stringify(device), options); },
  clear: async () => { await SecureStore.deleteItemAsync(KEY, options); },
}, () => Crypto.randomUUID());
