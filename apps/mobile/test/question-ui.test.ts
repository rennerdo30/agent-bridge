import { expect, it } from "vitest";
import { AnswerLatch, choice, choose, draftKey, emptyDraft, mayReview, retainDrafts, stillConfirmed } from "../src/view-model";
it("retains unchanged drafts through unrelated activity but wipes revocation, epoch and changed terms", () => { const key=draftKey(snapshot, question), draft=choose(emptyDraft(),{option:'wait'}), all={[key]:draft}; expect(retainDrafts(all,{...snapshot,cursor:'new'})).toEqual(all); expect(retainDrafts(all,null)).toEqual({}); expect(retainDrafts(all,{...snapshot,epoch:'other'})).toEqual({}); expect(retainDrafts(all,{...snapshot,questions:[{...question,version:'2'}]})).toEqual({}); });
it("does not re-enable an ambiguous answer merely because a fresh view arrived", () => { const draft=choose(emptyDraft(),{option:'wait'}); expect(mayReview(question,draft,true,false,true)).toBe(false); expect(mayReview(question,draft,true,true,false)).toBe(false); expect(mayReview(question,draft,false,false,false)).toBe(false); expect(mayReview(question,draft,true,false,false)).toBe(true); });
import { question, snapshot } from "../review/fixtures";
it("allows exactly one bounded literal answer", () => { let d = choose(emptyDraft(), { option: "wait" }); expect(choice(d)).toEqual({ option: "wait" }); d = choose(d, { text: "  exact intent  " }); expect(choice(d)).toEqual({ text: "  exact intent  " }); expect(d.option).toBeNull(); expect(choose(d, { text: "x".repeat(9000) }).text).toHaveLength(8000); expect(choice(choose(d, { text: "  " }))).toBeNull(); });
it("invalidates version/PC/epoch but permits unrelated cursor churn", () => { const key = draftKey(snapshot, question); expect(stillConfirmed(key, { ...snapshot, cursor: "view2" }, question, true)).toBe(true); for (const s of [{ ...snapshot, epoch: "epoch2" }, { ...snapshot, pcId: "other" }])
    expect(stillConfirmed(key, s, question, true)).toBe(false); expect(stillConfirmed(key, snapshot, { ...question, version: "2" }, true)).toBe(false); });
it("fails closed when authority expires/reconnects or question disappears/closes", () => { const key = draftKey(snapshot, question); expect(stillConfirmed(key, snapshot, question, false)).toBe(false); expect(stillConfirmed(key, null, question, true)).toBe(false); expect(stillConfirmed(key, snapshot, undefined, true)).toBe(false); expect(stillConfirmed(key, snapshot, { ...question, status: "answered" }, true)).toBe(false); });
it("holds single flight through back navigation and never auto-replays", async () => { const latch = new AnswerLatch(); let done!: () => void; const wait = new Promise<void>(r => { done = r; }); let posts = 0; const send = async () => { if (!latch.take())
    return; posts++; try {
    await wait;
}
finally {
    latch.release();
} }; const first = send(); await send(); expect(posts).toBe(1); expect(latch.busy).toBe(true); done(); await first; expect(latch.busy).toBe(false); expect(posts).toBe(1); });
