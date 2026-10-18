import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { REPLIES, respond, tokensMatch } from "../src/worker.mjs";
import { decompressFromBase64 } from "../src/lz-string.mjs";
import { DEFAULT_ORIGIN } from "../src/link.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const TOKEN = fixture("no-code").token;
const ENV = { ZULIP_BOT_TOKEN: TOKEN };
const ENDPOINT = "https://qed64-zulip-bot.example.workers.dev/";

const S1 = "import Mathlib\n\nexample (x : ℝ) (h : 0 < x) : 0 < x ^ 2 + x := by positivity\n";
const S2 =
  "theorem foo (a b : Nat) (h : a < b) : a + 1 ≤ b := by\n  omega\n\nexample (p q : Bool) : (p && q) = (q && p) := by\n  cases p <;> cases q <;> rfl -- 'decide' works too\n";
const S3 = "def plus (n m : Nat) : Nat := match n with\n| .zero => m\n| .succ n => .succ (plus n m)\n";
const S4 = "import Mathlib\n\nexample (x : ℝ) (h : 0 < x) : 0 < x ^ 2 + x := by\n  sorry\n";
const S8 = "example : 2 + 2 = 4 := by rfl\n";

const post = (body, env = ENV, path = "/") =>
  worker.fetch(
    new Request(ENDPOINT.replace(/\/$/, "") + path, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "ZulipOutgoingWebhook/12.0" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    env,
  );

const linkIn = (content) => {
  const m = /^\[Open in QED64\]\(([^)\s]+)\) /.exec(content);
  assert.ok(m, `no link at the start of ${JSON.stringify(content)}`);
  return m[1];
};
const decodeLink = (url) => {
  const m = /^#(codez|code)=(.*)$/.exec(new URL(url).hash);
  assert.ok(m, `unexpected fragment in ${url}`);
  return m[1] === "codez" ? decompressFromBase64(m[2]) : decodeURIComponent(m[2]);
};

async function expectReply(payload, code, env = ENV) {
  const res = await post(payload, env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^application\/json/);
  const body = await res.json();
  assert.ok(typeof body.content === "string", `expected a content reply, got ${JSON.stringify(body)}`);
  assert.doesNotMatch(body.content, /\n/, "replies are one line");
  assert.equal(body.content, REPLIES.found(linkIn(body.content)));
  const url = linkIn(body.content);
  assert.equal(decodeLink(url), code);
  assert.doesNotMatch(url, /[()'\s]/, "the URL is safe inside a Markdown link");
  return body.content;
}

test("GET / and HEAD / answer 200 ok (health line)", async () => {
  const res = await worker.fetch(new Request(ENDPOINT), ENV);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "ok");
  assert.equal((await worker.fetch(new Request(ENDPOINT, { method: "HEAD" }), ENV)).status, 200);
});

test("other methods answer 405 with an empty body", async () => {
  for (const method of ["PUT", "DELETE", "PATCH", "OPTIONS"]) {
    const res = await worker.fetch(new Request(ENDPOINT, { method }), ENV);
    assert.equal(res.status, 405, method);
    assert.equal(await res.text(), "");
  }
});

test("invalid JSON and non-object bodies answer 200 response_not_required (never a 4xx Zulip would post)", async () => {
  for (const body of ["not json", "", "[1,2]", "null", '"string"']) {
    const res = await post(body);
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.deepEqual(await res.json(), { response_not_required: true });
  }
});

test("token mismatch answers 401; a missing secret fails closed", async () => {
  const good = fixture("mention-lean-block");
  assert.equal((await post({ ...good, token: "wrong-token" })).status, 401);
  assert.equal((await post({ ...good, token: TOKEN + "x" })).status, 401);
  assert.equal((await post({ ...good, token: undefined })).status, 401);
  assert.equal((await post({ ...good, token: 12345 })).status, 401);
  assert.equal((await post(good, {})).status, 401);
  assert.equal((await post(good, { ZULIP_BOT_TOKEN: "" })).status, 401);
  assert.equal((await post(good)).status, 200);
});

test("tokensMatch: constant-time compare in plain JS", () => {
  assert.equal(tokensMatch("abc", "abc"), true);
  assert.equal(tokensMatch("abc", "abd"), false);
  assert.equal(tokensMatch("abc", "abcd"), false);
  assert.equal(tokensMatch("abcd", "abc"), false);
  assert.equal(tokensMatch("", ""), false);
  assert.equal(tokensMatch("x", undefined), false);
  assert.equal(tokensMatch(undefined, "x"), false);
  assert.equal(tokensMatch("ℝ", "ℝ"), true);
  assert.equal(tokensMatch("ℝ", "ℚ"), false);
});

test("bot senders and other triggers get response_not_required", async () => {
  const check = async (payload) => {
    const res = await post(payload);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { response_not_required: true });
  };
  await check(fixture("bot-sender"));
  const self = fixture("mention-lean-block");
  self.message.sender_email = self.bot_email;
  await check(self);
  await check({ ...fixture("mention-lean-block"), trigger: "reaction" });
  await check({ ...fixture("mention-lean-block"), trigger: "private_message" });
  await check({ ...fixture("mention-lean-block"), trigger: undefined });
});

test("mention with a Lean block: 200 JSON with a link whose fragment decodes back to the code", async () => {
  const content = await expectReply(fixture("mention-lean-block"), S1);
  assert.ok(content.startsWith(`[Open in QED64](${DEFAULT_ORIGIN}/#codez=`), content);
  assert.ok(!content.includes("positivity") && !content.includes("can you open"), "never echoes user text");
});

test("direct message trigger: same reply", async () => {
  await expectReply(fixture("direct-message"), S8);
});

test("quote-and-reply: the quoted block is linked", async () => {
  await expectReply(fixture("quote-and-reply"), S2);
});

test("untagged block (org default Lean4) is linked", async () => {
  await expectReply(fixture("untagged-block"), S3);
});

test("several blocks: the Lean one is linked, not the error output", async () => {
  await expectReply(fixture("several-blocks"), S4);
});

test("no code: the help line, without the user's words", async () => {
  const res = await post(fixture("no-code"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.content, REPLIES.noCode);
  assert.ok(!body.content.includes("productive"));
  assert.doesNotMatch(body.content, /\n/);
});

test("truncated quote: the truncated line", async () => {
  const res = await post(fixture("truncated-quote"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { content: REPLIES.truncated });
});

test("too long: a block past the cap gets the too-long line", async () => {
  const p = fixture("mention-lean-block");
  const code = "-- " + "x".repeat(12_600) + "\n";
  p.data = "@**qed64**\n```lean\n" + code + "```";
  p.message.content = p.data;
  p.message.rendered_content = `<p>@qed64</p>\n<div class="codehilite" data-code-language="Lean"><pre><span></span><code><span class="c1">${code}</span></code></pre></div>`;
  const res = await post(p);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { content: REPLIES.tooLong });
});

test("QED64_ORIGIN from the environment, default otherwise", async () => {
  const content = await expectReply(fixture("mention-lean-block"), S1, { ...ENV, QED64_ORIGIN: "https://example.test/" });
  assert.ok(content.startsWith("[Open in QED64](https://example.test/#"), content);
  const dflt = await expectReply(fixture("mention-lean-block"), S1, { ...ENV, QED64_ORIGIN: "" });
  assert.ok(dflt.startsWith(`[Open in QED64](${DEFAULT_ORIGIN}/#`), dflt);
});

test("malformed but authenticated payloads never produce a 5xx: they get the no-code line", async () => {
  const cases = [
    { token: TOKEN, trigger: "mention" },
    { token: TOKEN, trigger: "mention", message: 42, data: 17 },
    { token: TOKEN, trigger: "mention", message: { rendered_content: {}, sender_email: null }, data: null },
    { token: TOKEN, trigger: "direct_message", message: [], bot_email: 5 },
  ];
  for (const c of cases) {
    const res = await post(c);
    assert.equal(res.status, 200, JSON.stringify(c));
    assert.deepEqual(await res.json(), { content: REPLIES.noCode });
  }
  // respond() itself swallows throws from inside (a getter that throws stands in for any internal error)
  const hostile = { trigger: "mention", bot_email: "b", get message() { throw new Error("boom"); } };
  assert.deepEqual(respond(hostile, ENV), { content: REPLIES.noCode });
});

test("the webhook path is not significant: Zulip may be configured with a trailing path", async () => {
  const res = await post(fixture("mention-lean-block"), ENV, "/zulip");
  assert.equal(res.status, 200);
  assert.match((await res.json()).content, /^\[Open in QED64\]\(/);
});

test("the four reply texts are single lines and name no user content", () => {
  for (const text of [REPLIES.found("https://x.test/#code=y"), REPLIES.truncated, REPLIES.noCode, REPLIES.tooLong]) {
    assert.doesNotMatch(text, /\n/);
    assert.ok(text.length < 300);
  }
  assert.equal(REPLIES.found("URL"), "[Open in QED64](URL) · runs Lean 4 + Mathlib in Chrome or Firefox, nothing is uploaded");
});
