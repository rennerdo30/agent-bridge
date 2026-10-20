import { readProcessIdentities, readProcessIdentity } from "../src/core/process-identity.js";

/** Preserve the assertion failure even when owned-child cleanup also fails and retains the fixture. */
export async function withFixtureChildCleanup(
  assertions: () => Promise<void>, cleanup: () => Promise<void>, retainedMessage: string,
): Promise<void> {
  let assertionFailed = false, assertionError: unknown;
  try { await assertions(); }
  catch (error) { assertionFailed = true; assertionError = error; }
  try { await cleanup(); }
  catch (cleanupError) {
    if (assertionFailed) throw new AggregateError([assertionError, cleanupError], retainedMessage);
    throw new Error(retainedMessage, { cause: cleanupError });
  }
  if (assertionFailed) throw assertionError;
}

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
  if (await fixtureProcessGeneration(pid, expected, refusal, probes)) {
    try { probes.signal(pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
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
  child: FixtureChild, expected: string | null, refusal: string,
  probes: FixtureChildProbes = {
    identity: readProcessIdentity, signal: (pid, signal) => { process.kill(pid, signal); },
  },
): Promise<void> {
  const pid = child.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) throw new Error(refusal);
  const knownExit = () => child.exitCode !== null || child.signalCode !== null;
  await new Promise<void>((resolve, reject) => {
    const deadline = performance.now() + 3_000;
    const timeout = () => new Error(`${refusal}: exact child exit not observed within 3000 ms; fixture retained`);
    let settled = false, exited = false, inspected = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (ok: boolean, error?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); child.removeListener("exit", onExit);
      if (ok) resolve(); else reject(error);
    };
    const complete = () => {
      if (performance.now() >= deadline) { finish(false, timeout()); return; }
      if (inspected && (exited || knownExit())) finish(true);
    };
    const onExit = () => { exited = true; complete(); };
    // Observe this saved object before inspecting or signalling: PID absence, stdio closure and killed
    // are not its exit event. Unknown/reused identity only permits passive waiting on this owned child.
    child.once("exit", onExit);
    timer = setTimeout(() => finish(false, timeout()), 3_000);
    if (knownExit()) { inspected = true; complete(); return; }
    void (async () => {
      if (expected && !exited) {
        const matches = await probes.identity(pid) === expected;
        if (settled) return;
        if (performance.now() >= deadline) { finish(false, timeout()); return; }
        if (matches && !exited && !knownExit()) {
          try { probes.signal(pid, "SIGKILL"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        }
      }
      inspected = true; complete();
    })().catch(error => finish(false, error));
  });
}
