/** Small text helpers shared by the parser, detection and the UI. */

/**
 * Normalises text for matching: lower case, umlauts spelled out (ä→ae, ö→oe, ü→ue, ß→ss),
 * other accents removed, whitespace collapsed. "Zentralübung", "ZENTRALUEBUNG" and
 * "Zentralübung" (decomposed, as macOS writes it) all become "zentraluebung".
 */
export function normalize(s: string): string {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface Token {
  text: string;
  norm: string;
  start: number;
  end: number;
}

/** Splits text into word tokens (letters/digits), keeping their positions in the original. */
export function tokenize(s: string): Token[] {
  const out: Token[] = [];
  const re = /[\p{L}\p{N}]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push({ text: m[0], norm: normalize(m[0]), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * Finds whole-word phrase matches. `phrase` is normalised and may contain several words
 * ("lab course"). Returns [firstTokenIndex, lastTokenIndex] pairs.
 */
export function findPhrase(tokens: Token[], phrase: string): Array<[number, number]> {
  const words = normalize(phrase).split(' ').filter(Boolean);
  const hits: Array<[number, number]> = [];
  if (!words.length) return hits;
  for (let i = 0; i + words.length <= tokens.length; i++) {
    let ok = true;
    for (let j = 0; j < words.length; j++) {
      if (tokens[i + j].norm !== words[j]) { ok = false; break; }
    }
    if (ok) hits.push([i, i + words.length - 1]);
  }
  return hits;
}

/** Fast, stable 53-bit string hash (cyrb53), returned as hex. Used for change detection only. */
export function hash(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** JSON.stringify with sorted object keys, so equal objects always hash the same. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const o = v as Record<string, unknown>;
  return (
    '{' +
    Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stableStringify(o[k]))
      .join(',') +
    '}'
  );
}
