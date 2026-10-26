/**
 * Pinned contract (issue #4): redact(text) replaces secret-shaped strings
 * (bare tokens such as JWTs and provider keys, `Bearer` header values, and
 * keyed assignments like password/token/apiKey) with [REDACTED], while
 * redactWorkflow(workflow) drops every `credentials` key from an n8n workflow
 * object without mutating its input. Both are pure boundary functions over
 * untrusted data: they never throw and never touch anything but their input
 * copy.
 */

const REDACTED = "[REDACTED]";

/**
 * Bare secret shapes: JWTs (three base64url segments starting eyJ), GitHub
 * tokens (ghp_/gho_/ghs_/ghu_/ghr_), and sk- style provider keys. Matched
 * anywhere, independent of key names.
 */
const BARE_SECRET_PATTERNS: readonly RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\bgh[posur]_[A-Za-z0-9]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
];

/**
 * Bearer header values. Runs BEFORE the keyed rule: otherwise
 * "authorization: Bearer <token>" would have only the word "Bearer" redacted
 * as the keyed value, stranding the raw token after it.
 */
const BEARER_VALUE = /\b(bearer)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * Keyed secret assignments: a known secret field name followed by : or = and a
 * quoted or bare value. The key name is preserved, only the value is replaced.
 * api[-_]?key covers apiKey / api_key / api-key. The bare-value class stops at
 * whitespace, quotes, brackets, and closing punctuation so surrounding prose
 * survives and an already-redacted "[REDACTED]" value is not re-captured
 * (that would append stray brackets on every pass and break idempotence).
 */
const KEYED_SECRET =
  /\b(password|passwd|pwd|secret|token|api[-_]?key|access[-_]?token|auth[-_]?token|client[-_]?secret|private[-_]?key|authorization)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s"',;)\]\[{}]+)/gi;

/**
 * Entropy-assignment rule: any key=value whose value has >= 20 chars drawn
 * from [A-Za-z0-9_-+/=] containing BOTH letters and digits. Quote-aware so
 * JSON-shaped values ("creds":"a1b2...") are covered too. Values starting with
 * a known scheme followed by // are carved out (see entropyCallback).
 */
const ENTROPY_ASSIGNMENT =
  /(\b"?[A-Za-z][A-Za-z0-9_.\- \t]{0,32}?"?\s*[:=]\s*)("?)([A-Za-z0-9_\-+/=]{20,})\2/g;

/** URL schemes whose scheme:// values the entropy rule must leave intact. */
const URL_SCHEMES = new Set([
  "http",
  "https",
  "ftp",
  "ftps",
  "sftp",
  "ssh",
  "git",
  "ws",
  "wss",
  "file",
  "rsync",
]);

/** Secrets removed only their value; surrounding punctuation stays parseable. */
function redactQuotedValue(value: string): string {
  const quote = value.charAt(0);
  if (quote === '"' || quote === "'") return `${quote}${REDACTED}${quote}`;
  return REDACTED;
}

/**
 * Redact secret-shaped strings in untrusted text. Rules run in a fixed order
 * on the output of the previous one: bare tokens, then Bearer headers, then
 * keyed assignments, then the conservative entropy rule. Over-redaction is a
 * deliberate bias ("Redaction at every boundary"); the only carve-out keeps
 * full scheme:// URLs intact so error diagnostics do not lose endpoint URLs.
 * the keyed rule still fires for secret parameters embedded in those URLs.
 */
export function redact(text: string): string {
  if (typeof text !== "string") {
    // Untrusted inputs can arrive as non-strings from JS callers; the gate
    // must never throw, so treat them as empty.
    return "";
  }
  let working = text;
  for (const pattern of BARE_SECRET_PATTERNS) {
    working = working.replace(pattern, REDACTED);
  }
  working = working.replace(BEARER_VALUE, (_m, scheme: string, gap: string) => `${scheme}${gap}${REDACTED}`);
  working = working.replace(
    KEYED_SECRET,
    (_m, key: string, separator: string, value: string) =>
      `${key}${separator}${redactQuotedValue(value)}`,
  );
  working = working.replace(
    ENTROPY_ASSIGNMENT,
    (match, prefix: string, quote: string, value: string) => {
      // Mixed letter+digit class is what makes a long value secret-shaped;
      // pure-alphabet or pure-digit runs (prose, counters) stay untouched.
      if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return match;
      // Carve-out by the entropy rule only: the value starts with // and the
      // prefix ends in a known URL scheme. The engine matches the LAZIEST key
      // from the leftmost word boundary (e.g. prefix "failed http:"), so the
      // scheme is taken as the last token of the prefix, not the whole prefix.
      if (quote === "" && value.startsWith("//")) {
        const prefixKey = prefix.replace(/[=:]\s*$/, "").trim().toLowerCase();
        const scheme = prefixKey.split(/[^a-z0-9+.-]/).pop() ?? "";
        if (URL_SCHEMES.has(scheme)) return match;
      }
      return `${prefix}${quote === "" ? REDACTED : `"${REDACTED}"`}`;
    },
  );
  return working;
}

/**
 * Drop the exact key "credentials" from every level of a workflow object.
 * Builds a fresh plain-object/array deep copy (never mutating the input, never
 * using structuredClone; exotic inputs must not throw). Non-plain-object
 * values (scalars, Dates, Maps, ...) pass through by reference; strings inside
 * the workflow are intentionally NOT redacted here: parameter-level redaction
 * belongs to the later workflow-view layer.
 */
export function redactWorkflow(workflow: unknown): unknown {
  if (Array.isArray(workflow)) {
    return workflow.map((entry) => redactWorkflow(entry));
  }
  if (isPlainObject(workflow)) {
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(workflow)) {
      if (key === "credentials") continue;
      copy[key] = redactWorkflow(value);
    }
    return copy;
  }
  return workflow;
}

/** Plain objects only (JSON.parse output shape); anything else passes through. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
