# Kintsugi

**Self-repairing agent for n8n** — *every break becomes a golden seam.*

Kintsugi watches failed n8n executions, diagnoses the root cause with an LLM, patches the workflow JSON, **verifies the patch by replaying the original failed payload in a sandbox**, then auto-promotes low-risk fixes or parks riskier ones for human approval. One-click revert is always available.

Built for the **Nebius x NVIDIA Global AI Hackathon**.

Verified runtime: Node 22, `npm ci && npm run build && node dist/src/receiver/app.js`, readiness probe `GET /healthz`.

## Quickstart

1. `git clone https://github.com/techafreshh/kintsugi.git && cd kintsugi`
2. `npm ci`
3. `npm run build`
4. `node dist/src/receiver/app.js`
5. `curl -i http://127.0.0.1:8080/healthz`
   - Expect HTTP 200 with body exactly `{"ok":true}`.
6. `./bin/kintsugi worker`
   - Run in a second terminal; starts the repair-loop poller against the same store.
7. `N8N_BASE_URL=https://n8n.example.com N8N_API_KEY=... ./bin/kintsugi seed-demo`
   - Installs the demo workflows; prints exactly two lines (`demo <id>`, `error-trigger <id>`).
8. `docker compose --profile dev up --build`
   - All-in-one demo instead of steps 4-7: receiver API, worker, mock upstream, plus n8n.

## Architecture

```text
n8n Error Trigger
       │  POST /error-hook
       ▼
src/receiver/app.ts ──► src/store/store.ts ──► repair event persisted
       │                        ▲
       │ JSON API feed          │ worker repair loop
       │ + approve/reject/      │ src/orchestrator/
       │   revert (token-gated) │   orchestrator.ts + worker.ts
       ▼                        │
   placeholder shell      detect → diagnose → patch → sandbox verify
   (public/)              (view)  (LLM)      (code)  (src/sandbox/)
                                                     │
                              ┌──────────────────────┘
                              ▼
                    src/pipeline/tier.ts  →  FLAG-ONLY / APPROVE / AUTO-PROMOTE
                    src/pipeline/gates.ts →  escalate-only gates
                              │
                    ┌───────────┴───────────┐
                    ▼                       ▼
              auto-promote            approve → human (dashboard / Telegram)
              (patch applied,                │
               revert available)              ▼
                                   src/receiver/app.ts revert
```

How it works: every failed execution lands in the store via `POST /error-hook`. The worker loop picks the event up, builds a credential-free workflow view, asks the LLM for a diagnosis and a minimal patch (affected nodes only, resolvable paths, exact-diff checked), replays the captured payload through a sandbox copy of the workflow, and verifies the result. The deterministic tier classifier then decides: safe, verified patches auto-promote; anything touching code, logic, credentials, or external effects parks in `awaiting-approval` for a human; doubt always escalates. A baseline snapshot is kept so any promoted change can be reverted.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Readiness probe → `200 {"ok":true}` |
| `POST` | `/error-hook` | n8n Error Trigger entry; persists the event, idempotent per execution id → `200 {"ok":true,"event_id":"<id>","created":<bool>}` (repeat posts return `created:false`) |
| `GET` | `/repair-events` | Feed list; optional `?status=` filter → `200 {"events":[...]}` |
| `GET` | `/repair-events/:id` | Detail: event plus `tier` and `verification` blocks; unknown id → `404` |
| `POST` | `/repair-events/:id/approve` | Promote the parked fix; token-gated (`401` without `Authorization: Bearer <token>` when `DASHBOARD_TOKEN` is set) |
| `POST` | `/repair-events/:id/reject` | Reject the parked fix; token-gated |
| `POST` | `/repair-events/:id/revert` | Restore the baseline snapshot; token-gated |
| `POST` | `/telegram/webhook` | Telegram approval callbacks; `200 {"ok":true}` on valid updates (400 on malformed JSON; orchestrator failures still answer 200 so Telegram does not retry) |
| `GET` | `/` | Placeholder dashboard shell (`public/index.html`; `npm run build` copies `public/` to `dist/`); `404` JSON when no built page is present |

Contract notes: unknown routes return JSON `404` (never 5xx); malformed JSON bodies return `400` (never 500, never hang). Detail responses alias the wire status `awaiting-approval` to `awaiting_approval` and the classifier tier `auto-promote` to `auto`. The detail `verification` block is `{ok, strategy, rowCount, provenance, reason}` — `ok` is true exactly when a `verified` verdict exists for the event.

## Dashboard

`GET /` serves the placeholder shell from `public/index.html` ("Repair events API is running. See `/repair-events`") — there is no feed/detail UI yet. The event feed, per-event detail (diagnosis, workflow diff, sandbox verification log, per-event agent traces from `llm_traces`), and the approve/reject/revert mutations all live on the JSON API: `GET /repair-events`, `GET /repair-events/:id`, and the token-gated `POST /repair-events/:id/approve|reject|revert` endpoints. The feed endpoints are publicly viewable; the mutation endpoints require `Authorization: Bearer <token>` matching `DASHBOARD_TOKEN` when it is set (unset means open for local use).

## Tiers

Deterministic risk classification from the judge verdict alone (`src/pipeline/tier.ts`); the four gates (`src/pipeline/gates.ts`) are escalate-only — an LLM suggestion to lower a tier is ignored and recorded as `overruled: true`.

| Tier | Meaning |
|---|---|
| `flag-only` | Observe only. No patch is proposed or applied (for example auth/credential issues — credentials are never read, exported, or modified). |
| `approve` | Parked in `awaiting-approval` for a human. Any approve-flag (`touches-code`, `touches-logic`, `adds-node`, `removes-node`, `large-diff`, `touches-credentials`, `touches-trigger`, `touches-webhook`, `sends-external`, `deletes-data`) or `requiresApproval: true` lands here. Approve, reject, and revert from the dashboard or a Telegram card. |
| `auto-promote` | Sandbox-verified safe patch applied automatically (shown as `auto` in detail JSON). Requires all-safe flags (`safe-value-fix`, `safe-expression-fix`, `retry-backoff`, `on-error-continue`), `scope: affected-nodes-only`, `reversible: true`, confidence `>= 0.8`, a passing verification, and patch similarity `>= 0.8`. |
| `escalate` | Strictest outcome and the default on doubt: unknown flags, mixed safe+approve flags, low or missing confidence, or malformed verdicts all escalate. |

Promotion additionally withholds `auto-promote` unless the classifier tier itself is `auto-promote`, verification has not failed, and patch similarity meets the threshold; the iteration gate returns `retry` while verification is pending and terminal `give-up` after 3 unsuccessful attempts.

## Demo scenarios

The mock upstream (`src/mockupstream/app.ts`) drives the demo workflow's HTTP node: `GET /api/users` serves user rows, `GET /chaos` shows the chaos state, `POST /chaos` sets it (`schema: "old" | "new"`, `fail_next` countdown, `fail_status`), and `GET /healthz` is the readiness probe.

- Scenario 1 — schema drift (`e2e/scenario1.test.ts`): upstream switches to the new schema while the Set node still maps old field names. The worker proposes a Set-only patch, sandbox replay goes green, tier `auto` → promoted.
- Scenario 2 — transient 429/502 (`e2e/scenario2.test.ts`): upstream fails the next N calls, then recovers. The worker proposes a retry/backoff patch, verification runs fail-then-pass, tier `auto` → promoted.
- Scenario 3 — human broke the Code node (`e2e/scenario3.test.ts`): a hand edit breaks validation. The worker restores from the baseline snapshot, sandbox verifies, tier `approve` → parked in `awaiting-approval` until a human approves via the token-gated endpoint.

## Configuration

Every variable is optional: unset (or blank) disables the feature that uses it, never the process. Copy `.env.example` to `.env` (`node --env-file=.env ...`) — blank means unset, with the per-variable fallback noted below.

| Variable | Default when blank | Purpose |
|---|---|---|
| `PORT` | `8080` (via `KINTSUGI_PORT`, then `8080`) | Receiver port. Precedence: `PORT`, then `KINTSUGI_PORT`, then `8080`; blank or invalid values fall through instead of crashing startup. |
| `KINTSUGI_PORT` | `8080` | Second-preference receiver port, same fall-through semantics. |
| `DASHBOARD_TOKEN` | unset (open locally) | Bearer token guarding dashboard mutations (`Authorization: Bearer <token>`); unset disables auth for local use. |
| `NEBIUS_API_KEY` | unset (LLM repair off) | Nebius credentials; unset disables all LLM-backed repair flows. |
| `NEBIUS_BASE_URL` | built-in default | Override of the provider API base URL. |
| `MODEL_FAST` | unset | Model id for the fast role; used verbatim. |
| `MODEL_REASON` | unset | Model id for the reasoning role; used verbatim. |
| `MODEL_JUDGE` | unset | Model id for the judge role; used verbatim. |
| `TELEGRAM_BOT_TOKEN` | unset (notifier off) | Telegram bot credentials; either one unset keeps the notifier off. |
| `TELEGRAM_CHAT_ID` | unset (notifier off) | Telegram chat target; either one unset keeps the notifier off. |
| `TELEGRAM_NOTIFIER_ENABLED` | off | Opt-in Tier-2 approval cards. Only the exact value `true` (trimmed, case-insensitive) enables sends; anything else keeps the notifier off with zero outbound calls. |
| `TELEGRAM_API_BASE_URL` | built-in `https://api.telegram.org` | Override for tests pointing at a stub server. |
| `KINTSUGI_DB_PATH` | `kintsugi.db` in the working directory | SQLite file for repair events, snapshots, decisions, LLM traces, and metrics. Use `:memory:` only for scratch/testing. |
| `N8N_BASE_URL` | unset (n8n flows off) | n8n instance root URL (the client appends `/api/v1`); both this and `N8N_API_KEY` blank keeps every n8n-backed flow off. |
| `N8N_API_KEY` | unset (n8n flows off) | n8n API key sent as `X-N8N-API-KEY` on every client request. |
| `MOCK_UPSTREAM_URL` | seeder default `http://localhost:3001` | Mock-upstream root driving the demo workflow HTTP node (`<base>/api/users`). |
| `KINTSUGI_PUBLIC_URL` | `http://localhost:<port>` | Public Kintsugi root used to build the error-trigger `/error-hook` target. |

## Security

- Sanitizer boundary before any LLM prompt (`src/security/sanitize.ts`): strips invisible and Bidi-override characters, normalizes homoglyph confusables, flags instruction-shaped lines. A hostile upstream API must not steer the diagnoser.
- Credential redaction (`src/security/redact.ts`): secret-shaped strings (JWTs, provider keys, `Bearer` values, `password=`/`token=`/`apiKey=` assignments) become `[REDACTED]`; every `credentials` key is dropped from workflow views sent to the LLM, snapshots, or the dashboard. Credentials are never read, exported, or modified.
- Secrets live in `.env` only (`NEBIUS_API_KEY`, `N8N_API_KEY`, `TELEGRAM_BOT_TOKEN`); never logged, never committed. `.gitignore` and `.dockerignore` both exclude `.env`, databases, and runtime data.
- Sandbox safety: HTTP-node hosts are checked against an egress allowlist (warn-only finding on the result); the sandbox workflow copy is deleted after verification unless explicitly kept.
- Dashboard/API auth: the `GET /` shell and feed endpoints are publicly viewable; approve, reject, and revert require `DASHBOARD_TOKEN` when set.
- Patches are applied by code and validated: only affected nodes, only resolvable paths, exact-diff check — unrelated-node edits are rejected.

## Docker

One image (`kintsugi:latest`), multiple commands:

- `docker build -t kintsugi:latest .` — builds from Node 22 (builder) to `node:22-slim` (runner).
- `docker run kintsugi:latest kintsugi api` — receiver dashboard + webhook API (the default command).
- `docker run kintsugi:latest kintsugi worker` — repair-loop poller.
- `docker run kintsugi:latest mock-upstream` — chaos mock upstream.

Compose profiles (`docker-compose.yml`):

- `docker compose --profile dev up --build` — all-in-one demo: `api`, `worker`, `mock-upstream`, plus real n8n (dev-profile only, never deploy).
- `docker compose --profile deploy up --build` — no n8n; `api` + `worker` join the existing external `web_gateway` network (create it first with `docker network create web_gateway` if missing).

All kintsugi services read the same optional `.env` file (a missing file is fine — every variable falls back to its default). Ports publish on loopback only (`127.0.0.1:${PORT:-8080}:8080`, `127.0.0.1:${MOCK_UPSTREAM_PORT:-3001}:3001`); `api` and `mock-upstream` carry container healthchecks against their `/healthz` endpoints.

## CLI

One binary, four subcommands (`src/cli.ts`, `bin/kintsugi`):

- `kintsugi api` — serve the receiver dashboard + webhook API (mirrors `node dist/src/receiver/app.js`).
- `kintsugi worker` — run the repair-loop poller until `SIGINT`/`SIGTERM`.
- `kintsugi fix <event-id>` — inline single-event repair: runs the full repair turn for one stored event and prints a verdict report; exit `0` when the turn completes, `1` on error.
- `kintsugi seed-demo` — install the demo workflows into the configured n8n; prints exactly two lines to stdout (`demo <id>`, `error-trigger <id>`) and exits `0`. Missing n8n configuration exits `2` with a message on stderr.

## Troubleshooting

- Wrong port? Binding precedence is `PORT`, then `KINTSUGI_PORT`, then `8080` — blank or invalid values fall through to the next source instead of crashing, so check for typos (`PORT=abc` silently falls through).
- Empty feed? Events only appear after `POST /error-hook` fires — `curl` a failing execution payload at it, or run `seed-demo` plus the mock upstream. Unknown routes and ids return JSON `404`, never 5xx, so a `404` means "nothing stored yet", not a crash.
- Database confusion? The default store is the `kintsugi.db` file in the working directory; set `KINTSUGI_DB_PATH` to share one file between the API and worker (compose mounts `/data/kintsugi.db`). Use `:memory:` only for scratch runs and tests — nothing persists.
- Telegram silent? It is off by default: it needs `TELEGRAM_BOT_TOKEN` **and** `TELEGRAM_CHAT_ID` **and** `TELEGRAM_NOTIFIER_ENABLED=true` (exact value, case-insensitive). Anything else means zero outbound calls — check the spelling of `true`.
- n8n calls failing? Both `N8N_BASE_URL` and `N8N_API_KEY` must be set; either one blank keeps every n8n-backed flow (seeder, `fix`, worker promotion) off. The client appends `/api/v1`, so the base URL must be the instance root.
- Mutations return `401`? Set `Authorization: Bearer <token>` matching `DASHBOARD_TOKEN`; when the token var is unset, auth is open for local use.

## License

MIT — see [LICENSE](LICENSE).
