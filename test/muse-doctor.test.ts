import { describe, expect, it } from "vitest";
import { inspectPluginVersions, pluginDoctorPaths } from "../src/cli/plugin-doctor.js";
describe("Muse installation inspection", () => {
  it("explicitly reports unavailable installation evidence without running a native manager", () => {
    const paths = pluginDoctorPaths("/fixture/bridge", "/fixture/no-user");
    expect(inspectPluginVersions(paths).find(f => f.code === "muse-installation-inspection-unavailable"))
      .toMatchObject({ severity: "warning", fixable: false, path: paths.muse });
  });
});
