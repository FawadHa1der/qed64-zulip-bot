# qed64-zulip-bot

The Cloudflare Worker behind `@**qed64**` on the Lean Zulip. A member writes `@**qed64**`
next to a Lean code block (or quotes a message that has one and mentions the bot);
Zulip POSTs the message to this Worker; the Worker answers, in the same topic, one line:

    [Open in QED64](https://qed64.fawadworkaddress.workers.dev/#codez=…) · runs Lean 4 + Mathlib in Chrome or Firefox, nothing is uploaded

The code travels in the URL fragment (`#codez=`, LZ-string Base64 as lean4web writes it,
or `#code=` when that is shorter), so it never reaches any server; the QED64 page shows
it behind a consent panel and opens it in the editor on a click. Design, measurements
and the page half: [docs/DESIGN.md](docs/DESIGN.md).

## The contract in short

- Stateless, no database, no outbound requests, no npm dependencies. One secret
  (`ZULIP_BOT_TOKEN`), one variable (`QED64_ORIGIN`, default
  `https://qed64.fawadworkaddress.workers.dev`).
- `GET /` → `200 ok`. Any method other than GET/HEAD/POST → `405`. The path is ignored.
- `POST` with Zulip's outgoing-webhook JSON (`{ bot_email, bot_full_name, data, message,
  token, trigger }`):
  - invalid JSON or a non-object body → `200 {"response_not_required": true}`;
  - `token` ≠ the secret (constant-time compare; an unset secret fails closed) → `401`;
  - `trigger` other than `mention` / `direct_message`, or a bot sender → `200
    {"response_not_required": true}`;
  - otherwise `200 {"content": "<one line of Zulip Markdown>"}`, one of four texts
    (`src/worker.mjs` `REPLIES`): the link; "cut off by Zulip's message limit"; "I need
    a ```lean code block …"; "too long for a link". No reply ever contains text from
    the message.
  - Any internal error becomes the no-code reply, never a 5xx: Zulip posts a public
    "Failure! Third party responded with <status>" for every non-2xx answer and retries
    timeouts (10 s) three times before posting "Failure! Bot is unavailable".
- Extraction (`src/extract.mjs`, `extractLean(renderedHtml, rawMarkdown)`), in Zulip's
  own HTML (`message.rendered_content`): the first `div.codehilite` whose
  `data-code-language` matches `/^lean/i` outside a `<blockquote>`; else the first such
  block inside one (quote-and-reply); else the first block of any language outside, then
  inside. Entities decoded (named and numeric), highlighting spans stripped, trailing
  newline normalised to one. If the HTML yields nothing, the raw Markdown in `data` is
  parsed (fences of 3+ backticks or tildes closing on the same character repeated at
  least as many times; `quote`/`spoiler` fences are containers; same ranking). A message
  ending in `[message truncated]`, a block whose last line is that marker, or an
  unterminated raw fence is reported as truncated instead of linked.
- Link (`src/link.mjs`, `linkFor(code, origin)`): `#codez=` =
  `compressToBase64(code)` without `=` padding (byte-identical to npm `lz-string@1.5.0`,
  vendored in `src/lz-string.mjs`, MIT); `#code=` = percent-encoded text (also escaping
  `( ) ' ! *`, which break a Markdown link) when shorter. Refused above 12,000 characters
  of code or 8,000 of URL (guards only: Zulip caps a message at 10,000 characters and
  `#codez=` stays under ~6,500 for anything that size).

Cross-check vector shared with the QED64 page (`test/link.test.mjs` `VECTOR`): the text
`"import Mathlib\n\nexample (x : ℝ) (h : 0 < x) : 0 < x ^ 2 + x := by positivity\n-- ∀ α, α = α\n"`
encodes to
`JYWwDg9gTgLgBAWQIYwBYBtgCMBQOCmAHkuOvnABSFwBccguIQCUlqtcADHADxyHN2ce1AHpwATHADUvWgF44WAJ5xIAZ2AxgANw2KcAWn1xAAERxAjcAAac3HlmcQA`.

## Tests

    npm test          # node --test, no network, no dependencies (Node 22+; developed on 26)

`test/fixtures/*.json` are outgoing-webhook payloads in Zulip's documented shape with the
markup Zulip 12 renders on leanprover.zulipchat.com: a mention with a Lean4 block, a
quote-and-reply (a four-backtick outer fence around the three-backtick inner one; the code
inside a `<blockquote>`), an untagged block rendered as Lean4 (the org default), several
blocks with a prose-language block first, no code, a bot sender, a 10,000-character
truncated quote, and a direct message. `test/worker.test.mjs` drives
`worker.fetch(new Request(...), env)` directly, so the same code runs under Node and on
Workers.

## Runbook (the owner's steps)

1. Ship the page half first: merge `qed64` `feature/zulip-link` and push (the deploy
   publishes the consent gate). Verify live: open
   `https://qed64.fawadworkaddress.workers.dev/#codez=<VECTOR.codez above>`; the panel
   appears; Open loads the snippet. Until then a bot link is silently ignored by the
   page.
2. Create the bot in Zulip: Personal settings → Bots → Add a new bot → type **Outgoing
   webhook**, full name `qed64` (the mention becomes `@**qed64**`), a username, an
   avatar if desired, **Endpoint URL** = the Worker URL from step 3 (can be filled in
   afterwards), **Interface**: Generic. Download its `zuliprc`; the `token` line is the
   webhook token (the secret below).
3. Put the Worker on Cloudflare. Pushing `main` deploys it: `.github/workflows/deploy.yml`
   runs `npm test`, then `wrangler deploy` (wrangler 4.125.0, pinned there). The
   workflow needs two repository secrets, `CLOUDFLARE_API_TOKEN` (an API token with
   *Workers Scripts: Edit* on the account) and `CLOUDFLARE_ACCOUNT_ID`; create the
   repository and set them before the first push so that the first run deploys (push
   `main` alone, never `--all` or `--mirror`):

        gh repo create FawadHa1der/qed64-zulip-bot --public --source=. --remote=origin
        gh secret set CLOUDFLARE_API_TOKEN      # prompts for the value
        gh secret set CLOUDFLARE_ACCOUNT_ID
        git push -u origin main

   Then give the Worker its one secret (the `token` line of the bot's `zuliprc`; the
   command prompts for it; `login` once before):

        npx --yes wrangler@4.125.0 login
        npx --yes wrangler@4.125.0 secret put ZULIP_BOT_TOKEN

   The Worker answers at `https://qed64-zulip-bot.<account>.workers.dev` (`GET` → `ok`);
   that URL is the bot's Endpoint URL. Secrets survive every deploy. A deploy by hand
   is the workflow's own command, `npx --yes wrangler@4.125.0 deploy`. To change the
   target page, edit `QED64_ORIGIN` in `wrangler.toml` and push.
4. Test privately: DM the bot a ```lean block; then in a quiet channel, mention it next
   to a block; then quote-and-reply a message with a block and mention it. Optional
   local replay before pushing:

        npx --yes wrangler@4.125.0 dev
        curl -s -X POST http://localhost:8787/ -H 'content-type: application/json' \
          --data @test/fixtures/mention-lean-block.json

   (`wrangler dev` reads the secret from a local `.dev.vars` with
   `ZULIP_BOT_TOKEN=test-token-0123456789abcdef0123`, the fixtures' token; do not commit
   that file. `compatibility_date` in wrangler.toml must not exceed the workerd that the
   pinned wrangler bundles, 2026-08-20 for 4.125.0; the file says 2026-08-01.)
5. Community step, one short factual post in `#Zulip meta`: what the bot does; that it
   only answers mentions (and DMs); where the code goes (nowhere: it is in the link's
   fragment, which browsers never send to a server); that checking runs in the reader's
   browser on QED64's own hosting (no load on live.lean-lang.org); and the alternative
   offer: an administrator could add a second "code playground" row for Lean pointing
   at `https://qed64.fawadworkaddress.workers.dev/#code={code}` (it goes through the same
   consent gate), with the caveat that two rows turn the playground button into a
   chooser for everyone.

Out of scope for v1 (decide on demand): a bare `@**qed64**` under someone else's
snippet without quoting carries no code; the bot asks for a quote. Fetching the previous
message would need the Zulip REST API with the bot's API key.

## Layout

    src/worker.mjs     export default { fetch }: routing, token check, reply shapes
    src/extract.mjs    extractLean(renderedHtml, rawMarkdown) (pure)
    src/link.mjs       linkFor(code, origin) (pure)
    src/lz-string.mjs  vendored lz-string 1.5.0 (MIT), Base64 and URI-safe codecs
    test/              node --test suites and the fixture payloads
    wrangler.toml      name, main, compatibility_date, [vars] QED64_ORIGIN
    docs/DESIGN.md     the design and handover document for both halves
    .github/workflows/deploy.yml   npm test on a push to main and on pull requests; then wrangler deploy
    LICENSE            MIT

Rules of this machine (docs/DESIGN.md §9): never `git push`, never `npm install`, the
owner deploys.

## License

MIT, see [LICENSE](LICENSE). `src/lz-string.mjs` is a port of lz-string 1.5.0 (MIT,
Copyright (c) 2013 pieroxy); its notice stays at the top of the file.

The research behind the design (`reports/`, `research_notes/`) is kept on the owner's
machine and is not part of this repository (listed in `.gitignore`).
