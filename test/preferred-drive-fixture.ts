import { vi } from "vitest";
import * as paths from "../src/core/display-paths.js";

/** A verified whole-drive alias without relying on a CI machine's drive letters. */
export async function preferredDriveFixture(mappings: Readonly<Record<string, string>> = { "X:\\": "Q:\\" }) {
  const canonical = (path: string) => mappings[path] ?? path;
  await paths.refreshDriveAliases("win32", canonical);
  const path = paths.displayPath, text = paths.displayPathText;
  const pathSpy = vi.spyOn(paths, "displayPath").mockImplementation((value) => path(value, "win32", canonical));
  const textSpy = vi.spyOn(paths, "displayPathText").mockImplementation((value) => text(value, "win32", canonical));
  return () => { pathSpy.mockRestore(); textSpy.mockRestore(); };
}
