/**
 * Pinned contract (issue #16): thin polling worker over the orchestrator.
 * `runOnce` sweeps queued (`received` + `pending`) repair events through
 * `runRepairTurn` sequentially (one event failure never stops the loop);
 * `startWorker` repeats that sweep on an interval. Import-safe under vitest:
 * the file only polls when executed directly (`node dist/src/...`), never on
 * import.
 */

import { pathToFileURL } from "node:url";
import type { Store } from "../store/store.js";
import type { Orchestrator } from "./orchestrator.js";

export interface WorkerOptions {
  intervalMs?: number;
  batchSize?: number;
}

export interface WorkerHandle {
  stop(): void;
}

type RunnableOrchestrator =
  | Orchestrator
  | { runRepairTurn(eventId: string): Promise<unknown> }
  | { runRepairTurn(eventId: string): unknown };

function queuedEvents(store: Store, batchSize: number): Array<{ executionId: string }> {
  const seen = new Set<string>();
  const queued: Array<{ executionId: string }> = [];
  for (const status of ["received", "pending"] as const) {
    let events: Array<{ executionId: string }> = [];
    try {
      if (typeof (store as unknown as { listEventsByStatus?: unknown }).listEventsByStatus === "function") {
        events = (store as unknown as { listEventsByStatus(status: string): Array<{ executionId: string }> }).listEventsByStatus(status);
      } else {
        events = store.listEvents().filter((event) => event.status === status);
      }
    } catch {
      events = [];
    }
    for (const event of events) {
      if (seen.has(event.executionId)) continue;
      seen.add(event.executionId);
      queued.push(event);
      if (queued.length >= batchSize) return queued;
    }
  }
  return queued;
}

/**
 * Run one sweep: every queued event through `runRepairTurn` in order.
 * Per-event errors are swallowed (the turn already parks failures as
 * `failed`); a missing `runRepairTurn` throws loudly.
 */
export async function runOnce(
  orchestrator: RunnableOrchestrator,
  store: Store,
  opts?: WorkerOptions,
): Promise<{ processed: number; failed: number }> {
  const batchSize = opts?.batchSize ?? 25;
  const run = (orchestrator as { runRepairTurn?: unknown }).runRepairTurn;
  if (typeof run !== "function") throw new Error("worker: orchestrator is missing runRepairTurn");
  const queued = queuedEvents(store, batchSize);
  let processed = 0;
  let failed = 0;
  for (const event of queued) {
    try {
      await (run as (eventId: string) => Promise<unknown>).call(orchestrator, event.executionId);
      processed += 1;
    } catch {
      failed += 1;
    }
  }
  return { processed, failed };
}

/**
 * Start the polling loop. Uses `setInterval(...).unref?.()` so the worker
 * never holds the process open on its own; `stop()` clears the interval.
 */
export function startWorker(
  orchestrator: RunnableOrchestrator,
  store: Store,
  opts?: WorkerOptions,
): WorkerHandle {
  const intervalMs = opts?.intervalMs ?? 1000;
  const timer = setInterval(() => {
    void runOnce(orchestrator, store, opts).catch(() => undefined);
  }, intervalMs);
  const unref = (timer as unknown as { unref?: () => void }).unref;
  if (typeof unref === "function") unref.call(timer);
  return Object.freeze({
    stop(): void {
      clearInterval(timer);
    },
  });
}

/** Alias for callers importing the stop handle under another name. */
export const stopWorker = (handle: WorkerHandle): void => handle.stop();

function main(): void {
  // Entrypoint wiring (db path, LLM, n8n) lands with the later
  // `node dist/src/worker/app.js` slicing item; this guard only keeps the
  // module import-safe while documenting the intended entrypoint.
}

// Run the loop only when executed directly, never when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
