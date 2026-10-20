/** One UI-owned peer, with request deadlines independent of its ongoing discovery. */
interface SenderNode {
  start(): Promise<void>;
  stop(): Promise<void>;
}

const READINESS_MS = 8_000;
const unavailable = () => new Error("agent-bridge broker is unavailable");

export function retainedUiSender<T extends SenderNode>(prepare: () => Promise<unknown>, create: () => T) {
  let closed = false;
  let node: T | undefined;
  let initialization: Promise<T> | undefined;
  let stopping: Promise<void> | undefined;
  type Attempt = { promise: Promise<T>; waiters: number };
  let readiness: Attempt | undefined;
  const cancelWaiters = new Set<() => void>();

  const initialize = () => initialization ??= Promise.resolve().then(prepare).then(() => {
    // close() never waits on a potentially slow preparation, and late completion
    // must not acquire metadata readers or start a new peer after shutdown.
    if (closed) throw unavailable();
    return node = create();
  });

  return {
    get(signal?: AbortSignal): Promise<T> {
      if (closed || signal?.aborted) return Promise.reject(unavailable());
      const deadline = Date.now() + READINESS_MS;
      // Install the request budget BEFORE initialization or construction starts.
      return new Promise<T>((resolve, reject) => {
        let attempt: Attempt | undefined;
        let settled = false;
        const finish = (result: { error: unknown } | { node: T }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
          cancelWaiters.delete(cancel);
          if (attempt && --attempt.waiters === 0 && readiness === attempt && "error" in result) {
            // Leave the node and initialization intact. A later request calls
            // start() again; BridgeNode shares any still-running election.
            readiness = undefined;
          }
          if ("error" in result) reject(result.error); else resolve(result.node);
        };
        const cancel = () => finish({ error: unavailable() });
        const timer = setTimeout(cancel, READINESS_MS);
        cancelWaiters.add(cancel);
        signal?.addEventListener("abort", cancel, { once: true });
        readiness ??= {
          waiters: 0,
          promise: Promise.resolve().then(async () => {
            const owned = await initialize();
            if (closed) throw unavailable();
            await owned.start();
            if (closed) throw unavailable();
            return owned;
          }),
        };
        attempt = readiness;
        attempt.waiters++;
        attempt.promise.then(value => {
          // A synchronous constructor/filesystem stall cannot be preempted by
          // a timer; still refuse a late send when the event loop resumes.
          if (closed || signal?.aborted || Date.now() >= deadline) cancel();
          else finish({ node: value });
        }, error => finish({ error }));
      });
    },
    close(): Promise<void> {
      closed = true;
      for (const cancel of cancelWaiters) cancel();
      // stop() sets the node's stopping flag before awaiting its owned election.
      // Waiting on readiness first would leave discovery running through close.
      return stopping ??= node ? node.stop() : Promise.resolve();
    },
  };
}
