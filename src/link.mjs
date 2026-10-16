// linkFor(code, origin): the QED64 share link for a snippet (docs/DESIGN.md §3.2, §5.2).
//
// `#codez=` carries LZ-string Base64 without padding, exactly as lean4web writes it
// (`LZString.compressToBase64(code).replace(/=*$/, '')`); `#code=` carries the
// percent-encoded text and is used only when it is shorter (snippets under ~150
// characters). The fragment never reaches a server (RFC 3986 §3.5). The caps are guards,
// not expectations: Zulip caps a message at 10,000 characters and LZ-string keeps a
// `#codez=` link under ~6,500 characters for anything that size.

import { compressToBase64 } from "./lz-string.mjs";

export const DEFAULT_ORIGIN = "https://qed64.fawadworkaddress.workers.dev";
export const MAX_CODE_CHARS = 12_000;
export const MAX_URL_CHARS = 8_000;

/** @returns {{ url: string, kind: "codez" | "code" } | { tooLong: true }} */
export function linkFor(code, origin = DEFAULT_ORIGIN) {
  const text = String(code ?? "");
  if (text.length > MAX_CODE_CHARS) return { tooLong: true };
  const base = String(origin || DEFAULT_ORIGIN).replace(/\/+$/, "");
  const codez = compressToBase64(text).replace(/=+$/, "");
  // encodeURIComponent throws on a lone surrogate; LZ-string is code-unit based and carries it, so #codez= alone then.
  let plain = null;
  try { plain = percentEncode(text); } catch { /* ill-formed UTF-16 */ }
  const [kind, value] = plain !== null && plain.length < codez.length ? ["code", plain] : ["codez", codez];
  const url = `${base}/#${kind}=${value}`;
  if (url.length > MAX_URL_CHARS) return { tooLong: true };
  return { url, kind };
}

/**
 * encodeURIComponent plus `( ) ' ! *`, which it leaves alone but which break or
 * truncate a Markdown `[text](url)` link; decodeURIComponent reverses both.
 */
export function percentEncode(text) {
  return encodeURIComponent(text).replace(/[()'!*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}
