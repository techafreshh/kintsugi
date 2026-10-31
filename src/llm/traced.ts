/**
 * Pinned contract (issue #18): `TracedLLM` decorator over the selected
 * `LLMPort` (mock, OpenRouter, DeepSeek, or off). Every `submit_verdict` call persists one
 * `insertTrace` row (success and failure) so every LLM decision is auditable,
 * and the pipeline stages keep taking plain `LLMPort` so decoration is
 * transparent. `eventId` is bound at decoration time, keeping the port
 * signature untouched; `withTraces` wraps an existing port and
 * `createTracedLLM` builds the inner via the existing `createLLM(env)`
 * switch-point before wrapping.
 */

import type { Static, TSchema } from "@sinclair/typebox";
import { createLLM } from "./port.js";
import type { LlmMode, LlmStage, LLMPort } from "./port.js";
import type { Store } from "../store/store.js";

/**
 * Issue contract caps the stored prompt/response text at 8000 characters
 * each (tighter than the store's 32,768 `TRACE_TEXT_CAP`, which stays
 * unchanged); the wrapper enforces it before `insertTrace`.
 */
export const TRACE_TEXT_CAP = 8_000;

/** Options-object shape for the decorator and factories. */
export interface TracedOptions {
  inner: LLMPort;
  store: Store;
  eventId: string;
}

/** Stringify a prompt, response, or verdict for storage: strings stay as-is,
 * other values go through safe `JSON.stringify` with a `String()` fallback
 * (mirroring `promptAsText` in `src/llm/openrouter.ts`); never throws. */
function traceText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

/** Cap stored text at the wrapper-layer 8000-char limit. */
function capText(value: string): string {
  return value.length <= TRACE_TEXT_CAP ? value : value.slice(0, TRACE_TEXT_CAP);
}

/** Rough token estimate from stored text length (`ceil(chars/4)`). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Error text for a failed inner call; never throws. */
function errorText(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  try {
    const json = JSON.stringify(cause);
    return json === undefined ? String(cause) : json;
  } catch {
    return String(cause);
  }
}

/** Model label for the trace row: the inner stage routing when available
 * (provider `resolveModel`) else the port name (mock); never throws and never
 * returns blank. */
function resolveModelName(inner: LLMPort, stage: LlmStage): string {
  const candidate = (inner as unknown as { resolveModel?: unknown }).resolveModel;
  if (typeof candidate === "function") {
    try {
      const model = (candidate as (stage: LlmStage) => unknown).call(inner, stage);
      if (typeof model === "string" && model !== "") return model;
    } catch {
      // Fall through to the port name below.
    }
  }
  const name = (inner as unknown as { name?: unknown }).name;
  return typeof name === "string" && name !== "" ? name : "unknown";
}

function normalizeOptions(innerOrOptions: LLMPort | TracedOptions, store?: Store, eventId?: string): TracedOptions {
  if (
    typeof innerOrOptions === "object" &&
    innerOrOptions !== null &&
    "inner" in innerOrOptions &&
    "store" in innerOrOptions &&
    "eventId" in innerOrOptions
  ) {
    return innerOrOptions as TracedOptions;
  }
  return { inner: innerOrOptions as LLMPort, store: store as Store, eventId: eventId as string };
}

export class TracedLLM implements LLMPort {
  private readonly inner: LLMPort;
  private readonly store: Store;
  private readonly eventId: string;

  constructor(inner: LLMPort, store: Store, eventId: string);
  constructor(options: TracedOptions);
  constructor(innerOrOptions: LLMPort | TracedOptions, store?: Store, eventId?: string) {
    const resolved = normalizeOptions(innerOrOptions, store, eventId);
    this.inner = resolved.inner;
    this.store = resolved.store;
    this.eventId = resolved.eventId;
  }

  /** Delegated to the inner port so the wrapper is transparent. */
  get name(): string {
    return this.inner.name;
  }

  /** Delegated to the inner port (`mock` or `live`). */
  get mode(): LlmMode {
    return this.inner.mode;
  }

  /**
   * Delegate to the inner port and persist one trace row per call. Success
   * stores the parsed verdict with `error: null`; a failed inner call stores
   * `verdict: null` with the error text and rethrows. A store throw on the
   * success path is swallowed so tracing never masks the verdict; on the
   * failure path the trace write propagates.
   */
  async submit_verdict<T extends TSchema>(
    stage: LlmStage,
    prompt: unknown,
    schema: T,
  ): Promise<Static<T>> {
    const startedAt = Date.now();
    const promptText = capText(traceText(prompt));
    let verdict: unknown;
    try {
      verdict = await this.inner.submit_verdict(stage, prompt, schema);
    } catch (cause) {
      const durationMs = Math.max(0, Math.round(Date.now() - startedAt));
      this.store.insertTrace({
        eventId: this.eventId,
        stage,
        model: resolveModelName(this.inner, stage),
        llmMode: this.inner.mode,
        durationMs,
        tokensIn: estimateTokens(promptText),
        tokensOut: 0,
        prompt: promptText,
        response: "",
        verdict: null,
        error: errorText(cause),
      });
      throw cause;
    }
    const responseText = capText(traceText(verdict));
    const durationMs = Math.max(0, Math.round(Date.now() - startedAt));
    try {
      this.store.insertTrace({
        eventId: this.eventId,
        stage,
        model: resolveModelName(this.inner, stage),
        llmMode: this.inner.mode,
        durationMs,
        tokensIn: estimateTokens(promptText),
        tokensOut: estimateTokens(responseText),
        prompt: promptText,
        response: responseText,
        verdict: verdict as unknown,
        error: null,
      });
    } catch {
      // Trace writes are best-effort on success; the verdict still returns.
    }
    return verdict as Static<T>;
  }
}

/**
 * Wrap an existing port with tracing for one event. Accepts positional
 * `(inner, store, eventId)` or an options object.
 */
export function withTraces(inner: LLMPort, store: Store, eventId: string): TracedLLM;
export function withTraces(options: TracedOptions): TracedLLM;
export function withTraces(
  innerOrOptions: LLMPort | TracedOptions,
  store?: Store,
  eventId?: string,
): TracedLLM {
  return new TracedLLM(normalizeOptions(innerOrOptions, store, eventId));
}

/**
 * Orchestrator switch-point: build the inner port via the existing
 * `createLLM(env)` (mock via `KINTSUGI_MOCK_LLM=1`, live provider via `LLM_PROVIDER`, off otherwise)
 * and wrap it with tracing for one event.
 */
export function createTracedLLM(env: NodeJS.ProcessEnv, store: Store, eventId: string): TracedLLM;
export function createTracedLLM(options: TracedOptions & { env: NodeJS.ProcessEnv }): TracedLLM;
export function createTracedLLM(
  envOrOptions: NodeJS.ProcessEnv | (TracedOptions & { env: NodeJS.ProcessEnv }),
  store?: Store,
  eventId?: string,
): TracedLLM {
  if (
    typeof envOrOptions === "object" &&
    envOrOptions !== null &&
    "env" in envOrOptions &&
    "store" in envOrOptions &&
    "eventId" in envOrOptions
  ) {
    const options = envOrOptions as TracedOptions & { env: NodeJS.ProcessEnv };
    return new TracedLLM(createLLM(options.env), options.store, options.eventId);
  }
  const inner = createLLM(envOrOptions as NodeJS.ProcessEnv);
  return new TracedLLM(inner, store as Store, eventId as string);
}
