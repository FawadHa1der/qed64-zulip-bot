// A quote fence of ~1,000 one-character blocks fits Zulip's 10,000-char cap; extraction must stay linear in the HTML.
import test from "node:test";
import assert from "node:assert/strict";
import { extractLean } from "../src/extract.mjs";

const block = (lang, code) => `<div class="codehilite" data-code-language="${lang}"><pre><span></span><code>${code}</code></pre></div>`;

test("998 quoted blocks then one Lean block outside the quote: the outside block wins, in linear time", () => {
  const quoted = Array.from({ length: 998 }, (_, i) => block("Text only", String(i % 10))).join("\n");
  const html = `<blockquote>${quoted}</blockquote>\n` + block("Lean4", "example : 1 + 1 = 2 := rfl");
  const t0 = performance.now();
  const r = extractLean(html, "");
  const ms = performance.now() - t0;
  assert.equal(r.code, "example : 1 + 1 = 2 := rfl\n");
  assert.equal(r.quoted, false);
  assert.ok(ms < 50, `took ${ms.toFixed(1)} ms`);
});
