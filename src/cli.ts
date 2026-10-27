#!/usr/bin/env node
/**
 * `kintsugi` CLI entrypoint (issue #21): wires real `N8nClient` + `openStore`
 * from `Settings` and runs the demo seeder. Usage:
 *   kintsugi seed-demo
 * Prints exactly two lines to stdout (`demo <id>`, `error-trigger <id>`) and
 * exits 0. Missing n8n configuration exits 2 with a message on stderr.
 */

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
  console.error("usage: kintsugi seed-demo");
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const subcommand = argv[2];
  if (subcommand === "seed-demo") {
    await runSeedDemo();
    return;
  }
  usage();
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`kintsugi seed-demo: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
