/** Used at every normal Bridge child boundary, including detached runner launches. */
export function withoutT3Context(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    key.toUpperCase() !== "AGENT_BRIDGE_HOST" && !key.toUpperCase().startsWith("T3_ACP_MCP_")));
}

/**
 * Keep per-worktree .NET first runs from registering another global-tools PATH.
 * Defaults affect child environments only. Every explicit value, including empty
 * or undefined own properties, belongs to the user and remains unchanged.
 */
export function jobEnvironment(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const result = withoutT3Context(env);
  const defaults = { DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: "0", DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1" };
  for (const [key, value] of Object.entries(defaults)) {
    const present = Object.hasOwn(env, key) || platform === "win32" && Object.keys(env).some(existing => existing.toUpperCase() === key);
    if (!present) result[key] = value;
  }
  return result;
}
