/**
 * Pinned contract (issue #11): the diagnose stage of the repair loop.
 * `diagnose(llm, view)` builds the hardened prompt via
 * `buildDiagnosePrompt`, calls `submit_verdict("diagnose", prompt,
 * diagnoseVerdictSchema)`, validates the raw verdict with `Value.Check`,
 * throws loudly on mismatch, and returns the narrowed verdict. Never
 * mutates `view`.
 */

import { Value } from "@sinclair/typebox/value";
import type { LLMPort } from "../llm/port.js";
import { buildDiagnosePrompt } from "../llm/prompts.js";
import { diagnoseVerdictSchema, type DiagnoseVerdict } from "../llm/schemas.js";
import type { WorkflowView } from "../llm/workflowView.js";

/**
 * Run the diagnose stage: prompt the LLM with the hardened workflow-view
 * prompt and return the validated verdict.
 */
export async function diagnose(llm: LLMPort, view: WorkflowView): Promise<DiagnoseVerdict> {
  const prompt = buildDiagnosePrompt(view);
  const raw = await llm.submit_verdict("diagnose", prompt, diagnoseVerdictSchema);
  if (!Value.Check(diagnoseVerdictSchema, raw)) {
    throw new Error("diagnose: LLM verdict failed diagnoseVerdictSchema validation");
  }
  return raw as DiagnoseVerdict;
}
