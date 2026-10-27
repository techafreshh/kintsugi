/**
 * Pinned contract (issue #19): Telegram notifier for Tier-2 approval cards.
 * Flag-gated off by default (`TELEGRAM_NOTIFIER_ENABLED=true` plus both
 * `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` required); when the gate is off no
 * outbound network happens. Approval callbacks dispatch through the
 * structural `ApprovalSink` so this module compiles and unit-tests without
 * the orchestrator, while the wiring step passes the real orchestrator
 * methods so traces and snapshots stay consistent (the orchestrator remains
 * the only writer). Uses the global `fetch` + `AbortSignal.timeout`
 * transport idiom from `src/n8n/client.ts`; no new dependencies.
 */

import type { Settings } from "../config/settings.js";
import type { Tier } from "../pipeline/tier.js";

/** Built-in Telegram Bot API root; overridable via `TELEGRAM_API_BASE_URL`. */
export const DEFAULT_TELEGRAM_API_BASE_URL = "https://api.telegram.org";

/** Per-request deadline mirroring `src/n8n/client.ts`. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Diagnosis summary cap so hostile payloads cannot blow up the card. */
const SUMMARY_CAP = 500;

/** Minimal settings surface the gate and transport read. */
export interface TelegramSettings {
  telegramEnabled: boolean;
  telegramBotToken: string | undefined;
  telegramChatId: string | undefined;
  telegramApiBaseUrl: string | undefined;
}

/** Approval card payload rendered into the Telegram message. */
export interface ApprovalCard {
  eventId: string;
  tier: Tier;
  diagnosisSummary: unknown;
}

/** Injectable transport overrides; tests pass a stub `fetchFn`/stub base URL. */
export interface TelegramRequestOptions {
  fetchFn?: typeof fetch;
  apiBaseUrl?: string;
  timeoutMs?: number;
}

/** Options accepted by `handleTelegramUpdate`: settings and/or transport. */
export interface TelegramHandleOptions extends TelegramRequestOptions {
  settings?: TelegramSettings | Settings;
}

/** Structural approval sink; the wiring passes the real orchestrator. */
export interface ApprovalSink {
  approve(eventId: string): Promise<unknown>;
  reject(eventId: string): Promise<unknown>;
}

/** Minimal fetch-compatible function shape (global fetch or a stub). */
export type TelegramFetchFn = typeof fetch;

/**
 * Gate: flag on AND both credentials present. Blank credentials count as
 * absent so hand-built settings objects cannot slip through.
 */
export function isTelegramEnabled(
  settings: TelegramSettings | Settings | undefined | null,
): boolean {
  if (settings === undefined || settings === null) return false;
  if (settings.telegramEnabled !== true) return false;
  const token = settings.telegramBotToken;
  const chatId = settings.telegramChatId;
  if (typeof token !== "string" || token.trim() === "") return false;
  if (typeof chatId !== "string" || chatId.trim() === "") return false;
  return true;
}

/** Base URL: trimmed, trailing slashes stripped, default when blank/unset. */
export function resolveTelegramApiBaseUrl(raw: string | undefined): string {
  if (typeof raw !== "string") return DEFAULT_TELEGRAM_API_BASE_URL;
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed === "" ? DEFAULT_TELEGRAM_API_BASE_URL : trimmed;
}

/** Positive finite timeout or the built-in default. */
function resolveTimeoutMs(raw: number | undefined): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_TIMEOUT_MS;
}

/**
 * Capped stringify of an unknown diagnosis summary. Never throws: hostile
 * or circular input degrades to a short placeholder instead of breaking
 * the card.
 */
export function summarizeDiagnosis(input: unknown): string {
  try {
    if (typeof input === "string") {
      return input.length <= SUMMARY_CAP ? input : input.slice(0, SUMMARY_CAP);
    }
    if (input === undefined || input === null) return "n/a";
    const text = JSON.stringify(input);
    if (typeof text !== "string" || text === "") return "n/a";
    return text.length <= SUMMARY_CAP ? text : text.slice(0, SUMMARY_CAP);
  } catch {
    try {
      const fallback = String(input);
      return fallback.length <= SUMMARY_CAP ? fallback : fallback.slice(0, SUMMARY_CAP);
    } catch {
      return "n/a";
    }
  }
}

/** Card text; always carries the event id, the tier, and the capped summary. */
export function approvalCardText(card: ApprovalCard): string {
  const summary = summarizeDiagnosis(card.diagnosisSummary);
  return [
    "Kintsugi repair awaiting approval",
    `Event: ${card.eventId}`,
    `Tier: ${card.tier}`,
    `Summary: ${summary}`,
    "Tap Approve to promote or Reject to park the patch.",
  ].join("\n");
}

/**
 * Single transport helper mirroring `src/n8n/client.ts`: pinned headers,
 * `AbortSignal.timeout` deadline, low-level failures wrapped in `Error`
 * with `{ cause }`, non-2xx answered as a contextual `Error`.
 */
async function postTelegram(
  fetchFn: TelegramFetchFn,
  url: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw new Error(`telegram: ${label} failed (${describe(cause)})`, { cause });
  }
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    bodyText = "";
  }
  const status = (response as Response).status;
  if (typeof status === "number" && (status < 200 || status > 299)) {
    throw new Error(`telegram: ${label} returned ${status}: ${truncate(bodyText)}`);
  }
}

/**
 * Send the Tier-2 approval card. When the gate is off it returns
 * `{ sent: false }` before any `fetch` reference is touched, so an
 * instrumented `fetchFn` observes zero calls.
 */
export async function sendApprovalCard(
  card: ApprovalCard,
  settings: TelegramSettings | Settings,
  options?: TelegramRequestOptions,
): Promise<{ sent: boolean }> {
  if (!isTelegramEnabled(settings)) return { sent: false };
  const fetchFn = options?.fetchFn ?? globalThis.fetch;
  const apiBaseUrl = resolveTelegramApiBaseUrl(
    options?.apiBaseUrl ?? settings.telegramApiBaseUrl,
  );
  const timeoutMs = resolveTimeoutMs(options?.timeoutMs);
  const token = (settings.telegramBotToken as string).trim();
  const chatId = (settings.telegramChatId as string).trim();
  const url = `${apiBaseUrl}/bot${token}/sendMessage`;
  await postTelegram(
    fetchFn,
    url,
    {
      chat_id: chatId,
      text: approvalCardText(card),
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Approve", callback_data: `approve:${card.eventId}` },
            { text: "Reject", callback_data: `reject:${card.eventId}` },
          ],
        ],
      },
    },
    timeoutMs,
    "sendMessage",
  );
  return { sent: true };
}

/**
 * Acknowledge a callback query so Telegram clears the client's loading
 * state. Gated like sends: off means `{ sent: false }` with no fetch.
 */
export async function answerCallbackQuery(
  callbackQueryId: string,
  settings: TelegramSettings | Settings,
  options?: TelegramRequestOptions,
): Promise<{ sent: boolean }> {
  if (!isTelegramEnabled(settings)) return { sent: false };
  if (typeof callbackQueryId !== "string" || callbackQueryId === "") {
    throw new Error("telegram: callback_query_id is required");
  }
  const fetchFn = options?.fetchFn ?? globalThis.fetch;
  const apiBaseUrl = resolveTelegramApiBaseUrl(
    options?.apiBaseUrl ?? settings.telegramApiBaseUrl,
  );
  const timeoutMs = resolveTimeoutMs(options?.timeoutMs);
  const token = (settings.telegramBotToken as string).trim();
  const url = `${apiBaseUrl}/bot${token}/answerCallbackQuery`;
  await postTelegram(fetchFn, url, { callback_query_id: callbackQueryId }, timeoutMs, "answerCallbackQuery");
  return { sent: true };
}

/** Parsed callback action; anything else is not a known approval tap. */
function parseCallbackData(data: unknown): { action: "approve" | "reject"; eventId: string } | null {
  if (typeof data !== "string") return null;
  if (data.startsWith("approve:")) {
    const eventId = data.slice("approve:".length);
    return eventId !== "" ? { action: "approve", eventId } : null;
  }
  if (data.startsWith("reject:")) {
    const eventId = data.slice("reject:".length);
    return eventId !== "" ? { action: "reject", eventId } : null;
  }
  return null;
}

function readSettings(
  options: TelegramHandleOptions | TelegramSettings | Settings | undefined,
): TelegramSettings | Settings | undefined {
  if (options === undefined) return undefined;
  const record = options as Record<string, unknown>;
  if ("settings" in record) {
    const nested = record.settings as TelegramSettings | Settings | undefined;
    if (nested !== undefined) return nested;
  }
  if ("telegramEnabled" in record) return options as TelegramSettings;
  return undefined;
}

function readTransport(
  options: TelegramHandleOptions | TelegramSettings | Settings | undefined,
): TelegramRequestOptions {
  if (options === undefined) return {};
  const record = options as Record<string, unknown>;
  const out: TelegramRequestOptions = {};
  if (typeof record.fetchFn === "function") out.fetchFn = record.fetchFn as typeof fetch;
  if (typeof record.apiBaseUrl === "string") out.apiBaseUrl = record.apiBaseUrl;
  if (typeof record.timeoutMs === "number") out.timeoutMs = record.timeoutMs;
  return out;
}

/**
 * Handle one Telegram `Update`: parse `callback_query.data`, dispatch
 * `approve:<id>` / `reject:<id>` through the sink (the real orchestrator in
 * production), then `answerCallbackQuery`. Unknown or malformed updates
 * resolve `{ handled: false }` with no sink call, no fetch, and no throw.
 * The sink call is never gated (state stays consistent); only the outbound
 * `answerCallbackQuery` honors the flag, so flag-off means zero requests.
 */
export async function handleTelegramUpdate(
  update: unknown,
  sink: ApprovalSink,
  options?: TelegramHandleOptions | TelegramSettings | Settings,
): Promise<{ handled: boolean; action?: "approve" | "reject"; eventId?: string; answered?: boolean }> {
  if (typeof update !== "object" || update === null) return { handled: false };
  const callbackQuery = (update as Record<string, unknown>).callback_query;
  if (typeof callbackQuery !== "object" || callbackQuery === null) return { handled: false };
  const record = callbackQuery as Record<string, unknown>;
  const parsed = parseCallbackData(record.data);
  if (parsed === null) return { handled: false };
  if (sink === undefined || sink === null) return { handled: false };
  if (parsed.action === "approve") {
    if (typeof sink.approve !== "function") return { handled: false };
    await sink.approve(parsed.eventId);
  } else {
    if (typeof sink.reject !== "function") return { handled: false };
    await sink.reject(parsed.eventId);
  }
  const settings = readSettings(options);
  if (!isTelegramEnabled(settings ?? undefined)) return { handled: true, action: parsed.action, eventId: parsed.eventId, answered: false };
  const transport = readTransport(options);
  const merged: TelegramRequestOptions = {
    fetchFn: transport.fetchFn,
    apiBaseUrl: transport.apiBaseUrl ?? settings?.telegramApiBaseUrl,
    timeoutMs: transport.timeoutMs,
  };
  const queryId = typeof record.id === "string" && record.id !== "" ? record.id : undefined;
  if (queryId === undefined) return { handled: true, action: parsed.action, eventId: parsed.eventId, answered: false };
  await answerCallbackQuery(queryId, settings as TelegramSettings, merged);
  return { handled: true, action: parsed.action, eventId: parsed.eventId, answered: true };
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.message;
  return typeof value;
}

function truncate(text: string): string {
  return text.length <= 200 ? text : text.slice(0, 200);
}
