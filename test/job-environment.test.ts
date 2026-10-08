import { expect, it } from "vitest";
import { jobEnvironment } from "../src/core/job-environment.js";

it("adds only .NET child defaults, preserving PATH and the selected CLI home", () => {
  const original = { PATH: "owner PATH bytes", DOTNET_CLI_HOME: "D:/isolated/home", OTHER: "keep" };
  expect(jobEnvironment(original)).toEqual({ ...original, DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: "0", DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1" });
  expect(original).toEqual({ PATH: "owner PATH bytes", DOTNET_CLI_HOME: "D:/isolated/home", OTHER: "keep" });
});

it.each(["", "1", "custom", undefined])("preserves explicit user values %j by property presence", (value) => {
  const env = { DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: value, DOTNET_SKIP_FIRST_TIME_EXPERIENCE: value };
  const result = jobEnvironment(env);
  expect(Object.hasOwn(result, "DOTNET_ADD_GLOBAL_TOOLS_TO_PATH")).toBe(true);
  expect(result).toEqual(env);
});

it("preserves Windows environment names without adding duplicate upper-case defaults", () => {
  const env = { dotnet_add_global_tools_to_path: "", Dotnet_Skip_First_Time_Experience: "custom", Path: "keep bytes" };
  expect(jobEnvironment(env, "win32")).toEqual(env);
});
