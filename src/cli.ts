#!/usr/bin/env node
/**
 * `kintsugi` CLI entrypoint (issues #21/#22): one binary, multiple commands.
 *   kintsugi api        — serve the receiver dashboard + webhook API.
 *   kintsugi worker     — run the repair-loop poller until SIGINT/SIGTERM.
 *   kintsugi fix <id>   — not yet wired (stub: stderr message, exit 1).
 *   kintsugi seed-demo  — run the demo seeder (issue #21): prints exactly two
 *     lines to stdout (`demo <id>`, `error-trigger <id>`) and exits 0.
 *     Missing n8n configuration exits 2 with a message on stderr.
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadSettings } from "./config/settings.js";
import { N8nClient } from "./n8n/client.js";
import { seedDemo } from "./seeding/seedDemo.js";
import { openStore } from "./store/store.js";

const DEFAULT_MOCK_UPSTREAM_URL = "http://localhost:3001";

export async function runSeedDemo(): Promise<void> {
  const settings = loadSettings();
  if (settings.n8nBaseUrl === undefined || settings.n8nApiKey === undefined) {
    console.error("kintsugi seed-demo: N8N_BASE_URL and N8N_API_KEY must both be set");
    process.exit(2);
  }
  const mockUpstreamUrl = settings.mockUpstreamUrl ?? DEFAULT_MOCK_UPSTREAM_URL;
  // Blank publicUrl falls back to localhost:<port> so local runs need no env.
  const hookBase = settings.publicUrl ?? `http://localhost:${settings.port}`;
  const errorHookUrl = `${hookBase.replace(/\/+$/, "")}/error-hook`;
  const store = openStore(settings.dbPath ?? "kintsugi.db");
  try {
    const client = new N8nClient({ baseUrl: settings.n8nBaseUrl, apiKey: settings.n8nApiKey });
    const { demoWorkflowId, errorTriggerWorkflowId } = await seedDemo({
      client,
      store,
      mockUpstreamUrl,
      errorHookUrl,
    });
    console.log(`demo ${demoWorkflowId}`);
    console.log(`error-trigger ${errorTriggerWorkflowId}`);
  } finally {
    store.close();
  }
}

function usage(): void {
  console.error("usage: kintsugi <api|worker|fix <event-id>|seed-demo>");
}

/**
 * Direct-execution guard that survives bin symlinks: `argv[1]` keeps the
 * symlink path while `import.meta.url` carries the resolved real path, so a
 * naive equality check silently skips `main()` when invoked as `kintsugi`.
 */
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const subcommand = argv[2];
  if (subcommand === "api") {
    // Serve the receiver dashboard + webhook API (mirrors `node dist/src/receiver/app.js`).
    const { main: serveApi } = await import("./receiver/app.js");
    serveApi();
    return;
  }
  if (subcommand === "worker") {
    // Run the repair-loop poller until SIGINT/SIGTERM.
    const { main: serveWorker } = await import("./worker-entry.js");
    serveWorker();
    return;
  }
  if (subcommand === "seed-demo") {
    await runSeedDemo();
    return;
  }
  if (subcommand === "fix") {
    // Single-event repair wiring is later-slice territory; the stub pins the
    // contract (stderr message, non-zero exit) without faking a repair.
    console.error("kintsugi fix: not yet wired");
    process.exit(1);
    return;
  }
  usage();
  process.exit(2);
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    console.error(`kintsugi seed-demo: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
