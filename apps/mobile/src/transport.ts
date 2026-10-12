import { exactPins, type WireFetch } from "./client";

/** Pinning is a device property, not a retry option. Any pinned transport failure is terminal. */
export function gatewayTransport(unpinned: WireFetch, pinned: WireFetch): WireFetch {
  return (url, init, pins) => pins === undefined ? unpinned(url, init) : pinned(url, init, exactPins(pins));
}
