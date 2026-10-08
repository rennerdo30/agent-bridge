import type { DatabaseSync } from "node:sqlite";

/** FULL/IOERR may already have rolled back every savepoint. Preserve the operation error. */
export function cleanupSavepoint(db: DatabaseSync, name: string, rollback: boolean, original: unknown): never {
  try { db.exec(`${rollback ? `ROLLBACK TO ${name}; ` : ""}RELEASE ${name}`); }
  catch { /* Cleanup cannot replace the original failure. */ }
  throw original;
}
