# "Open in QED64" from the Lean Zulip: design and handover

Status: design accepted by the owner on 2026-10-16; implemented and verified the same day on
two branches (below), awaiting the owner's merge, bot creation and deploy (§7). This file is the single place a new session or model needs in
order to continue: what is being built, why it is shaped this way, the facts that were
measured, the invariants that must hold, how to test, how to deploy, and what is still
the owner's decision. The research behind it (`reports/Zulip bot and partial Mathlib loading.md`, six
source notes in `research_notes/`) stays on the owner's machine, gitignored since
2026-10-17; this file repeats only what the implementation depends on.

## 1. What is being built, in one paragraph

A Lean Zulip user writes `@**qed64**` next to a Lean snippet (in the same message, or
after quoting someone else's message). Zulip POSTs the message to a Cloudflare Worker
(an *outgoing-webhook bot*, no server of ours), which pulls the first Lean code block
out of the message, encodes it into a URL fragment, and replies in the same topic with
one line: `[Open in QED64](https://qed64.fawadworkaddress.workers.dev/#codez=…)`.
Anyone who clicks sees a small consent panel showing the code and opens it in the
QED64 editor with a click; Lean then checks it in their browser. Nothing is uploaded
anywhere: the code travels in the fragment, which never reaches a server.

Decisions already taken by the owner (do not reopen):
- The link targets the normal QED64 page with the existing Mathlib umbrella snapshot.
  "Load only the snippet's modules" was researched and **rejected** (not viable
  enough for its complexity; memory `zulip-bot-decision.md`).
- Simplicity and durability over features: no database, no always-on process, no new
  npm dependency, no change to what a visitor without a share link sees or does.
- The owner pushes and deploys; sessions commit locally only.

## 2. The two halves and where they live

| Half | Repository / branch | Worktree | Deploy |
|---|---|---|---|
| QED64 page: `#codez=` decoding + a consent gate for top-level share links | `qed64`, branch `feature/zulip-link` (cut from main `52e3885`; rebased onto main `58ebbad` on 2026-10-17: two commits, the gate and its review follow-ups) | `/Users/fawadhaider/code/wasm64-lean-fable/qed64-wt-zulip` (node_modules symlinked to `../qed64/node_modules`, `frontend/node_modules` likewise) | merged to main by the owner; the push deploys (GitHub Actions → Cloudflare) |
| The bot: a Cloudflare Worker answering Zulip's outgoing webhook | `qed64-zulip`, branch `main` (GitHub `FawadHa1der/qed64-zulip-bot`, public, MIT; the research notes stay local, gitignored) | `/Users/fawadhaider/code/wasm64-lean-fable/qed64-zulip` | pushed by the owner; GitHub Actions runs `npm test` and `wrangler deploy` on every push to main (repository secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`); the Zulip bot and its token are the owner's |

The page half is a prerequisite: today a top-level `#code=` link is **silently
ignored** by the deployed page (see §4.1), so a bot link would do nothing until the
page change ships.

## 3. Facts the implementation depends on (measured or read from source, 2026-10-16)

### 3.1 Zulip (leanprover.zulipchat.com, Zulip 12.0-dev, feature level 511)
- Bot creation: `can_create_bots_group = role:members` (read from the public
  `/json/register`); any non-guest member can create an outgoing-webhook bot. The owner
  confirmed their settings offer "Add a bot".
- Trigger: Zulip POSTs to the bot's endpoint when a **human** writes `@**botname**`
  in a channel (`trigger: "mention"`) or sends it a direct message
  (`trigger: "direct_message"`). The bot need not be subscribed to the channel.
  Silent mentions (`@_**name**`), mentions inside quote blocks, and messages sent by
  bots never trigger (server-side `if sender.is_bot: return`).
- Payload (JSON): `{ bot_email, bot_full_name, data, message, token, trigger }`.
  `data` and `message.content` are the **raw Zulip Markdown** with the mention left
  in; `message.rendered_content` is Zulip's HTML; `message` also carries `id`,
  `sender_email`, `sender_full_name`, `sender_id`, `stream_id`, `display_recipient`
  (channel name, or the DM recipients), `subject` (topic), `type`.
- Reply: respond HTTP 200 with JSON `{"content": "<Zulip Markdown>"}` and Zulip posts
  it as the bot in the same channel+topic (or DM). `{"response_not_required": true}`
  posts nothing. **Any non-2xx status makes Zulip post a public "Failure! Third party
  responded with <status>" line**; a timeout (10 s, `OUTGOING_WEBHOOK_TIMEOUT_SECONDS`)
  is retried up to 3 times then posts "Failure! Bot is unavailable" and DMs the owner.
  So: always answer 200 with valid JSON for anything that is not a token mismatch.
- Authentication: the per-bot `token` in the payload (also in the bot's downloaded
  `zuliprc`); compare it with the Worker's secret, constant-time; 401 on mismatch.
- Code blocks in rendered HTML: `<div class="codehilite" data-code-language="Lean4">
  <pre><span></span><code>…pygments spans…</code></pre></div>`. The org's default
  code-block language is `lean4`, so even untagged ``` blocks arrive tagged `Lean4`.
  Language tags seen: `Lean4`, `Lean`.
- "Quote message" (quote-and-reply) pre-fills `@_**Author|id** [said](permalink):`
  followed by a ```` ```quote ```` fence that wraps the original raw Markdown, with the
  outer fence lengthened to exceed any fence inside (so nested fences are normal); in
  the HTML the quoted part is a `<blockquote>`. The quoted code block is therefore
  present in the mention's own payload: no REST call is needed for this flow.
- A bare `@**qed64**` under someone else's snippet (no quote) carries no code; fetching
  the previous message needs the Zulip REST API with the bot's API key
  (`GET /messages?anchor=<id>&num_before=N&num_after=0&apply_markdown=false&narrow=[…]`).
  **Out of scope for v1** (planned v1.1, only if logs show demand).
- Message length cap 10,000 characters; a long quote-and-reply can be truncated to
  "[message truncated]" (the code inside is then cut: detect an unterminated block and
  say so rather than linking a partial file).
- Zulip already has a native "code playground" button on every Lean block, pointing at
  `https://live.lean-lang.org/#code={code}` (playground ids 1455/1457, set up in 2022).
  Only an organization administrator can add a QED64 row; two rows turn the button
  into a chooser for everyone. Offering that row is a community conversation (§8),
  not part of the code.

### 3.2 Link format (lean4web compatibility)
- lean4web reads `#code=<percent-encoded text>`, `#codez=<LZ-string>`, `#url=`,
  `project=`. Its writer: `LZString.compressToBase64(code).replace(/=*$/, '')`,
  reader: `LZString.decompressFromBase64(codez)`. (Not the URI-safe variant.)
- Measured on 18 real Zulip snippets: `encodeURIComponent` inflates Lean 1.3–2.3×
  (median 1.86×; Unicode-dense text is worst); LZ-string yields 0.54–0.65× above
  ~1 KB and is worse than plain below ~150 characters. The largest sampled snippet
  (9,741 chars) is an 18,544-char `#code=` URL (unpostable) and a 5,321-char `#codez=`
  URL. Since Zulip caps the source at 10,000 chars, a `#codez=` link always fits a
  Zulip message; choose `#code=` only when it is shorter.
- Fragments are never sent to the server (RFC 3986 §3.5): privacy and no storage.
- Browser URL caps are not the constraint (Chromium 2 MiB, Firefox 1 MiB); Zulip's
  10,000-char message is.

### 3.3 The Zulip snippet population (365 blocks sampled from 6 streams, mostly 2026)
- 74% have no `import` line; 14% say `import Mathlib`; 10% name specific modules.
- Median 257 chars / 8 lines; p90 1,549 chars; max 9,805 chars. 16% contain `sorry`.
- 27% of import-less snippets use Mathlib notation or tactics (`ℝ`, `linarith`,
  `norm_num`, `ring`); 47% are ≤5-line fragments not meant to compile alone.
- Consequence: the bot must not "fix" snippets (no import injection in v1); QED64's
  page already resolves Mathlib headers against the umbrella; a snippet without
  imports boots the light (Init) session, which is correct for 74% and a one-click
  "Load Mathlib" away for the rest (existing UI).

### 3.4 QED64 as measured on 2026-10-16 (main `52e3885`, live at https://qed64.fawadworkaddress.workers.dev/)
- `frontend/src/page-api.ts` `codeFromHash(hash)`: parses only `#code=` (≤ 2 MiB after
  percent-decoding); `#codez=` returns null (pinned by `tests/unit/page-api.test.ts:205`).
- `frontend/src/main.ts` ~L40-46 and ~L440-452: a boot document from the fragment is
  honoured **only when the page is framed by a same-origin parent**
  (`FRAMED_SAME_ORIGIN`); a top-level link only logs `[qed64] #code= ignored: …`.
  Reason (documented there and in docs/EMBEDDING.md §3.1): a Lean file can define a
  `@[widget_module]` whose JavaScript runs in the same-origin InfoView iframe with no
  click, so URL-borne code must not run merely because a link was followed.
- Boot document precedence (EMBEDDING §3.1): an embedder's `setDocument` before boot
  → the fragment (framed only; read once, dropped with `history.replaceState` keeping
  the query) → in embed mode a `setDocument` within 5 s, else empty → on the plain
  page the stored buffer `localStorage["qed64.buffer"]`, else the default example.
- Persistence: on the plain page every edit is saved to `localStorage["qed64.buffer"]`
  after 400 ms (`main.ts` ~L593-601); embed mode never reads or writes it.
- The page API (`globalThis.qed64.api`) has `setDocument(text)` (queues until the
  editor is ready), `settled()`, `whenReady`, `on("diagnostics")`, `getCursor/
  setCursor`, `focus`, `restart`. `setDocument` before ready is already supported.
- UI ids (frontend/index.html): `boot`, `bootcard`, `bootlabel`, `bootreload`,
  `editor`, `infoview`, `pill`, `ptext`, `buildinfo`, `examples`, `split`, `bar`.
- Tests: `npm test` (vitest unit, 1040+), `npm run typecheck:site`, `npm run
  build:site`; browser lanes under the host lock (docs/TESTING.md), the e2e corpus
  `tests/adversarial/e2e.mjs` (23 scenarios via `record(name, category, outcome, …)`,
  `freshPage()`), Firefox via `--browser firefox`.

## 4. The page contract (QED64, `feature/zulip-link`)

### 4.1 Behaviour
1. `codeFromHash` accepts `#codez=<LZ-string base64 without padding>` in addition to
   `#code=`. Decoding uses a vendored LZ-string (`frontend/src/lz-string.ts`, MIT, the
   `decompressFromBase64` path plus `compressToBase64` for tests and future use; no
   npm dependency). Padding is tolerated; a string that does not decode, or decodes to
   more than 2 MiB, yields null, as `#code=` does today. If the URI-safe alphabet is
   detected (`-` or `$` present), try `decompressFromEncodedURIComponent` as well.
   `#code=` keeps precedence when both are present.
2. Framed same-origin pages: unchanged, except that `#codez=` now works there too.
3. **Top-level page with a `#code=`/`#codez=` fragment: the consent gate.**
   - The page boots exactly as it would without the fragment (stored buffer or the
     default example; same snapshots; same timing). The fragment is NOT the boot
     document.
   - A compact panel appears at once (before the boot finishes) and stays until acted
     on: title "This link carries Lean code", the size (lines, characters), a read-only
     view of the decoded text (first ~12 lines, "show all" expands), a note "Opening it
     runs Lean on it in your browser, as any text you type would", a stronger notice
     when the text matches the risky patterns below, and two buttons: **Open in
     editor** and **Dismiss**.
   - Risky patterns (pure function `sharedLinkFlags(text)` so it is unit-testable):
     `widget_module`, `#html`, `#widget`, `#eval`, `IO.`, `run_cmd`, `run_elab`,
     `initialize`, `javascript`. The notice says the snippet contains code that runs
     when checked (evaluation or widgets) and to open it only if the sender is trusted.
     This is a label, not a blocker.
   - **Open**: `api.setDocument(text)` (works before ready: it queues), the panel
     closes, the fragment is dropped (`history.replaceState`, query kept), and
     **persistence is switched off for this page load**: edits to the shared snippet
     are not written to `localStorage["qed64.buffer"]`, so the visitor's own saved
     buffer survives. The pill/progress says so once ("shared snippet opened; your
     saved buffer is untouched"). A later full reload without the fragment returns to
     their buffer.
   - **Dismiss**: closes the panel and drops the fragment; nothing else changes.
   - Reload with the fragment still present (neither button clicked): the gate shows
     again; this is intended (the link stays shareable until acted on).
   - A boot that fails removes the panel; the fragment stays, so the failure card's
     Reload offers the link again (added 2026-10-17).
4. No new query parameter, no new page-API method or event in v1 (`API_REVISION`
   and `EMBED_API_REVISION` unchanged); `codeFromHash` is page-tier code.

### 4.2 Invariants (these protect the deployed UX; tests pin them)
- A visit **without** a `#code=`/`#codez=` fragment renders and behaves byte-for-byte
  as today: no panel, same boot document rules, same persistence. (The e2e boot
  scenario asserts the panel element is absent.)
- A framed same-origin `#code=` boot is unchanged (existing tests).
- Opening a shared snippet never overwrites the visitor's saved buffer, and never
  elaborates the snippet before the click.
- The gate's own JavaScript must not interpret the snippet (no eval, no innerHTML of
  user text: use `textContent`).
- Size cap 2 MiB (existing); the gate shows the size before opening.

### 4.3 Files
- `frontend/src/page-api.ts`: `codeFromHash` (+ `codez`), export `sharedLinkFlags`.
- `frontend/src/lz-string.ts` (not `lib/`: `lib/` is the shipped `qed64/embed` closure, pinned by
  tests/unit/package-contract.test.ts and lib-root.test.ts; the port is page-tier code beside its
  one caller): vendored LZ-string (compress/decompress base64 and the URI-safe variant), with the MIT notice; a unit test round-trips and pins lean4web's exact
  writer (`compressToBase64(...).replace(/=*$/, '')`).
- `frontend/src/main.ts`: the gate (a small function building the panel with DOM
  APIs, inserted into `#bar`'s parent or `document.body` with a fixed position and a
  high z-index so it is visible over the boot card and after it), the `persist` flag
  on the localStorage write, the read-once drop on Open/Dismiss. Keep it under ~80
  lines; styles inline in `frontend/index.html`'s stylesheet (a few rules under a
  `#sharedlink` id).
- Tests: `tests/unit/page-api.test.ts` (codez: round trip, padding, URI-safe, invalid,
  cap; flags), `tests/unit/lz-string.test.ts`; e2e scenario `shared-link-gate` in
  `tests/adversarial/e2e.mjs` (a fresh page at `url#codez=<Init-only snippet>`:
  panel present while booting and at ready, editor text is NOT the snippet, click
  Open → editor text equals the snippet, fragment gone, `localStorage["qed64.buffer"]`
  unchanged after a small edit, no console errors), and the existing `boot` scenario
  asserts no panel without a fragment. Update the e2e count in docs/TESTING.md if
  it states one.
- Docs: `docs/EMBEDDING.md` §3.1 (the top-level gate; `#codez=`), §4 table row
  `#codez=`, §12 changelog bullet; `docs/HARDENING.md` new entry "A share link on the
  plain page opens behind a consent gate" (#77; #76 went to the memory-at-ready fix
  that landed on main first) (the threat, the measured link sizes, what
  was tested); `README.md` line 68 (`#code=` note) updated.

## 5. The Worker contract (`qed64-zulip`, `main`)

### 5.1 Layout (no npm dependencies; the tests need Node 22+; wrangler is fetched pinned,
`npx --yes wrangler@4.125.0`, by the workflow and by hand)
```
qed64-zulip/
  src/worker.mjs      export default { fetch }: routing, token check, reply shapes
  src/extract.mjs     extractLean(renderedHtml, rawMarkdown) → { code, source } | null   (pure)
  src/link.mjs        linkFor(code, origin) → { url, kind: "codez"|"code" } | { tooLong }  (pure)
  src/lz-string.mjs   vendored LZ-string (MIT): compressToBase64 / decompressFromBase64
  test/*.test.mjs     node --test: fixtures for every payload shape (below)
  test/fixtures/      JSON payloads (Zulip's documented example; quote-and-reply; untagged
                      block; several blocks; no code; a bot sender; truncated quote; a DM)
  wrangler.toml       name qed64-zulip-bot, main src/worker.mjs, compatibility_date,
                      [vars] QED64_ORIGIN = "https://qed64.fawadworkaddress.workers.dev"
  package.json        {"type":"module","scripts":{"test":"node --test"}}  (no deps)
  README.md           the runbook (§7) and the contract in short
  docs/DESIGN.md      this file
```

### 5.2 Behaviour
- `GET /` → 200 `ok` (a health line). Anything but `POST /` → 405 with an empty body
  is acceptable since Zulip only POSTs; the webhook path is `/`.
- `POST /`: parse JSON (invalid → 200 `{"response_not_required": true}`; never 4xx
  except the token). Compare `token` with `env.ZULIP_BOT_TOKEN` in constant time →
  401 on mismatch. If `trigger` is neither `mention` nor `direct_message`, or the
  sender is a bot (`message.sender_is_bot`, or `sender_email === bot_email`), →
  `{"response_not_required": true}`.
- Extraction order (`extractLean`): (1) in `message.rendered_content`, the first
  `div.codehilite` whose `data-code-language` matches `/^lean/i` and that is **not**
  inside a `<blockquote>`; (2) else the first such block inside a blockquote (the
  quote-and-reply flow); (3) else the first `codehilite` block of any language outside
  a blockquote, then inside; (4) if there is no `rendered_content`, parse the raw
  Markdown in `data`: fences of 3+ backticks or tildes, language `lean`/`lean4`/none,
  honouring fence lengths (a fence closes only on the same character repeated at least
  as many times), quote fences included. Code text = the block's text content with
  HTML entities decoded (`&lt; &gt; &amp; &quot; &#39;` and numeric), pygments spans
  stripped, a trailing newline normalised. If the block is unterminated or the message
  ends with "[message truncated]", treat as truncated.
- Link (`linkFor`): `codez = compressToBase64(code).replace(/=+$/, "")`,
  `plain = encodeURIComponent(code)`; use `#codez=` unless `#code=` is shorter;
  `url = ${origin}/#${kind}=${value}`. Refuse when `code.length > 12_000` or the URL
  exceeds 8,000 characters (both impossible for a Zulip-sized block; the cap is a
  guard).
- Replies (`content`, one line, Markdown, **never echoing user text**):
  - found: `[Open in QED64](URL) · runs Lean 4 + Mathlib in your browser, nothing is
    uploaded` (the text after the link may be shortened; keep the link first).
  - truncated: `The code block in that message is cut off by Zulip's message limit, so I
    did not link it; paste a shorter snippet or split it.`
  - no code: `` I need a ```lean code block in the message that mentions me, or quote
    the message that has the code and mention me. ``
  - too long: `That snippet is too long for a link; paste it in a shorter form.`
- Durability: stateless; one secret; no fetches to third parties; a reply is computed
  in well under the 10 ms CPU budget (LZ-string on 10 KB measured at ~4 ms for 18
  samples). Errors inside the handler are caught and answered as the no-code reply
  (never a 5xx).

### 5.3 Tests (node --test; no network)
- `extract.test.mjs`: each fixture → expected code (or null/truncated); nested fences;
  entity decoding; blockquote preference; language case-insensitivity; the pygments
  span stripping; the raw-Markdown fallback.
- `link.test.mjs`: round trips through the vendored decoder; `#codez=` padding
  stripped; `#code=` chosen when shorter (a 20-char snippet); the caps.
- `worker.test.mjs`: the handler via `worker.fetch(new Request(...), env)`: token
  mismatch → 401; bot sender → response_not_required; mention with code → 200 JSON
  with a link whose fragment decodes back to the code; DM trigger → same; GET → ok.
- A cross-check fixture: the same `codez` value decodes with QED64's vendored
  `frontend/src/lz-string.ts` (copy the test vector from the page's unit test into both repos so
  the two implementations are pinned to the same bytes).

## 6. Verification the owner's session performs before asking for a merge
1. Page: `npx tsc --noEmit`, `npm test`, `npm run typecheck:site`, `npm run
   build:site` in `qed64-wt-zulip`; then, under the host lock, a served build of the
   worktree (hard-link `../qed64/public` artifacts into its `public/`, a launch config
   `qed64-zulip-53xx` pointing at `qed64-wt-zulip/scripts/serve-dist.mjs`) and: the
   e2e suite (`node tests/adversarial/run.mjs --skip-compiler --skip-pretest --url …`,
   expect 24/24 incl. `shared-link-gate`), the same with `--browser firefox`, and a
   manual Playwright check of a real `#codez=` link produced by the Worker's `linkFor`.
2. Bot: `npm test` in `qed64-zulip` (node --test); `npx --yes wrangler@4.125.0 dev`
   with a replayed fixture via `curl` (optional).
3. No change in the default path: the e2e `boot` scenario's "no panel" assertion and
   a byte comparison of the built `dist/` CSS/JS for a page without a fragment are not
   required (the DOM is built only when a fragment is present); the e2e suite is the
   regression guard.

## 7. Runbook (the owner's steps)
1. Merge `feature/zulip-link` into `qed64` main and push (the deploy ships the gate).
   Verify live: open `https://qed64.fawadworkaddress.workers.dev/#codez=<value from
   the unit test vector>`; the panel appears; Open loads the snippet.
2. Create the bot in Zulip: Personal settings → Bots → Add a new bot → type **Outgoing
   webhook**, full name `qed64` (the mention becomes `@**qed64**`), a username, an
   avatar if desired, **Endpoint URL** = the Worker URL (after step 3), **Interface**:
   Generic. Download its `zuliprc`; the `token` line is the webhook token.
3. Put the Worker on Cloudflare. First publication, once, on the original machine: the
   rebuilt research-free history is the branch `publish`; the old local `main` and
   `feature/bot-v1` still carry the research notes and must never be pushed. From
   `qed64-zulip`:

        git branch -m main archive/main-with-research
        git branch -m feature/bot-v1 archive/bot-v1-with-research
        git branch -m publish main
        git ls-tree -r --name-only main | grep -E '^(reports|research_notes)/'   # must print nothing
        gh repo create FawadHa1der/qed64-zulip-bot --public --source=. --remote=origin
        gh secret set CLOUDFLARE_API_TOKEN      # Workers Scripts: Edit
        gh secret set CLOUDFLARE_ACCOUNT_ID
        git push -u origin main

   `.github/workflows/deploy.yml` then runs `npm test` and `wrangler deploy` (wrangler
   4.125.0, pinned). Then, once, from
   `qed64-zulip`: `npx --yes wrangler@4.125.0 login` and `npx --yes wrangler@4.125.0
   secret put ZULIP_BOT_TOKEN` (paste the token). The Worker URL is
   `https://qed64-zulip-bot.<account>.workers.dev`; put it in the bot's Endpoint URL
   (step 2) if it was not known yet.
4. Test privately: DM the bot a ```lean block; then in a quiet channel, mention it
   next to a block; then quote-and-reply a message with a block and mention it.
5. Community step (one post in `#Zulip meta`, factual, short): what the bot does, that
   it only answers mentions, where the code goes (nowhere: the fragment), that
   checking runs in the reader's browser on QED64's own hosting (no load on
   live.lean-lang.org), and the alternative offer: an administrator could add a
   second "code playground" row for Lean pointing at
   `https://qed64.fawadworkaddress.workers.dev/#code={code}` (works through the same
   gate), with the caveat that two rows turn the button into a chooser.

## 8. Open questions for the owner (defaults in bold)
- Bot display name: **`qed64`** (the mention is `@**qed64**`; "QED64" also possible).
- Answer direct messages too: **yes** (same reply; cheap and useful for private tests).
- Reply tail text: **"runs Lean 4 + Mathlib in your browser, nothing is uploaded"**.
- Offer the playground row to the admins in the same post: **yes**.
- v1.1 (fetch the previous message for a bare mention): **not now**; decide on logs.

## 9. Rules of this machine (apply to every session touching this work)
- Never `git push`; never `npm install`/`ci`/`update`; never write under any
  `node_modules`; kill processes by PID only; one heavy browser/wasm process at a time
  through the host lock `"/Users/fawadhaider/code/lean questions/infoview-widget-
  research/widgets-v4.34/qed64-showcase/scripts/with-browser-lock.sh" <lane> <cmd>`.
- Handover notes live in gitignored `work/` dirs (QED64: `qed64/work/worktree-archive/
  qed64-wt-modular/work/HANDOVER-2026-10-05.md`), never committed; memory index:
  `~/.claude/projects/-Users-fawadhaider-code-wasm64-lean-fable/memory/MEMORY.md`
  (`zulip-bot-decision.md`, `zulip-link-handover.md`).
- `qed64-zulip`: the research notes are gitignored; the pre-2026-10-17 history that
  contained them stays on this machine (local `main` and `feature/bot-v1`, renamed
  `archive/*` by the first-publication step in §7.3); push `main` alone, never
  `--all` or `--mirror`.
- Commits end with `Co-Authored-By: Claude <model> <noreply@anthropic.com>` as the
  session's attribution line says.
- The owner's standard: the simplest maintainable architecture; docs state what was
  measured and mark inference.

## 10. Status checklist (update as work lands)
- [x] Research and decision (2026-10-16).
- [x] Branches: `qed64` `feature/zulip-link`, `qed64-zulip` `feature/bot-v1` (folded into `main` on 2026-10-17); this doc.
- [x] Page: `#codez=` + vendored LZ-string + unit tests (2026-10-16; byte-identical to lz-string 1.5.0 on 1,512 texts).
- [x] Page: consent gate + persistence flag + e2e scenario + docs (e2e run pending, §6).
- [x] Worker: extract/link/worker + fixtures + tests + README (51 node tests).
- [x] Cross-check vector pinned in both repos (identical `codez`; the ports agree on 1,512 texts and on corrupt input: null).
- [x] Verification (§6), 2026-10-16: unit 1054 green, tsc, typecheck:site, build:site; e2e on a served build of the branch 24/24 in Chromium and 24/24 in Firefox (`shared-link-gate` passing in both: gate while booting, not opened before the click, opened on click, fragment cleared, buffer untouched, 0 console errors); a link built by the Worker's own `linkFor` opened in the page, checked a Mathlib snippet to ready, left the visitor's saved buffer intact, and no gate appeared without a fragment. Page commit: `feature/zulip-link` (one commit over main 52e3885); bot commit "bot v1: a stateless Cloudflare Worker …", now on `main` (its hash changed when the history was rebuilt without the research notes on 2026-10-17).
- [x] Rebase (2026-10-17): main gained `58ebbad` (another session's memory-at-ready fix, which took HARDENING #76), so the owner's fast-forward failed. `feature/zulip-link` was rebased onto it (the gate commit is now `ab82eb9`, its HARDENING entry #77; a range-diff shows only the renumbering) and gained `00bb310` from a read-only review of the merged tree: a failed boot removes the gate, "restored your last buffer" is not shown after Open replaced it, the embed-mode warning names `#codez=`, and doc fixes. Re-verified on a served build of `00bb310`: unit 1054, tsc, typecheck:site, build:site; e2e 24/24 in Chromium and 24/24 in Firefox; page-api 7/7 (incl. the memory fix's scenario); a Worker-built link opens, checks and leaves the saved buffer intact; a failed boot (profile index aborted 3 s in) shows the gate first and none after, keeping the failure reason, Reload and the fragment, in both engines.
- [x] Repository prepared for GitHub (2026-10-17): history rebuilt without the research notes (now gitignored), MIT `LICENSE`, `.github/workflows/deploy.yml` (`npm test` on a push to main and on pull requests, then `wrangler deploy`).
- [ ] Owner: merge + push the page; create the GitHub repository and its two secrets, push `main`; create the bot; `wrangler secret put ZULIP_BOT_TOKEN`; private tests.
- [ ] Owner: the `#Zulip meta` post.
