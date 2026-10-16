import { test } from "node:test";
import assert from "node:assert/strict";
import { linkFor, percentEncode, DEFAULT_ORIGIN, MAX_CODE_CHARS, MAX_URL_CHARS } from "../src/link.mjs";
import {
  compressToBase64,
  decompressFromBase64,
  compressToEncodedURIComponent,
  decompressFromEncodedURIComponent,
} from "../src/lz-string.mjs";

/**
 * Cross-check vector shared with the QED64 page (`frontend/src/lz-string.ts`, pinned by `tests/unit/lz-string.test.ts`): the same
 * text must produce exactly this `codez` there, and decode back to the text. `codez` is
 * what the npm package lz-string@1.5.0 produces (compared byte for byte), with the
 * Base64 padding stripped as lean4web does.
 */
export const VECTOR = {
  text: "import Mathlib\n\nexample (x : ℝ) (h : 0 < x) : 0 < x ^ 2 + x := by positivity\n-- ∀ α, α = α\n",
  codez: "JYWwDg9gTgLgBAWQIYwBYBtgCMBQOCmAHkuOvnABSFwBccguIQCUlqtcADHADxyHN2ce1AHpwATHADUvWgF44WAJ5xIAZ2AxgANw2KcAWn1xAAERxAjcAAac3HlmcQA",
};

const fragmentValue = (url) => {
  const hash = new URL(url).hash;
  const m = /^#(codez|code)=(.*)$/.exec(hash);
  assert.ok(m, `unexpected fragment ${hash}`);
  return { kind: m[1], value: m[2] };
};
const decodeLink = (url) => {
  const { kind, value } = fragmentValue(url);
  return kind === "codez" ? decompressFromBase64(value) : decodeURIComponent(value);
};

test("VECTOR is pinned to lean4web's writer, compressToBase64(code).replace(/=*$/, '')", () => {
  assert.equal(compressToBase64(VECTOR.text).replace(/=*$/, ""), VECTOR.codez);
  assert.equal(decompressFromBase64(VECTOR.codez), VECTOR.text);
  const padded = compressToBase64(VECTOR.text);
  assert.equal(padded.length % 4, 0);
  assert.equal(decompressFromBase64(padded), VECTOR.text);
  assert.deepEqual(linkFor(VECTOR.text), { url: `${DEFAULT_ORIGIN}/#codez=${VECTOR.codez}`, kind: "codez" });
});

test("round trips through the vendored decoder, both link kinds", () => {
  const samples = [
    VECTOR.text,
    "x",
    "example : 2 + 2 = 4 := by rfl\n",
    "theorem foo (α : Type) (s t : Set α) : s ∩ t ⊆ s ∪ t := fun x hx => Or.inl hx.1\n".repeat(40),
    "😀 surrogate pairs ∀ α 😀😀\n",
    "a\r\nb\u0000c￿\n",
    "ab".repeat(4000),
  ];
  for (const text of samples) {
    const link = linkFor(text);
    assert.ok(link.url, `link refused for ${text.slice(0, 20)}`);
    assert.equal(decodeLink(link.url), text);
    assert.equal(decompressFromBase64(compressToBase64(text)), text);
    assert.equal(decompressFromEncodedURIComponent(compressToEncodedURIComponent(text)), text);
  }
});

test("#codez= carries no padding and only Base64 characters", () => {
  for (let n = 1; n <= 12; n++) {
    const { kind, value } = fragmentValue(linkFor("example : True := trivial -- " + "x".repeat(n * 17)).url);
    if (kind !== "codez") continue;
    assert.doesNotMatch(value, /=/);
    assert.match(value, /^[A-Za-z0-9+/]+$/);
  }
  const { value } = fragmentValue(linkFor(VECTOR.text).url);
  assert.equal(value, VECTOR.codez);
});

test("#code= is chosen when it is shorter (a 20-character snippet), #codez= for a kilobyte", () => {
  const short = "example:True:=trivial";
  const link = linkFor(short);
  assert.equal(link.kind, "code");
  assert.equal(link.url, `${DEFAULT_ORIGIN}/#code=${percentEncode(short)}`);
  assert.ok(percentEncode(short).length < compressToBase64(short).replace(/=+$/, "").length);
  assert.equal(decodeLink(link.url), short);
  assert.equal(linkFor(VECTOR.text.repeat(12)).kind, "codez");
});

test("#code= escapes the characters that break a Markdown link, and decodeURIComponent still reverses it", () => {
  const text = "f (x)'!*";
  assert.equal(percentEncode(text), "f%20%28x%29%27%21%2A");
  assert.equal(decodeURIComponent(percentEncode(text)), text);
  const url = linkFor("ex (x : N) : x = x := rfl").url;
  assert.doesNotMatch(url, /[()'!*]/);
  assert.equal(decodeLink(url), "ex (x : N) : x = x := rfl");
});

test("caps: code longer than 12,000 characters, or a URL longer than 8,000, is refused", () => {
  assert.equal(MAX_CODE_CHARS, 12_000);
  assert.equal(MAX_URL_CHARS, 8_000);
  assert.deepEqual(linkFor("a".repeat(12_001)), { tooLong: true });
  assert.ok(linkFor("a".repeat(12_000)).url, "12,000 compressible characters still link");
  // incompressible text: 7,000 distinct code points, each a fresh 16-bit literal for LZ-string
  const noisy = Array.from({ length: 7000 }, (_, i) => String.fromCharCode(0x100 + i)).join("");
  assert.ok(compressToBase64(noisy).length > MAX_URL_CHARS);
  assert.ok(percentEncode(noisy).length > MAX_URL_CHARS);
  assert.deepEqual(linkFor(noisy), { tooLong: true });
});

test("origin: trailing slashes are dropped and an empty origin falls back to the default", () => {
  assert.equal(linkFor("x", "https://example.test/").url, "https://example.test/#code=x");
  assert.equal(linkFor("x", "https://example.test///").url, "https://example.test/#code=x");
  assert.equal(linkFor("x", "").url, `${DEFAULT_ORIGIN}/#code=x`);
  assert.equal(linkFor("x", undefined).url, `${DEFAULT_ORIGIN}/#code=x`);
});

test("vendored LZ-string edge cases match upstream", () => {
  assert.equal(compressToBase64(""), "Q===");
  assert.equal(compressToBase64(null), "");
  assert.equal(decompressFromBase64(""), null);
  assert.equal(decompressFromBase64(null), "");
  assert.equal(decompressFromBase64("Q==="), "");
  assert.equal(decompressFromBase64("Q"), "");
  assert.equal(decompressFromBase64("zzzz"), null, "a corrupt stream yields null, not a throw");
  assert.equal(decompressFromEncodedURIComponent(compressToEncodedURIComponent("a b+c").replace(/\+/g, " ")), "a b+c");
});

test("ill-formed UTF-16 (a lone surrogate) rides #codez= alone and decodes back", () => {
  const r = linkFor("a\ud800b");
  assert.equal(r.kind, "codez");
  const codez = r.url.slice(r.url.indexOf("#codez=") + 7);
  assert.equal(decompressFromBase64(codez), "a\ud800b");
});
