/**
 * Pinned contract (issue #9): the `LLMPort` behind which all LLM inference
 * sits, so the E2E suite runs without credits and the live provider can be
 * swapped in later. `submit_verdict` is generic over the passed TypeBox
 * schema, so the returned object is already typed as matching that schema.
 * `createLLM` is the orchestrator switch-point: it returns the deterministic
 * mock now and picks the live Nebius provider once issue #10 lands.
 */

import type { Static, TSchema } from "@sinclair/typebox";
import { MockLLM } from "./mock.js";

/** Pipeline stages that ask the LLM for a verdict. */
export type LlmStage = "diagnose" | "patch" | "judge";

/** Which implementation served the verdict: mock (no credits) or live. */
export type LlmMode = "mock" | "live";

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
 * Orchestrator switch-point with an injectable env map (mirroring
 * `loadSettings(env = process.env)` in `src/config/settings.ts`, so tests
 * never touch `process.env` directly). Always returns the mock until the
 * live Nebius provider lands in issue #10.
 */
export function createLLM(env: NodeJS.ProcessEnv = process.env): LLMPort {
  return new MockLLM(env);
}
