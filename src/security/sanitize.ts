/**
 * Pinned contract (issue #4): sanitize(text) strips invisible / Bidi /
 * tag-range characters, normalizes homoglyph confusables to their ASCII
 * equivalents, and flags instruction-shaped lines. The returned `text` is
 * guaranteed to match the issue regex
 * `[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\uE000-\uF8FF]` zero times,
 * so no exotic code points survive into prompt binding. sanitize is the first
 * gate for untrusted text and must never throw.
 */

/** Flag tokens emitted for lines that look like prompt-injection attempts. */
export type SanitizeFlag = "instruction-shaped-line";

export interface SanitizeResult {
  /** Cleaned text, safe for prompt binding. Flagged lines stay in the text. */
  text: string;
  /** Stable flag tokens, one entry per detected shape, deduplicated. */
  flags: SanitizeFlag[];
  /** Number of invisible/control characters removed. */
  invisibleCharsStripped: number;
  /** Number of code points rewritten by decomposition or the confusables map. */
  homoglyphsNormalized: number;
}

/**
 * Invisible/deceptive characters. Superset of the issue's regex: adds soft
 * hyphen (\u00AD), Mongolian vowel separator (\u180E), variation selectors
 * (\uFE00-\uFE0F), and the supplementary tags block (\u{E0000}-\u{E007F}) on
 * top of the zero-width/Bidi/invisible/BMP-private-use classes.
 */
const INVISIBLE_CHARS =
  /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFE00-\uFE0F\uFEFF\uE000-\uF8FF\u{E0000}-\u{E007F}]/gu;

/**
 * C0/C1 control characters minus \n (\u000A) and \t (\u0009): those two must
 * survive because line structure feeds the instruction line scanner.
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F]/gu;

/**
 * Hand-maintained confusables map (Cyrillic + Greek + micro sign) mapping
 * visually identical code points to their ASCII look-alikes. Source literals
 * are \uXXXX-escaped so this security-relevant file stays ASCII-only and
 * reviewable. This is the documented, extensible boundary instead of a full
 * TR39 port.
 */
const CONFUSABLES: Readonly<Record<string, string>> = {
  // Cyrillic capitals
  "\u0410": "A",
  "\u0412": "B",
  "\u0415": "E",
  "\u0406": "I",
  "\u0405": "S",
  "\u0408": "J",
  "\u041A": "K",
  "\u041C": "M",
  "\u041D": "H",
  "\u041E": "O",
  "\u0420": "P",
  "\u0421": "C",
  "\u0422": "T",
  "\u0423": "Y",
  "\u0425": "X",
  // Cyrillic lowercase
  "\u0430": "a",
  "\u0435": "e",
  "\u043E": "o",
  "\u0440": "p",
  "\u0441": "c",
  "\u0443": "y",
  "\u0445": "x",
  "\u0456": "i",
  "\u0455": "s",
  "\u0458": "j",
  "\u04BB": "h",
  // Greek capitals
  "\u0391": "A",
  "\u0392": "B",
  "\u0395": "E",
  "\u0396": "Z",
  "\u0397": "H",
  "\u0399": "I",
  "\u039A": "K",
  "\u039C": "M",
  "\u039D": "N",
  "\u039F": "O",
  "\u03A1": "P",
  "\u03A4": "T",
  "\u03A5": "Y",
  "\u03A7": "X",
  // Greek lowercase
  "\u03B1": "a",
  "\u03B5": "e",
  "\u03B9": "i",
  "\u03BA": "k",
  "\u03BD": "v",
  "\u03BF": "o",
  "\u03C1": "p",
  "\u03C4": "t",
  "\u03C5": "u",
  "\u03C7": "x",
  "\u03BC": "u",
  // Micro sign: NFKD lands on Greek mu, so map it directly to ASCII.
  "\u00B5": "u",
};

/** Combining marks removed after compatibility decomposition. */
const COMBINING_MARKS = /\p{M}+/gu;
/** Printable ASCII range kept when decomposition output is ASCII-safe. */
const PRINTABLE_ASCII = /^[\u0020-\u007E]+$/;

/**
 * Per-codepoint compatibility decomposition toward ASCII: NFKD, drop combining
 * marks, and keep the result only when it is printable ASCII (this covers
 * fullwidth forms, circled digits, and accented letters like U+00E9).
 * Hangul syllables re-contract Jamo under NFKD and have no ASCII confusable
 * worth mapping, so they pass through untouched. Everything non-decomposable
 * passes through unchanged.
 */
function asciiDecompose(codePoint: string): string {
  const code = codePoint.codePointAt(0) ?? 0;
  if (code >= 0xac00 && code <= 0xd7a3) return codePoint;
  const decomposed = codePoint.normalize("NFKD").replace(COMBINING_MARKS, "");
  if (
    decomposed !== "" &&
    decomposed !== codePoint &&
    PRINTABLE_ASCII.test(decomposed)
  ) {
    return decomposed;
  }
  return codePoint;
}

/**
 * Instruction-shaped line patterns (tight, documented set). Separators are
 * zero-or-more whitespace so word-joining artifacts of invisible-character
 * stripping still match; word anchors keep ordinary prose out.
 */
const INSTRUCTION_LINE_PATTERNS: readonly RegExp[] = [
  /\bignore\s*(?:all\s*)?(?:previous|prior|above|earlier)\s*(?:instructions?|prompts?)\b/i,
  /\bdisregard\s*(?:all\s*)?(?:previous|prior|above|earlier)?\s*(?:instructions?|prompts?)\b/i,
  /\b(?:reveal|show|print|repeat|output|echo)\s*(?:your\s*|the\s*)?(?:system\s*)?(?:prompt|instructions?)\b/i,
];

/**
 * Search-result field cleaner (issue #76): coerces one raw `title`/`url`/
 * `snippet` hit into sanitized evidence strings for the enriched diagnose
 * prompt. Non-string fields become `""` (never throws); string fields go
 * through `sanitize()` so invisible characters, homoglyph tricks, and
 * instruction-shaped lines cannot ride search snippets into the prompt.
 * Flagged lines stay in the text — sanitize flags, it never destroys
 * evidence content the diagnoser may need.
 */
export interface SanitizedSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export function sanitizeSearchResult(result: unknown): SanitizedSearchResult {
  const record =
    typeof result === "object" && result !== null
      ? (result as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  return {
    title: sanitizeField(record.title),
    url: sanitizeField(record.url),
    snippet: sanitizeField(record.snippet),
  };
}

/** One evidence field: non-strings become `""`, strings are sanitized. Never throws. */
function sanitizeField(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    return sanitize(value).text;
  } catch {
    return "";
  }
}
/**
 * Sanitize untrusted text before prompt binding. Pipeline order matters:
 * strip invisibles first (so split-word trickery collapses), then decompose
 * homoglyphs per codepoint, then confusables-map leftovers, and only then scan
 * lines for instruction shapes -- after cleaning, so
 * "Ig\u200Bnore", fullwidth, and Cyrillic-mixed spellings are still caught.
 * Flagged lines are kept in the text -- sanitize flags, it never destroys
 * payload content the diagnoser may need.
 */
export function sanitize(text: string): SanitizeResult {
  if (typeof text !== "string") {
    // Untrusted inputs can arrive as non-strings from JS callers; the gate
    // must never throw, so treat them as empty.
    return { text: "", flags: [], invisibleCharsStripped: 0, homoglyphsNormalized: 0 };
  }

  let invisibleCharsStripped = 0;

  // Normalize CR/CRLF to LF first: a removed bare CR would otherwise glue
  // words together mid-line and defeat the line scanner.
  const crCount = (text.match(/\r/g) ?? []).length;
  let working = text.replace(/\r\n?/g, "\n");
  invisibleCharsStripped += crCount;

  const controlMatches = working.match(CONTROL_CHARS);
  if (controlMatches !== null) {
    invisibleCharsStripped += controlMatches.length;
    working = working.replace(CONTROL_CHARS, "");
  }

  const invisibleMatches = working.match(INVISIBLE_CHARS);
  if (invisibleMatches !== null) {
    invisibleCharsStripped += invisibleMatches.length;
    working = working.replace(INVISIBLE_CHARS, "");
  }

  let homoglyphsNormalized = 0;
  const pieces: string[] = [];
  // Iterate code points (not UTF-16 units) so astral confusables like
  // mathematical-alphanumeric letters decompose as single characters.
  for (const codePoint of working) {
    let mapped = asciiDecompose(codePoint);
    if (mapped === codePoint) {
      const confusable = CONFUSABLES[codePoint];
      if (confusable !== undefined) mapped = confusable;
    }
    if (mapped !== codePoint) homoglyphsNormalized += 1;
    pieces.push(mapped);
  }
  const normalizedText = pieces.join("");

  const flags = new Set<SanitizeFlag>();
  for (const line of normalizedText.split(/[\n\u2028\u2029]/)) {
    if (INSTRUCTION_LINE_PATTERNS.some((pattern) => pattern.test(line))) {
      flags.add("instruction-shaped-line");
    }
  }

  return {
    text: normalizedText,
    flags: [...flags],
    invisibleCharsStripped,
    homoglyphsNormalized,
  };
}
