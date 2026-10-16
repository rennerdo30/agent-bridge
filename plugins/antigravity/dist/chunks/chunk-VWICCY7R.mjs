import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);

// src/core/node-version.ts
var MIN_NODE_MAJOR = 24;
function nodeVersionProblem(version) {
  const major = Number(/^v?(\d+)\./.exec(version)?.[1]);
  if (Number.isInteger(major) && major >= MIN_NODE_MAJOR) return null;
  return `agent-bridge requires Node.js ${MIN_NODE_MAJOR} or newer; this is Node.js ${version}. Install the current Node.js LTS (${MIN_NODE_MAJOR}) from https://nodejs.org, then restart this CLI.`;
}

// src/core/node-version-guard.ts
var problem = nodeVersionProblem(process.version);
if (problem) {
  process.stderr.write(`${problem}
`);
  process.exit(1);
}
