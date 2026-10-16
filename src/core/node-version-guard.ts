// Imported first by every entry point: refuse to start on an unsupported Node.js before anything else runs.
import { nodeVersionProblem } from "./node-version.js";

const problem = nodeVersionProblem(process.version);
if (problem) {
  process.stderr.write(`${problem}\n`);
  process.exit(1);
}
