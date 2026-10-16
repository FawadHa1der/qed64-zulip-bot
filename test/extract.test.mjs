import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractLean, decodeEntities, TRUNCATED_MARKER } from "../src/extract.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const run = (p) => extractLean(p.message.rendered_content, p.data);

// The snippets the fixtures were built from (test/fixtures/*.json carry them as Zulip renders them).
const S1 = "import Mathlib\n\nexample (x : ℝ) (h : 0 < x) : 0 < x ^ 2 + x := by positivity\n";
const S2 =
  "theorem foo (a b : Nat) (h : a < b) : a + 1 ≤ b := by\n  omega\n\nexample (p q : Bool) : (p && q) = (q && p) := by\n  cases p <;> cases q <;> rfl -- 'decide' works too\n";
const S3 = "def plus (n m : Nat) : Nat := match n with\n| .zero => m\n| .succ n => .succ (plus n m)\n";
const S4 = "import Mathlib\n\nexample (x : ℝ) (h : 0 < x) : 0 < x ^ 2 + x := by\n  sorry\n";
const S8 = "example : 2 + 2 = 4 := by rfl\n";

const block = (code, lang, { quoted = false } = {}) => {
  const div = `<div class="codehilite"${lang === null ? "" : ` data-code-language="${lang}"`}><pre><span></span><code>${code}</code></pre></div>`;
  return quoted ? `<blockquote>\n<p>${div}</p>\n</blockquote>` : div;
};

test("fixture: mention with one Lean4-tagged block", () => {
  assert.deepEqual(run(fixture("mention-lean-block")), { code: S1, source: "rendered", quoted: false, language: "Lean4" });
});

test("fixture: quote-and-reply takes the block inside the blockquote and decodes entities", () => {
  const r = run(fixture("quote-and-reply"));
  assert.deepEqual(r, { code: S2, source: "rendered", quoted: true, language: "Lean" });
  assert.ok(r.code.includes("<;>") && r.code.includes("&&") && r.code.includes("'decide'"));
});

test("fixture: untagged block rendered as Lean4 (the org default)", () => {
  assert.deepEqual(run(fixture("untagged-block")), { code: S3, source: "rendered", quoted: false, language: "Lean4" });
});

test("fixture: several blocks, the first prose-language, the second Lean", () => {
  const r = run(fixture("several-blocks"));
  assert.equal(r.code, S4);
  assert.equal(r.language, "Lean");
  assert.ok(!r.code.includes("unsolved goals"));
});

test("fixture: no code at all", () => {
  assert.equal(run(fixture("no-code")), null);
});

test("fixture: a bot sender still extracts (the Worker, not the extractor, ignores bots)", () => {
  assert.equal(run(fixture("bot-sender")).code, S8);
});

test("fixture: truncated quote is reported, not linked", () => {
  assert.deepEqual(run(fixture("truncated-quote")), { truncated: true });
});

test("fixture: direct message", () => {
  assert.deepEqual(run(fixture("direct-message")), { code: S8, source: "rendered", quoted: false, language: "Lean" });
});

test("blockquote preference: a Lean block outside a quote beats one inside, whatever the order", () => {
  const html = `${block("quoted\n", "Lean4", { quoted: true })}\n<p>mine</p>\n${block("outside\n", "Lean4")}`;
  assert.equal(extractLean(html, "").code, "outside\n");
  assert.equal(extractLean(html, "").quoted, false);
  const onlyQuoted = `<p>@qed64</p>${block("quoted\n", "Lean4", { quoted: true })}`;
  assert.deepEqual(extractLean(onlyQuoted, ""), { code: "quoted\n", source: "rendered", quoted: true, language: "Lean4" });
});

test("a Lean block inside a quote beats a non-Lean block outside; non-Lean blocks are a last resort", () => {
  const html = `${block("print(1)\n", "Python")}${block("lean\n", "Lean", { quoted: true })}`;
  assert.equal(extractLean(html, "").code, "lean\n");
  const onlyOther = `${block("print(1)\n", "Python")}${block("echo\n", "Bash", { quoted: true })}`;
  assert.deepEqual(extractLean(onlyOther, ""), { code: "print(1)\n", source: "rendered", quoted: false, language: "Python" });
  const onlyOtherQuoted = block("echo\n", "Bash", { quoted: true });
  assert.equal(extractLean(onlyOtherQuoted, "").quoted, true);
});

test("language match is case-insensitive and prefix-based; a missing attribute counts as non-Lean", () => {
  assert.equal(extractLean(`${block("a\n", "Text only")}${block("b\n", "LEAN4")}`, "").code, "b\n");
  assert.equal(extractLean(`${block("a\n", "Text only")}${block("b\n", "lean")}`, "").code, "b\n");
  assert.equal(extractLean(`${block("a\n", null)}${block("b\n", "Lean")}`, "").code, "b\n");
  assert.deepEqual(extractLean(block("a\n", null), ""), { code: "a\n", source: "rendered", quoted: false, language: "" });
});

test("pygments spans are stripped and entities decoded, including numeric ones", () => {
  const html = block(
    '<span class="kn">example</span><span class="w"> </span><span class="o">:</span> <span class="bp">&lt;</span>&gt;&amp;&quot;&#39; &#x3b1; &#8704; &#x1F600;\n',
    "Lean4",
  );
  const r = extractLean(html, "");
  assert.equal(r.code, "example : <>&\"' α ∀ 😀\n");
  assert.ok(!r.code.includes("<span"));
});

test("decodeEntities handles the named set, decimal, hex, and leaves unknown references alone", () => {
  assert.equal(decodeEntities("&lt;&gt;&amp;&quot;&#39;&apos;&nbsp;&#x3b1;&#8704;&bogus;&amp;lt;"), "<>&\"'' α∀&bogus;&lt;");
  assert.equal(decodeEntities("&#xD800;&#1114112;"), "��");
});

test("whitespace-only blocks are skipped", () => {
  assert.equal(extractLean(block("\n  \n", "Lean4"), ""), null);
  assert.equal(extractLean(`${block("\n", "Lean4")}${block("x\n", "Lean4")}`, "").code, "x\n");
});

test("trailing newlines collapse to exactly one; CRLF becomes LF", () => {
  assert.equal(extractLean(block("a\r\nb\n\n\n", "Lean4"), "").code, "a\nb\n");
  assert.equal(extractLean(block("a", "Lean4"), "").code, "a\n");
});

test("raw-Markdown fallback: lean / lean4 / untagged fences, backticks or tildes", () => {
  assert.deepEqual(extractLean("", "hi\n```lean\nfoo\n```\n"), { code: "foo\n", source: "raw", quoted: false, language: "lean" });
  assert.equal(extractLean("", "```lean4\nfoo\n```").code, "foo\n");
  assert.equal(extractLean("", "```\nfoo\n```").language, "");
  assert.equal(extractLean("", "~~~lean\nfoo\n~~~").code, "foo\n");
  assert.equal(extractLean("", "```Lean4\nfoo\n```").language, "lean4");
  assert.equal(extractLean("", "```{.lean}\nfoo\n```").language, "lean");
});

test("raw-Markdown fallback: nested fences honour fence lengths (quote-and-reply shape)", () => {
  const raw = "@_**M|1** [said](x):\n````quote\nprose\n```lean\ninner\n```\n````\n@**qed64**";
  assert.deepEqual(extractLean("", raw), { code: "inner\n", source: "raw", quoted: true, language: "lean" });
  // a shorter run inside a longer fence is content, not a close
  assert.equal(extractLean("", "````lean\n```\nnot a close\n```\n````").code, "```\nnot a close\n```\n");
  // the closing fence may be longer than the opening one
  assert.equal(extractLean("", "```lean\nx\n`````").code, "x\n");
  // a different fence character does not close
  assert.equal(extractLean("", "```lean\n~~~\n```").code, "~~~\n");
});

test("raw-Markdown fallback: ranking and non-code fences", () => {
  assert.equal(extractLean("", "````quote\n```lean\nq\n```\n````\n```lean\no\n```").code, "o\n");
  assert.equal(extractLean("", "```python\np\n```\n```\nu\n```").code, "u\n");
  assert.deepEqual(extractLean("", "```python\np\n```"), { code: "p\n", source: "raw", quoted: false, language: "python" });
  assert.equal(extractLean("", "```math\n\\sum\n```"), null);
  assert.equal(extractLean("", "```spoiler title\n```lean\ns\n```\n```").quoted, true);
});

test("raw-Markdown fallback: an unterminated block is truncated", () => {
  assert.deepEqual(extractLean("", "```lean\nfoo\n"), { truncated: true });
  assert.deepEqual(extractLean("", "````quote\n```lean\nfoo\n"), { truncated: true });
});

test("the rendered HTML wins; the raw text is used only when it yields nothing", () => {
  const html = block("rendered\n", "Lean4");
  assert.equal(extractLean(html, "```lean\nraw\n```").code, "rendered\n");
  assert.equal(extractLean("<p>no block here</p>", "```lean\nraw\n```").source, "raw");
});

test("Zulip's truncation marker means truncated, in the raw text or as the block's last line", () => {
  const html = block("a\n", "Lean4");
  assert.deepEqual(extractLean(html, `\`\`\`lean\na\n\`\`\`\n${TRUNCATED_MARKER}`), { truncated: true });
  assert.deepEqual(extractLean(html, `x\n${TRUNCATED_MARKER}\n  `), { truncated: true });
  assert.deepEqual(extractLean(block(`a\n${TRUNCATED_MARKER}\n`, "Lean4"), ""), { truncated: true });
  assert.deepEqual(extractLean(`${html}<p>${TRUNCATED_MARKER}</p>`, ""), { truncated: true });
  // no code at all stays "no code" even when the message is truncated
  assert.equal(extractLean(`<p>prose</p><p>${TRUNCATED_MARKER}</p>`, `prose\n${TRUNCATED_MARKER}`), null);
});

test("non-string inputs yield null, never a throw", () => {
  assert.equal(extractLean(undefined, undefined), null);
  assert.equal(extractLean(42, {}), null);
  assert.equal(extractLean(null, ""), null);
});

test("markup drift tolerated: extra classes and attributes on the div, no <code> element", () => {
  const html = '<div data-x="1" class="codehilite extra" data-code-language="Lean4"><pre>a &lt; b\n</pre></div>';
  assert.equal(extractLean(html, "").code, "a < b\n");
});
