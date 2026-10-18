// qed64-zulip-bot: the Cloudflare Worker behind the `@**qed64**` outgoing-webhook bot on
// the Lean Zulip (docs/DESIGN.md §5). Stateless; one secret (ZULIP_BOT_TOKEN); one var
// (QED64_ORIGIN); no outbound requests.
//
// Zulip posts a public "Failure! …" line for any non-2xx answer and retries on timeouts,
// so every path except a token mismatch answers 200 with JSON, and no reply ever
// contains text taken from the message.

import { extractLean } from "./extract.mjs";
import { DEFAULT_ORIGIN, linkFor } from "./link.mjs";

export const REPLIES = Object.freeze({
  found: (url) => `[Open in QED64](${url}) · runs Lean 4 + Mathlib in Chrome or Firefox, nothing is uploaded`,
  truncated:
    "The code block in that message is cut off by Zulip's message limit, so I did not link it; paste a shorter snippet or split it.",
  noCode:
    "I need a ```lean code block in the message that mentions me, or quote the message that has the code and mention me.",
  tooLong: "That snippet is too long for a link; paste it in a shorter form.",
});

const NOT_REQUIRED = Object.freeze({ response_not_required: true });

export default {
  async fetch(request, env = {}) {
    try {
      const method = String(request.method || "GET").toUpperCase();
      if (method === "GET" || method === "HEAD") return text("ok", 200);
      if (method !== "POST") return new Response(null, { status: 405, headers: { allow: "GET, HEAD, POST" } });

      let body;
      try {
        body = await request.json();
      } catch {
        return json(NOT_REQUIRED);
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) return json(NOT_REQUIRED);
      if (!tokensMatch(body.token, env.ZULIP_BOT_TOKEN)) return text("unauthorized", 401);
      return json(respond(body, env));
    } catch {
      return json(NOT_REQUIRED);
    }
  },
};

/** The JSON reply for an authenticated payload. Never throws: any internal error becomes the no-code reply. */
export function respond(body, env = {}) {
  try {
    if (body.trigger !== "mention" && body.trigger !== "direct_message") return NOT_REQUIRED;
    const message = body.message && typeof body.message === "object" ? body.message : {};
    const fromBot =
      message.sender_is_bot === true ||
      (typeof body.bot_email === "string" && body.bot_email !== "" && message.sender_email === body.bot_email);
    if (fromBot) return NOT_REQUIRED;

    const rendered = typeof message.rendered_content === "string" ? message.rendered_content : "";
    const raw = typeof body.data === "string" ? body.data : typeof message.content === "string" ? message.content : "";
    const found = extractLean(rendered, raw);
    if (!found) return { content: REPLIES.noCode };
    if (found.truncated) return { content: REPLIES.truncated };

    const link = linkFor(found.code, typeof env.QED64_ORIGIN === "string" && env.QED64_ORIGIN ? env.QED64_ORIGIN : DEFAULT_ORIGIN);
    if (!link.url) return { content: REPLIES.tooLong };
    return { content: REPLIES.found(link.url) };
  } catch {
    return { content: REPLIES.noCode };
  }
}

/** Constant-time string comparison in plain JS (no node:crypto, so Node and Workers run the same code). False when the expected token is unset. */
export function tokensMatch(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string" || expected.length === 0) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (i < a.length ? a[i] : 0) ^ (i < b.length ? b[i] : 0);
  return diff === 0;
}

function json(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function text(body, status) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}
