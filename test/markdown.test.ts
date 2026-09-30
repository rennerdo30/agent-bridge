import { describe, expect, it } from "vitest";
import { renderMarkdown as md } from "../src/cli/markdown.js";
import { MARKDOWN_SOURCE, UI_PAGE } from "../src/cli/ui-page.js";

describe("dashboard markdown", () => {
  it("renders what agents write", () => {
    expect(md("**Fixed** the `gate` in *two* places")).toBe("<p><strong>Fixed</strong> the <code>gate</code> in <em>two</em> places</p>");
    expect(md("## Result\n- one\n- two\n\n1. first\n2. second")).toBe("<h4>Result</h4><ul><li>one</li><li>two</li></ul><ol><li>first</li><li>second</li></ol>");
    expect(md("```ts\nconst a = 1 < 2;\n```")).toBe("<pre><code>const a = 1 &lt; 2;</code></pre>");
    expect(md("| a | b |\n|---|---|\n| 1 | **2** |")).toBe("<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td><strong>2</strong></td></tr></tbody></table>");
    expect(md("> quoted\nline one\nline two")).toBe("<blockquote>quoted</blockquote><p>line one<br>line two</p>");
    expect(md("see [docs](https://example.com/a?b=1&c=2)")).toBe('<p>see <a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs</a></p>');
  });

  it("never lets a message inject markup or scripts", () => {
    expect(md("<img src=x onerror=alert(1)>")).toBe("<p>&lt;img src=x onerror=alert(1)&gt;</p>");
    expect(md("[click](javascript:alert(1))")).not.toContain("<a");
    expect(md('`<script>` and **<b>**')).toBe("<p><code>&lt;script&gt;</code> and <strong>&lt;b&gt;</strong></p>");
    expect(md("snake_case_names stay_as_they_are")).toBe("<p>snake_case_names stay_as_they_are</p>");
  });

  it("is embedded in the page and runs there", () => {
    // The main script is the last one (a tiny theme script runs first in <head>).
    const script = UI_PAGE.split("<script>").pop()!.split("</script>")[0]!;
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain(MARKDOWN_SOURCE);
    // Run the embedded copy the way the page does (no bundler helpers around).
    const pageMd = new Function(`return ${MARKDOWN_SOURCE};`)() as (s: string) => string;
    expect(pageMd("**ok**")).toBe("<p><strong>ok</strong></p>");
  });
});
