import { BridgeError } from "./protocol.js";

export function transientRequestError(error: unknown): boolean {
  return error instanceof Error && /broker request timed out:|database is (?:locked|busy)|SQLITE_BUSY|SQLITE_LOCKED/i.test(error.message);
}

/** Only use for reads or operations carrying an unchanged durable identity. */
export async function retryRequest<T>(operation: string, request: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await request(); }
    catch (error) {
      if (!transientRequestError(error)) throw error;
      if (attempt === 2) throw new BridgeError("timeout",
        `${operation} unavailable after bounded retries; retry later. ${String(error)}`,
        { operation, retryLater: true, attempts: 3 });
      await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt));
    }
  }
}
