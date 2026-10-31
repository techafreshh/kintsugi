/**
 * Pinned contract (issue #74): the `LLMPort` behind which all LLM inference
 * sits, selected via `LLM_PROVIDER`. `submit_verdict` is generic over the
 * passed TypeBox schema, so the returned object is already typed as matching
 * that schema. `createLLM` is the orchestrator switch-point: it returns the
 * deterministic mock when `KINTSUGI_MOCK_LLM=1`, the OpenRouter or DeepSeek
 * provider when `LLM_PROVIDER` names one and its key is set, and a
 * zero-network off port otherwise.
 */

import type { Static, TSchema } from "@sinclair/typebox";
import { MockLLM } from "./mock.js";
import { OpenRouterLLM } from "./openrouter.js";
import { DeepSeekLLM } from "./deepseek.js";

/** Pipeline stages that ask the LLM for a verdict. */
export type LlmStage = "diagnose" | "patch" | "judge";

/** Which implementation served the verdict: mock (no credits), a live provider, or off. */
export type LlmMode = "mock" | "openrouter" | "deepseek" | "off";

/**
 * Typed LLM boundary. `prompt` is opaque to the port (a string or a compact
 * view object); the mock ignores it beyond scenario selection.
 */
export interface LLMPort {
  /** Human-readable implementation label; the mock reports `"mock"`. */
  readonly name: string;
  /** Which implementation served the verdict. */
  readonly mode: LlmMode;
  /** Parsed verdict object matching the given schema. */
  submit_verdict<T extends TSchema>(
    stage: LlmStage,
    prompt: unknown,
    schema: T,
  ): Promise<Static<T>>;
}

/**
 * Zero-network off port (issue #74): selected whenever mock is off and no
 * live provider is configured (unset/blank/unknown `LLM_PROVIDER`, or the
 * named provider's key is blank). It performs no imports and no fetch;
 * every `submit_verdict` throws so the repair pipeline can diagnose and
 * gate without inference.
 */
export class OffLLM implements LLMPort {
  readonly name = "off";
  readonly mode: LlmMode = "off";

  async submit_verdict<T extends TSchema>(
    stage: LlmStage,
    _prompt: unknown,
    _schema: T,
  ): Promise<Static<T>> {
    throw new Error(`llm off: stage "${stage}" has no provider (set LLM_PROVIDER and its API key)`);
  }
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function hasKey(env: NodeJS.ProcessEnv, key: string): boolean {
  return trimmed(env[key]) !== "";
}

/**
 * Orchestrator switch-point with an injectable env map (mirroring
 * `loadSettings(env = process.env)` in `src/config/settings.ts`, so tests
 * never touch `process.env` directly). `KINTSUGI_MOCK_LLM=1` (trimmed exact)
 * returns the deterministic mock; otherwise a trimmed, lowercased
 * `LLM_PROVIDER` of `openrouter`/`deepseek` returns that provider when its
 * key (`OPENROUTER_API_KEY`/`DEEPSEEK_API_KEY`) is set; every other case
 * returns the zero-network off port. The pi-ai dependency is only loaded
 * inside the provider modules (lazy `await import`), so mock/off modes
 * never touch it.
 */
export function createLLM(env: NodeJS.ProcessEnv = process.env): LLMPort {
  if (trimmed(env.KINTSUGI_MOCK_LLM) === "1") {
    return new MockLLM(env);
  }
  const provider = trimmed(env.LLM_PROVIDER).toLowerCase();
  if (provider === "openrouter" && hasKey(env, "OPENROUTER_API_KEY")) {
    return new OpenRouterLLM(env);
  }
  if (provider === "deepseek" && hasKey(env, "DEEPSEEK_API_KEY")) {
    return new DeepSeekLLM(env);
  }
  return new OffLLM();
}

/** Single import point for traced composition (issue #18): the orchestrator
 * wraps its port via `withTraces`/`createTracedLLM` from here, so every
 * `submit_verdict` call is audited without touching the `LLMPort` shape. */
export { TracedLLM, withTraces, createTracedLLM, TRACE_TEXT_CAP } from "./traced.js";
export type { TracedOptions } from "./traced.js";
