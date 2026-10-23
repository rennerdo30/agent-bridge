/** Synchronous effect scope of one deadline-owned mailbox admission. No proof is
 * cached by home or carried into later turns. Slow work must yield before entry;
 * nested storage opens/locks fail busy rather than starting their own wait. */
let active: (() => number) | undefined;
export function storageAdmissionRemaining(): number | undefined { return active?.(); }
export function storageAdmissionTimeout(normal: number): number {
  return storageAdmissionRemaining() === undefined ? normal : 0;
}
export function withStorageAdmission<T>(check: () => number, effect: () => T): T {
  const previous = active; active = check;
  try { check(); return effect(); }
  finally { active = previous; }
}
