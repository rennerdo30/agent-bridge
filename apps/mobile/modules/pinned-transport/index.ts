import { requireNativeModule } from "expo";
import { createPinnedRequest, type NativePinnedTransport } from "./transport";

// Deliberately lazy: legacy no-pin devices may use Expo Go. A pinned request
// requires this module and propagates absence/failure without any fetch fallback.
export const request = createPinnedRequest(() => requireNativeModule<NativePinnedTransport>("PinnedTransport"));
