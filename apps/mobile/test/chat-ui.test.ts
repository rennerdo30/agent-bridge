import { expect, it } from "vitest";
import { chatGroups, markdownBlocks, mergeChat } from "../src/view-model";
import { chat } from "../review/fixtures";
it("replaces stable IDs in place and groups tools without invented native links", () => {
  const update = { ...chat[1]!, text: "Updated", truncated: true };
  const items = mergeChat(chat, [update]);
  expect(items[1]).toEqual(update);
  const groups = chatGroups(items);
  expect(groups).toHaveLength(3);
  if (groups[2]?.kind === "steps") expect(groups[2].items).toHaveLength(4);
  else throw new Error("Expected tools");
});
it("bounds memory and treats HTML literally", () => {
  expect(
    mergeChat(
      [],
      Array.from({ length: 3001 }, (_, i) => ({ ...chat[0]!, id: String(i) }))
    )
  ).toHaveLength(3000);
  expect(markdownBlocks("# Header\n<script>remote()</script>\n```ts\nconst x = 1;\n```")).toEqual([
    { kind: "heading", text: "Header" },
    { kind: "paragraph", text: "<script>remote()</script>" },
    { kind: "code", text: "const x = 1;" },
  ]);
});
