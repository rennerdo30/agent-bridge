import { readProcessIdentities, readProcessIdentity } from "../src/core/process-identity.js";

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

interface FixtureSignalProbes extends FixtureProcessProbes {
  signal(pid: number, signal: NodeJS.Signals): void;
}

/** Signal only a verified fixture generation; callers still prove exit before forgetting it. */
export async function signalFixtureProcess(
  pid: number, expected: string, refusal: string, signal: NodeJS.Signals,
  probes: FixtureSignalProbes = {
    identities: readProcessIdentities, exists: pid => { process.kill(pid, 0); },
    signal: (pid, signal) => { process.kill(pid, signal); },
  },
): Promise<void> {
  if (await fixtureProcessGeneration(pid, expected, refusal, probes)) probes.signal(pid, signal);
}

interface FixtureChild {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  once(event: "exit", listener: () => void): unknown;
  removeListener(event: "exit", listener: () => void): unknown;
}

interface FixtureChildProbes {
  identity(pid: number): Promise<string | null>;
  signal(pid: number, signal: NodeJS.Signals): void;
}

/** Only for the ChildProcess created and recorded by the calling fixture. */
export async function stopFixtureChild(
  child: FixtureChild, expected: string | null, _refusal: string,
  probes: FixtureChildProbes = {
    identity: readProcessIdentity, signal: (pid, signal) => { process.kill(pid, signal); },
  },
): Promise<void> {
  if (expected && await probes.identity(child.pid!) === expected) probes.signal(child.pid!, "SIGKILL");
}
