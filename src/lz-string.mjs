// lz-string 1.5.0 (LZ-based compression algorithm for JavaScript), vendored as a
// dependency-free ES module. This is a port of libs/lz-string.js from the npm package
// `lz-string@1.5.0` restricted to the string codecs the QED64 link needs:
// compressToBase64 / decompressFromBase64 (what lean4web and QED64 use for `#codez=`)
// and the URI-safe pair. The bit-level behaviour is unchanged, so the output is
// byte-identical to the npm package; test/link.test.mjs pins a vector shared with the
// QED64 page's own port, and the port was compared against the npm tarball
// (sha512 h5bgJWpxJNswbU7qCrV0tIKQCaS3blPDrqKWx+QxzuzL1zGUzij9XCWLrSLsJPu5t+eWA/ycetzYAO5IOMcWAQ==)
// on real Zulip snippets, edge cases and random strings.
//
// MIT License
//
// Copyright (c) 2013 pieroxy
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

const keyStrBase64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
const keyStrUriSafe = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$";

const reverseDictionaries = new Map();

/** Index of `character` in `alphabet`, or undefined (the upstream behaviour: unknown characters read as zero bits). */
function baseValue(alphabet, character) {
  let dict = reverseDictionaries.get(alphabet);
  if (!dict) {
    dict = new Map();
    for (let i = 0; i < alphabet.length; i++) dict.set(alphabet.charAt(i), i);
    reverseDictionaries.set(alphabet, dict);
  }
  return dict.get(character);
}

/** Upstream `_compress`: LZW over UTF-16 code units, emitted `bitsPerChar` bits per output character. */
function compress(uncompressed, bitsPerChar, charFromInt) {
  if (uncompressed == null) return "";
  const dictionary = new Map();
  const dictionaryToCreate = new Map();
  let w = "";
  let enlargeIn = 2; // compensates for the first entry, which should not count
  let dictSize = 3;
  let numBits = 2;
  const data = [];
  let dataVal = 0;
  let dataPosition = 0;

  const writeBits = (value, count) => {
    for (let i = 0; i < count; i++) {
      dataVal = (dataVal << 1) | (value & 1);
      if (dataPosition === bitsPerChar - 1) {
        dataPosition = 0;
        data.push(charFromInt(dataVal));
        dataVal = 0;
      } else {
        dataPosition++;
      }
      value >>= 1;
    }
  };
  const grow = () => {
    enlargeIn--;
    if (enlargeIn === 0) {
      enlargeIn = Math.pow(2, numBits);
      numBits++;
    }
  };
  const emit = () => {
    if (dictionaryToCreate.has(w)) {
      const code = w.charCodeAt(0);
      if (code < 256) {
        writeBits(0, numBits);
        writeBits(code, 8);
      } else {
        writeBits(1, numBits); // a 1 followed by numBits-1 zeros
        writeBits(code, 16);
      }
      grow();
      dictionaryToCreate.delete(w);
    } else {
      writeBits(dictionary.get(w), numBits);
    }
    grow();
  };

  for (let ii = 0; ii < uncompressed.length; ii++) {
    const c = uncompressed.charAt(ii);
    if (!dictionary.has(c)) {
      dictionary.set(c, dictSize++);
      dictionaryToCreate.set(c, true);
    }
    const wc = w + c;
    if (dictionary.has(wc)) {
      w = wc;
    } else {
      emit();
      dictionary.set(wc, dictSize++);
      w = c;
    }
  }
  if (w !== "") emit();

  writeBits(2, numBits); // end-of-stream marker
  for (;;) {
    dataVal <<= 1;
    if (dataPosition === bitsPerChar - 1) {
      data.push(charFromInt(dataVal));
      break;
    }
    dataPosition++;
  }
  return data.join("");
}

/** Upstream `_decompress`. Returns "" for an empty stream, null for a corrupt one. */
function decompress(length, resetValue, nextValue) {
  const dictionary = [0, 1, 2];
  let enlargeIn = 4;
  let dictSize = 4;
  let numBits = 3;
  let entry = "";
  const result = [];
  let val = nextValue(0);
  let position = resetValue;
  let index = 1;

  const readBits = (count) => {
    let bits = 0;
    let power = 1;
    for (let i = 0; i < count; i++) {
      const resb = val & position;
      position >>= 1;
      if (position === 0) {
        position = resetValue;
        val = nextValue(index++);
      }
      if (resb > 0) bits |= power;
      power <<= 1;
    }
    return bits;
  };

  let c;
  switch (readBits(2)) {
    case 0:
      c = String.fromCharCode(readBits(8));
      break;
    case 1:
      c = String.fromCharCode(readBits(16));
      break;
    case 2:
      return "";
    default:
      return null; // upstream would throw on this corrupt prefix
  }
  dictionary[3] = c;
  let w = c;
  result.push(c);
  for (;;) {
    if (index > length) return "";
    c = readBits(numBits);
    switch (c) {
      case 0:
        dictionary[dictSize++] = String.fromCharCode(readBits(8));
        c = dictSize - 1;
        enlargeIn--;
        break;
      case 1:
        dictionary[dictSize++] = String.fromCharCode(readBits(16));
        c = dictSize - 1;
        enlargeIn--;
        break;
      case 2:
        return result.join("");
    }
    if (enlargeIn === 0) {
      enlargeIn = Math.pow(2, numBits);
      numBits++;
    }
    if (dictionary[c]) {
      entry = dictionary[c];
    } else if (c === dictSize) {
      entry = w + w.charAt(0);
    } else {
      return null;
    }
    result.push(entry);
    dictionary[dictSize++] = w + entry.charAt(0);
    enlargeIn--;
    w = entry;
    if (enlargeIn === 0) {
      enlargeIn = Math.pow(2, numBits);
      numBits++;
    }
  }
}

/** Standard Base64 alphabet, padded with `=` to a multiple of four characters (lean4web strips the padding). */
export function compressToBase64(input) {
  if (input == null) return "";
  const res = compress(input, 6, (a) => keyStrBase64.charAt(a));
  switch (res.length % 4) {
    default:
    case 0:
      return res;
    case 1:
      return res + "===";
    case 2:
      return res + "==";
    case 3:
      return res + "=";
  }
}

/** Inverse of compressToBase64; padding is optional. "" → null, null → "". */
export function decompressFromBase64(input) {
  if (input == null) return "";
  if (input === "") return null;
  return decompress(input.length, 32, (index) => baseValue(keyStrBase64, input.charAt(index)));
}

/** URI-safe alphabet (`+-$` instead of `+/=`), never padded. */
export function compressToEncodedURIComponent(input) {
  if (input == null) return "";
  return compress(input, 6, (a) => keyStrUriSafe.charAt(a));
}

/** Inverse of compressToEncodedURIComponent (spaces are read as `+`, as upstream does). */
export function decompressFromEncodedURIComponent(input) {
  if (input == null) return "";
  if (input === "") return null;
  const fixed = input.replace(/ /g, "+");
  return decompress(fixed.length, 32, (index) => baseValue(keyStrUriSafe, fixed.charAt(index)));
}
