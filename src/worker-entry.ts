/**
 * Worker entrypoint wiring (issue #22): loads `Settings` once, opens the
 * file-backed store, picks the LLM solely via `NEBIUS_API_KEY` presence, and
 * starts the repair-loop poller from `src/orchestrator/worker.ts`.
 * `kintsugi worker` runs `main()` below; the module stays import-safe under
 * vitest (nothing polls on import).
 */

import { pathToFileURL } from "node:url";
import { loadSettings } from "./config/settings.js";
import { createLLM } from "./llm/port.js";
import { createOrchestrator } from "./orchestrator/orchestrator.js";
import { startWorker } from "./orchestrator/worker.js";
import { openStore } from "./store/store.js";

export interface WorkerEntry {
  stop(): void;
}

/**
 * Wire and start the repair loop. The poller from `worker.ts` unrefs its own
 * timer, so this holds the process open with a slow ref'd watchdog that
 * `stop()` clears alongside the store.
 */
export function startWorkerEntry(): WorkerEntry {
  const settings = loadSettings();
  const store = openStore(settings.dbPath ?? "kintsugi.db");
  // Mock vs Nebius is decided solely by NEBIUS_API_KEY presence (see port.ts).
  const llm = createLLM(process.env);
  const orchestrator = createOrchestrator({ store, llm, settings });
  const handle = startWorker(orchestrator, store);
  const keepAlive = setInterval(() => undefined, 60_000);
  let stopped = false;
  return Object.freeze({
    stop(): void {
      if (stopped) return;
      stopped = true;
      handle.stop();
      clearInterval(keepAlive);
      store.close();
    },
  });
}

export function main(): WorkerEntry {
  const entry = startWorkerEntry();
  const shutdown = (): void => {
    try {
      entry.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  console.log("kintsugi worker polling for repair events");
  return entry;
}

// Run the loop only when executed directly (`node dist/src/worker-entry.js`
// or via `kintsugi worker`), never when imported by tests or other modules.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
