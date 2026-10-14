import { readProcessIdentities } from "../src/core/process-identity.js";

interface FixtureProcessProbes {
  identities(pids: number[]): Promise<Map<number, string>>;
  exists(pid: number): void;
}

export function fixtureProcessExists(pid: number, refusal: string, exists: (pid: number) => void = pid => { process.kill(pid, 0); }): boolean {
  try { exists(pid); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw new Error(refusal, { cause: error });
  }
}

/** A missing identity can mean exit or unavailable inspection. Only ESRCH
 * confirms exit; a living/reused/unverifiable PID never authorizes a signal. */
export async function fixtureProcessGeneration(
  pid: number,
  expected: string,
  refusal: string,
  probes: FixtureProcessProbes = { identities: readProcessIdentities, exists: pid => { process.kill(pid, 0); } },
): Promise<boolean> {
  if ((await probes.identities([pid])).get(pid) === expected) return true;
  if (!fixtureProcessExists(pid, refusal, probes.exists)) return false;
  throw new Error(refusal);
}
