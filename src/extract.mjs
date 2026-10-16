// extractLean(renderedHtml, rawMarkdown): pull the first Lean code block out of a Zulip
// message. Pure, no DOM, no dependencies; runs unchanged in Node and on Workers.
//
// Order (docs/DESIGN.md §5.2): in Zulip's rendered HTML, the first `div.codehilite`
// whose data-code-language matches /^lean/i outside a <blockquote>, then the first such
// block inside one (quote-and-reply), then the first block of any language outside,
// then inside. When the rendered HTML yields nothing (absent, or its markup changed),
// the raw Zulip Markdown is parsed: fences of 3+ backticks or tildes that close only on
// the same character repeated at least as many times, with `quote`/`spoiler` fences as
// containers, ranked the same way (lean/lean4/untagged first, other languages after).
//
// Returns { code, source: "rendered" | "raw", quoted, language } with `code` ending in
// exactly one newline; { truncated: true } when the message ends with Zulip's
// "[message truncated]" marker, the block's last line is that marker, or a raw fence is
// unterminated; null when there is no code block at all.

export const TRUNCATED_MARKER = "[message truncated]";

const LEAN_LANGUAGE = /^lean/i;
const CONTAINER_FENCES = new Set(["quote", "quoted", "spoiler"]);
const NAMED_ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", nbsp: " " };

export function extractLean(renderedHtml, rawMarkdown) {
  const html = typeof renderedHtml === "string" ? renderedHtml : "";
  const raw = typeof rawMarkdown === "string" ? rawMarkdown : "";
  const found = (html && fromRendered(html)) || (raw && fromRaw(raw)) || null;
  if (!found) return null;
  const messageTruncated = endsWithMarker(raw) || (!raw && endsWithMarker(textOf(html)));
  if (messageTruncated || found.unterminated || lastLineIs(found.code, TRUNCATED_MARKER)) {
    return { truncated: true };
  }
  return { code: found.code, source: found.source, quoted: found.quoted, language: found.language };
}

/** Decode `&lt; &gt; &amp; &quot; &#39; &apos; &nbsp;` and numeric (decimal or hex) references in one pass. */
export function decodeEntities(text) {
  return text.replace(/&(?:#x([0-9a-f]{1,6})|#([0-9]{1,7})|([a-z]+));/gi, (match, hex, dec, name) => {
    if (hex || dec) {
      const cp = parseInt(hex || dec, hex ? 16 : 10);
      if (!Number.isFinite(cp) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "�";
      return String.fromCodePoint(cp);
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name.toLowerCase())
      ? NAMED_ENTITIES[name.toLowerCase()]
      : match;
  });
}

// ---------------------------------------------------------------------------- rendered

const CODE_BLOCK = /<div\b[^>]*\bclass="[^"]*\bcodehilite\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;

function fromRendered(html) {
  const blocks = [];
  CODE_BLOCK.lastIndex = 0;
  // Blockquote depth is tracked incrementally over the gaps between blocks (linear in |html|): a
  // quote fence of ~1,000 one-character blocks fits Zulip's 10,000-char cap and must stay cheap.
  let depth = 0, prev = 0;
  for (let m; (m = CODE_BLOCK.exec(html)); ) {
    const gap = html.slice(prev, m.index);
    depth += count(gap, /<blockquote\b/gi) - count(gap, /<\/blockquote\s*>/gi);
    prev = m.index;
    const openTag = m[0].slice(0, m[0].indexOf(">") + 1);
    const lang = /\bdata-code-language="([^"]*)"/i.exec(openTag);
    const inner = /<code\b[^>]*>([\s\S]*?)<\/code>/i.exec(m[1]) || /<pre\b[^>]*>([\s\S]*?)<\/pre>/i.exec(m[1]);
    const code = normalise(decodeEntities(stripTags(inner ? inner[1] : m[1])));
    if (code === null) continue; // whitespace-only block
    blocks.push({
      code,
      language: lang ? decodeEntities(lang[1]) : "",
      lean: lang ? LEAN_LANGUAGE.test(lang[1]) : false,
      quoted: depth > 0,
      source: "rendered",
      unterminated: false,
    });
  }
  return rank(blocks);
}

function count(text, re) {
  let n = 0;
  re.lastIndex = 0;
  while (re.exec(text)) n++;
  return n;
}

function stripTags(fragment) {
  return fragment.replace(/<[^>]*>/g, "");
}

function textOf(html) {
  return decodeEntities(stripTags(html));
}

// --------------------------------------------------------------------------------- raw

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`~]*)/;

/** Scan raw Zulip Markdown with a fence stack; quote/spoiler fences are containers, `math` is not code. */
function fromRaw(raw) {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const stack = []; // { char, len, lang, container, lines, quoted }
  const blocks = [];

  const closes = (line, fence) => {
    const t = line.trim();
    return t.length >= fence.len && t === fence.char.repeat(t.length);
  };
  const finish = (fence, unterminated) => {
    if (fence.container || fence.lang === "math") return;
    const code = normalise(fence.lines.join("\n"));
    if (code === null) return;
    blocks.push({
      code,
      language: fence.lang,
      lean: fence.lang === "" || LEAN_LANGUAGE.test(fence.lang),
      quoted: fence.quoted,
      source: "raw",
      unterminated,
    });
  };

  for (const line of lines) {
    const top = stack[stack.length - 1];
    if (top && !top.container) {
      if (closes(line, top)) {
        stack.pop();
        finish(top, false);
      } else {
        top.lines.push(line);
      }
      continue;
    }
    if (top && closes(line, top)) {
      stack.pop();
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      const lang = open[2].replace(/^\{?\.?/, "").replace(/\}$/, "").toLowerCase();
      stack.push({
        char: open[1][0],
        len: open[1].length,
        lang,
        container: CONTAINER_FENCES.has(lang),
        lines: [],
        quoted: stack.some((f) => f.container),
      });
    }
  }
  while (stack.length) finish(stack.pop(), true);
  return rank(blocks);
}

// ------------------------------------------------------------------------------ shared

/** First block in document order from the best non-empty tier: lean outside quotes, lean quoted, other outside, other quoted. */
function rank(blocks) {
  if (blocks.length === 0) return null;
  const tiers = [
    (b) => b.lean && !b.quoted,
    (b) => b.lean && b.quoted,
    (b) => !b.lean && !b.quoted,
    (b) => !b.lean && b.quoted,
  ];
  for (const tier of tiers) {
    const hit = blocks.find(tier);
    if (hit) return hit;
  }
  return null;
}

/** CRLF → LF, trailing newlines collapsed to exactly one; null for whitespace-only text. */
function normalise(text) {
  const body = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  return body.trim() === "" ? null : body + "\n";
}

function endsWithMarker(text) {
  return text.trimEnd().endsWith(TRUNCATED_MARKER);
}

function lastLineIs(code, marker) {
  const lines = code.trimEnd().split("\n");
  return lines[lines.length - 1].trim() === marker;
}
