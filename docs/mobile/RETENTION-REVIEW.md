# Mobile retention review and push archive repair

Review for AB-271, baseline `c7934577`, 2026-10-11. The dependency commit recorded
this existing defect. A separately authorized follow-up replaces it with retained
push tombstones; the historical call sites below refer to that baseline. The
retention guard and its whitelist remain unchanged.

## Implemented push archive repair

`mobile_records` gains `status` (default `active`), `revokedAt` and `reason` through
transactional additive ALTER statements. Existing JSON bytes remain unchanged.
`MobileStore.archivePush()` marks the push row `revoked` and keeps its encrypted
iv/tag/ciphertext. All registry `get` and `list` queries select only `active` rows;
notification sends use those filtered reads. Repeated revocation preserves the
first timestamp and reason. Device revocation and its push tombstone commit atomically.

| Trigger | Stored reason |
| --- | --- |
| Authenticated push unsubscribe | `unsubscribe` |
| Owner desktop device revoke | `device-revoke` |
| Authenticated session logout | `logout` |
| Retired refresh token reuse | `refresh-reuse` |
| Provider submission rejects the registration | `provider-invalid` |

Registration replacement first appends the previous exact ciphertext and lifecycle
metadata to `mobile_push_history` in the same transaction, then activates the new
registration. A revoked device cannot register using a stale device object. Late
provider invalidation conditionally archives only the registration that was submitted,
so it cannot deactivate a replacement. No automatic resend or provider receipt behavior
is added. History never contains plaintext push tokens.

`test/mobile-retention.test.ts` covers each trigger, active-read and send exclusion,
restart persistence, original-schema migration/idempotence, replacement retention,
late provider failure, and transaction rollback on tombstone/history failures.
Archive inspection/export and long-term encryption-key retention remain owner operations;
the runtime does not expose retained ciphertext. Downgrading to older code that does
not filter status is unsupported.

## Historical deletion at the design baseline

`test/data-retention.test.ts:81` rejects the single production SQL deletion:

```ts
// src/mobile/store.ts:48, MobileStore.remove(kind, id)
this.db.prepare("DELETE FROM mobile_records WHERE kind=? AND id=?").run(kind, id);
```

The baseline isolated guard rerun failed 1/7 (6 pass). Dependency changes did not alter the
production source or guard. The generic method could delete any kind, but every baseline
production caller supplies **push**; none supplies invite, claim, session, device or answer.

## Exact callers and triggers

| Call site | Caller / trigger | Record actually deleted |
| --- | --- | --- |
| `src/mobile/store.ts:150` | `MobileStore.revoke()` marks the device revoked, then calls `remove("push", id)` | Encrypted push registration keyed by device id |
| `src/mobile/desktop.ts:60` -> store:150 | Owner desktop `DELETE /api/mobile/devices/:id` | Same push registration; device row remains revoked |
| `src/mobile/gateway.ts:212` -> store:150 | Authenticated `DELETE /mobile/v1/me/session` | Same push registration; device row remains revoked |
| `src/mobile/store.ts:131` -> store:150 | Refresh token reuse detects a retired refresh hash and revokes the device | Same push registration; session row and retired hashes remain |
| `src/mobile/push.ts:32` | `MobilePush.remove()` calls `store.remove("push", deviceId)` | Same encrypted push registration |
| `src/mobile/gateway.ts:213` -> push:32 | Authenticated `DELETE /mobile/v1/me/push` | Same push registration |
| `src/mobile/push.ts:52` -> push:32 | `MobilePush.notify()` receives `device-not-registered` from provider submission | Same push registration |

Provider receipt handling does not currently call remove; only the submission result
does. Notification dispatch originates from `src/mobile/bootstrap.ts:47` after a
fresh current-question check. It retains `hint` and `push-dedupe` records.

## Other record kinds and future retention design

Replace generic deletion with an atomic archive/tombstone operation. Preserve the exact
original JSON bytes in append-only history with kind/id/revision, time, reason and actor.
Mark the current row inactive without removing it; current `get`/`list` paths must exclude
archived rows. Archive failure must leave the original intact. Authorization must fail
closed using retained revocation/expiry state. Archived push/session records must never
become eligible for delivery/authentication simply because history exists.

| Kind | Current behavior / triggers | Archive proposal |
| --- | --- | --- |
| `push` | Only kind reaching baseline DELETE: unsubscribe, revocation, refresh reuse, invalid provider token. Baseline `push.ts:29` also overwrote registrations. | Implemented: retain current tombstone and exact encrypted history on replacement. Provider invalidation preserves registration evidence. |
| `invite` | Created at store:72; claimed flag overwritten at :79. Expired challenges remain and are filtered. No remove caller. | Preserve each state revision; mark claimed/expired without deletion. Expiry must continue preventing replay. |
| `claim` | Created at store:81; approval/denial at :98 and issuance at :112 overwrite state. Expired claims remain. No remove caller. | Append pending/approved/denied/issued/expired transitions and preserve original record bytes. Archived comparison/token data remains owner-private; never reissue credentials from history. |
| `session` / rotated credential hashes | store:120 overwrites current access/refresh/CSRF hashes. :119 retains old refresh hashes in `retired`; old access/CSRF hashes are overwritten. No remove caller. | Archive previous session revision before rotation; preserve every hash and absolute expiry/reuse/revocation evidence. Authenticate only current active hashes; retired hashes remain rejection/reuse-detection evidence. Never archive plaintext tokens. |
| `device` | Created at store:96; revoke overwrites revoked/revision at :150. Device row remains; its push row is deleted. | Retain device/grant revisions and append revocation event atomically with archiving the push registration. Revocation must stay effective across history reads/restarts. |
| Owner questions / answers | Adapter answer at adapter:99 delegates to the existing owner-question service; gateway:258 dispatches it. No mobile_records answer kind/remove caller. Idempotency results use mobile_replays (store:58). | Preserve authoritative question/answer/delivery history in the existing owner store; retain replay/CAS evidence. Do not invent or duplicate an authoritative answer in mobile_records. Any future compaction must archive original results first. |
| `meta`, `hint`, `push-dedupe`, `mobile_replays` | No remove caller. Metadata/dedupe are upserted; replay reserve/finish update bookkeeping. Hints expire by read checks rather than deletion. | Preserve overwritten revisions and expire active views with tombstones. Keep dedupe/replay evidence so archiving cannot cause automatic resend or idempotency replay. |

Archive access must preserve existing storage permissions and encrypted push material;
archive export/restore and key retention need explicit design, not new secret exposure.
Tests for any future broader history change should prove byte-exact history, rollback
on archive failure, enduring revocation/reuse rejection, expiry and no mutation replay.
Keep the existing retention guard strict; do not whitelist SQL deletion.
