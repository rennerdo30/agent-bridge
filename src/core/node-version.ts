/** The oldest Node.js major agent-bridge runs on (owner decision 2026-10-16: Node 24 LTS and newer). */
export const MIN_NODE_MAJOR = 24;

/** Why this Node.js version cannot run agent-bridge, or null when it can. */
export function nodeVersionProblem(version: string): string | null {
  const major = Number(/^v?(\d+)\./.exec(version)?.[1]);
  if (Number.isInteger(major) && major >= MIN_NODE_MAJOR) return null;
  return `agent-bridge requires Node.js ${MIN_NODE_MAJOR} or newer; this is Node.js ${version}. ` +
    `Install the current Node.js LTS (${MIN_NODE_MAJOR}) from https://nodejs.org, then restart this CLI.`;
}
