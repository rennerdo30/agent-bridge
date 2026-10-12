import { vi } from "vitest";
import * as paths from "../src/core/display-paths.js";

/** A verified whole-drive alias without relying on a CI machine's drive letters. */
export function preferredDriveFixture() {
  const canonical = (path: string) => path === "E:\\" ? "Q:\\" : path;
  const path = paths.displayPath, text = paths.displayPathText;
  const pathSpy = vi.spyOn(paths, "displayPath").mockImplementation((value) => path(value, "win32", canonical));
  const textSpy = vi.spyOn(paths, "displayPathText").mockImplementation((value) => text(value, "win32", canonical));
  return () => { pathSpy.mockRestore(); textSpy.mockRestore(); };
}
