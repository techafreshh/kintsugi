# PRD — Kintsugi

**Self-repairing agent for n8n** — *every break becomes a golden seam.*

**Status:** Approved · **Date:** 2026-10-26 · **Deadline:** 2026-10-30, 6:00pm WAT (10:00am PDT)
**Context:** Nebius x NVIDIA Global AI Hackathon (Devpost). Fresh repo at `/home/techafresh/projects/kintsugi`.
**Stack decision (v2):** TypeScript on the **Pi SDK** (`@earendil-works/pi-ai`), replacing the earlier Python plan (scaffold deleted by choice; design carried over).

---

## 1. Executive Summary

Kintsugi is a self-repairing agent for n8n. It watches failed workflow executions, diagnoses the root cause with an LLM, writes a patch to the workflow JSON, verifies the patch by re-running the original failed payload in a sandbox, and then either auto-promotes low-risk fixes or requests human approval for riskier ones. One-click revert is always available — every promotion stores the prior workflow snapshot, so a bad promotion is never worse than the original break.

The core value proposition: automation owners treat n8n workflows like production systems, but nothing repairs them like production systems. Kintsugi closes the loop — detect (error hook), diagnose (LLM), patch (sandboxed), verify (re-run original payload), promote (tiered), revert (one click). Verification against the *original failing payload* is the differentiator: no patch touches production without a green re-run. A full **agent trace** — what each LLM stage saw and decided — is recorded and shown on the dashboard, making every automated decision auditable.

**MVP goal:** a working demo of all three scripted scenarios (schema drift → auto-promote, transient 429/502 → retry/backoff → auto-promote, human-broke-it → approval path) against a real n8n instance, with a one-page dashboard, a public repo, and a ≤3-minute demo video. Hackathon build: scope fixed, polish concentrated on the dashboard and the repair loop.

## 2. Mission

**Mission:** every workflow failure becomes a golden seam — a repaired, documented, verified improvement rather than a page-to-human.

**Core principles**

1. **Verify before write.** No patch touches production without a green sandbox re-run of the original failing payload.
2. **Risk is deterministic.** Tier classification (flag-only / approve / auto-promote) is computed from code, never by an LLM. Decision gates can only escalate, never loosen.
3. **Untrusted input is hostile.** Every payload/error text passes a sanitizer boundary before touching any LLM prompt. Credentials never enter the repairer at all.
4. **The LLM never authors n8n JSON.** It reads a compact view and answers with path-level operations; code applies and validates them.
5. **Reversibility always.** Every write is snapshot-protected; revert is one click, on any tier.
6. **Boring is reliable.** One dashboard page, one SQLite file, one deploy command.

## 3. Target Users

| Persona | Who they are | Technical comfort | Pain points |
|---|---|---|---|
| **Solo automation operator** (primary; the builder) | Runs a personal n8n instance (n8n.techa.pro on a VPS) with YouTube/content automation pipelines | High — Docker, VPS, APIs, Node | Failures discovered late; manual diffing of execution data; fear of hand-editing workflow JSON |
| **Hackathon judges / reviewers** | Evaluate the Devpost submission; want a working demo URL, clean repo, 3-minute video | High | Need the value in one screen; skeptical of demos without real verification |

Key needs: failures surface automatically with a diagnosis; low-risk fixes happen without human involvement; risky fixes wait for approval with an understandable diff; any change is instantly reversible; every automated decision is inspectable (agent traces).

## 4. MVP Scope

### In Scope

**Core functionality**
- [x] `POST /error-hook` endpoint called by n8n's Error Trigger workflow on every failed execution
- [x] Repair pipeline: fetch execution + workflow → snapshot → sanitize → diagnose → patch → verify → tier → act
- [x] Sandbox verification: workflow copy with production trigger replaced by a pinned manual trigger, re-executed with the original captured payload; ≤3 patch iterations
- [x] Deterministic tier classification: FLAG-ONLY / APPROVE / AUTO-PROMOTE
- [x] Four escalate-only LLM decision gates (triage, patch review, promotion, iteration)
- [x] One-click revert to the pre-promotion snapshot
- [x] CLI: `kintsugi fix <execution-id>` + `kintsugi seed-demo` + `api` / `worker` entrypoints
- [x] Demo workflow with chaos toggles + mock upstream chaos service; error-trigger workflow; seeder

**Surfaces**
- [x] One-page dashboard: repair-event feed + detail view with side-by-side JSON diff, verification log, **and agent traces**; approve/reject/revert actions
- [x] Telegram notifier (flag-gated, shipped disabled): Tier-2 approval cards with inline Approve/Reject buttons

**Technical**
- [x] SQLite store (node:sqlite): snapshots, repair events, decisions, agent traces, metrics
- [x] LLM layer on pi-ai: Nebius custom provider (all inference), mock port, TypeBox-validated verdicts
- [x] Sanitizer boundary + secret redaction in snapshots/LLM payloads/dashboard display
- [x] Sandbox egress allowlist check; sandbox webhook secret
- [x] docker-compose: dev profile (all-in-one with throwaway n8n) and deploy profile (joins existing `web_gateway` network)
- [x] **Factory compose contract:** the compose file defines a service named **`worker`** (the environment stages run in) and the API service publishes its port on `127.0.0.1`; the API binds the `PORT` env var (fallback `KINTSUGI_PORT`, default 8080). **Service start contract:** the API is started with `npm ci && npm run build && node dist/src/receiver/app.js`; readiness path is `GET /healthz`.
- [x] **CI workflow** (`.github/workflows/ci.yml`): typecheck + tests on every PR (shipped by the walking-skeleton lap)
- [x] MIT license, README (setup ≤10 steps, architecture diagram, tier table, security section)

### Out of Scope

- [ ] Multi-tenancy, roles/permissions, SSO; production auth (single shared-token gate on mutations only)
- [ ] Credential management (never read/exported/modified)
- [ ] Workflow creation from scratch; anything beyond one dashboard page
- [ ] Editing n8n's global settings; touching workflows that don't arrive via the error hook
- [ ] `classify()`-style classifier APIs (OpenAI Decisions, TypeSafe Jev) — documented post-hackathon upgrade path, not shipped (all inference must be Nebius)

## 5. User Stories

1. **As an automation operator,** when my workflow fails at 3am, I want Kintsugi to diagnose and (if safe) auto-fix it, so my morning pipeline runs without me. *Example:* upstream renames `video_url` → `videoUrl`; Kintsugi patches the Set mapping, verifies against the original payload, auto-promotes.
2. **As a cautious operator,** I want risky fixes parked with a diff and an approve button, so nothing dangerous is written without my eyes. *Example:* a human broke the Code validator; the fix touches Code → approval path.
3. **As an operator,** I want one-click revert, so a bad promotion is never worse than the original break.
4. **As a security-conscious user,** I want untrusted payloads sanitized before any LLM call, so a hostile upstream can't hijack the diagnoser.
5. **As a debugging operator,** I want agent traces, so I can see exactly what the diagnoser/patcher/gates saw and decided at every stage. *Example:* the trace shows the triage gate escalated because confidence was 0.4.
6. **As an automation engineer,** I want `kintsugi fix <execution-id>`, so I can run repairs manually or re-run a failed repair.
7. **As a hackathon judge,** I want the failure → diagnosis → verification → promotion flow visible end-to-end in one page.
8. **As a self-hoster,** I want `docker compose --profile dev up` to bring up the full stack in ≤10 steps.
9. **Technical:** the repairer must capability-detect `POST /workflows/{id}/run`; if unavailable, fall back to a webhook-trigger sandbox copy fed the captured payload.
10. **Technical:** every promotion stores a pre-change snapshot enabling revert.

## 6. Core Architecture & Patterns

| Component | What it does |
|---|---|
| **receiver** | hono HTTP app: `POST /error-hook`, repair-events API, dashboard + static assets, mutation token gate |
| **repairer** | Worker loop polling the store: fetch → snapshot → sanitize → diagnose → patch → verify → tier → act; also `kintsugi fix` |
| **sandbox** | Verification harness: workflow copy, trigger swap, replay of captured payload, schema-expectation verification, ≤3 iterations |
| **dashboard** | One htmx page: feed + detail (diagnosis, diff, verification log, agent traces, actions) |
| **notifier** | Telegram bot, flag-gated; Tier-2 cards with inline Approve/Reject |
| **store** | SQLite (node:sqlite): repair events, workflow snapshots, decisions, llm_traces, metrics |

**Design patterns**

- One TS package, three entrypoints (`api`, `worker`, `mock-upstream` bin) sharing store/clients; two containers from one image.
- **Pipeline orchestrator:** stages persist state so every step is auditable on the dashboard.
- **LLM boundary:** all inference behind one `LLMPort` interface — Nebius implementation (pi-ai custom provider) + mock implementation; verdicts TypeBox-validated via a `submit_verdict` tool call (text-JSON fallback).
- **n8n-JSON boundary:** `workflow-view.ts` (compact LLM view incl. failing-node inputs + last-known-good diff) in; `patch-ops.ts` (path-level ops, validated application) out.
- **Dual-profile compose:** dev (all-in-one) / deploy (external `web_gateway` network on the VPS).

**Directory structure**

```
kintsugi/
├── LICENSE (MIT) · README.md · .env.example · .gitignore
├── package.json · tsconfig.json · vitest.config.ts
├── Dockerfile · docker-compose.yml
├── src/
│   ├── cli.ts              # bins: kintsugi api | worker | fix <exec-id> | seed-demo
│   ├── config.ts           # env parsing (dotenv-lite)
│   ├── store.ts            # node:sqlite — events, snapshots, decisions, llm_traces, metrics
│   ├── sanitizer.ts        # invisible chars, homoglyphs, injection-shaped lines
│   ├── redact.ts           # secret-shaped strings; credentials blocks
│   ├── diff.ts             # node-level workflow diff + changed-line count
│   ├── workflow-view.ts    # "n8n skill": raw JSON + runData → compact LLM view
│   ├── patch-ops.ts        # LLM ops → validated path-level edits; rewiring in code
│   ├── n8n-client.ts       # public API client + run-endpoint capability probe
│   ├── tiers.ts            # deterministic tier classifier
│   ├── gates.ts            # 4 escalate-only decision gates
│   ├── diagnose.ts  patch.ts  repair.ts  notifier.ts  prompts.ts
│   ├── llm/
│   │   ├── port.ts         # LLMPort interface + TypeBox verdict schemas
│   │   ├── nebius.ts       # pi-ai createProvider() — Nebius Token Factory
│   │   └── mock.ts         # deterministic scenario-aware rules
│   ├── sandbox/{harness.ts, verify.ts}
│   ├── receiver/{app.ts, static/index.html}
│   └── seed/               # demo-chaos.json, error-trigger.json, seeder
├── mock-upstream/main.ts   # chaos upstream (bin: kintsugi-mock-upstream)
└── test/                   # vitest suites
```

## 7. Tools / Features

### 7.1 Repair pipeline
receive (webhook or CLI) → fetch execution (with data) + workflow → snapshot → sanitize all untrusted text → **diagnose** (`MODEL_FAST`: `failure_class`, `root_cause`, `affected_nodes`, `confidence`, `recommended_fix`, `complex`) → **triage gate** → **patch** (`MODEL_REASON` if complex/`MODEL_FAST` if not; path-level ops; only affected nodes; loud rejection otherwise) → **patch-review gate** → **sandbox verify** (≤3 iterations, each failure fed back; iteration gate between attempts) → **deterministic tier** → **promotion gate** (auto tier only) → **act** (auto-promote / park for approval / flag-only) → notify + metrics. Promotion snapshots pre-change state for revert.

### 7.2 Deterministic tier rules (no LLM)

| Tier | Triggered by | Action |
|---|---|---|
| **FLAG-ONLY** (never write) | Credentials, webhook URLs, trigger nodes, send/delete-capable nodes (email send, external POST/DELETE, cleanup) | Diagnosis + recommendation only |
| **APPROVE** | Code nodes, IF/Switch logic, node add/remove, any diff > ~40 lines | Parked for approval (dashboard + Telegram) |
| **AUTO-PROMOTE** | Set/Assign expression/value fixes, retry/backoff (`retryOnFail`, `maxTries`, `waitBetweenTries`), `onError: continue` — only when verification is green | PUT updated workflow, log, notify |

When in doubt, escalate to the stricter tier.

### 7.3 Sandbox verification
Copy with production trigger → pinned manual trigger + `pinData` payload; primary execution via `POST /workflows/{id}/run` (capability-probed), fallback: webhook trigger with unique path + secret header (activate → POST → deactivate). Never left activated; deleted unless `KINTSUGI_KEEP_SANDBOX=1`. Expectations derived from the workflow's most recent **successful** execution (types, record counts, null-rate); LLM-proposed fallback when no prior success. Static egress check against `SANDBOX_EGRESS_ALLOWLIST` before running.

### 7.4 Workflow translation layer (the "n8n skill")
The LLM never reads or writes raw n8n JSON. **`workflow-view.ts`**: compact view — node list (name, short type, redacted/truncated params), edge list, failing node's actual input data, last-known-good diff (with old/new values). **`patch-ops.ts`**: ops (`set_parameter`, `set_expression`, `set_retry`, `set_on_error`, `add_node`, `remove_node`); applied only if the path resolves; final diff must contain exactly the requested edits; node renames disallowed (connections are keyed by name); add/remove rewiring handled in code. The sandbox remains the ground-truth schema validator.

### 7.5 LLM decision gates (`gates.ts`)
`MODEL_JUDGE` (Nano-class, defaults to `MODEL_FAST`) returns `{verdict, reason, confidence}` at four points: **triage** (proceed/flag_only/needs_more_info), **patch review** (proceed/reject), **promotion** (promote/escalate), **iteration** (retry/escalate). Escalate-only — the deterministic tier classifier stays the final authority. ~4 small calls per repair.

### 7.6 Agent traces
Every LLM call records: stage, model, llm_mode (nebius/mock), duration, tokens in/out, prompt text (capped 32KB), response text (capped 32KB), parsed verdict, error. Rendered on the dashboard detail as a chronological expandable timeline. This is the audit trail that makes the automation trustworthy.

### 7.7 Dashboard
One dark-themed page, htmx (vendored locally): metrics chips; feed with status pills (received/diagnosing/verifying/awaiting_approval/promoted/failed/flagged/rejected/reverted); detail pane = diagnosis, tier + reasons, side-by-side diff, verification log, agent traces, approve/reject/revert buttons. Token from localStorage sent as `X-Kintsugi-Token`. Feed auto-refresh.

### 7.8 Notifier
Telegram cards for Tier-2 events (diff summary + Approve/Reject inline buttons); callback auth = chat id allowlist. Disabled unless both env vars set.

### 7.9 Mock upstream
`GET /api/users` with schema modes (old: `full_name`/`contact.email`/`address.city`; new: flat `name`/`email`/`city`), `POST /chaos {schema?, fail_next?, fail_status?}` (429/502 countdown), `GET /chaos`. Deterministic records; makes scenarios reproducible on camera.

### 7.10 Demo scenarios (implement exactly these three)
1. **Schema drift** — chaos schema=new; Set-node mapping rewrite; → auto-promote.
2. **Transient 429/502** — chaos fail_next=3/status=429; retry/backoff patch on the HTTP node; → auto-promote (sandbox green once countdown exhausts).
3. **Human broke it** — Code node broken by hand; restore-from-last-known-good ops touch Code; → approval path.

### 7.11 CLI
`kintsugi fix <execution-id>` (inline repair), `kintsugi seed-demo`, `kintsugi api`, `kintsugi worker`.

## 8. Technology Stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node 24, TypeScript (strict) | local nvm v24.18; Docker `node:24-slim` |
| LLM | **`@earendil-works/pi-ai`** — pinned version; only LLM dep | custom Nebius provider via `createProvider()` + `envApiKeyAuth` + `openai-completions`; TypeBox schemas; token/cost tracking |
| HTTP | hono + @hono/node-server | receiver + mock upstream |
| DB | `node:sqlite` | fallback `better-sqlite3` if needed |
| Frontend | single htmx page, no build step | vendored htmx.min.js |
| Tests | vitest | unit + receiver API tests |
| Notifier | Telegram Bot API via fetch | flag-gated |
| Containerization | Docker + compose (dev/deploy profiles) | one image, two commands |
| n8n | existing instance n8n.techa.pro (VPS, `web_gateway` compose network) | public API `<host>/api/v1`, `X-N8N-API-KEY`; `GET/PUT /workflows/{id}`, `POST /workflows`, `GET /executions?status=error`, `GET /executions/{id}` (with data), `POST /workflows/{id}/run` (capability-probed), activation endpoints |

## 9. Security & Configuration

**Non-negotiable rules**
1. **Sanitizer boundary** before any LLM prompt: strip invisible characters (zero-width, Bidi overrides, Unicode-tag U+E0000–E007F), normalize homoglyph confusables, flag instruction-shaped lines. A hostile upstream API must not steer the diagnoser.
2. **Credentials never read/exported/modified** (FLAG-ONLY exists for auth issues); n8n credential references dropped from LLM/display views; secret-shaped strings redacted in snapshots/LLM payloads/dashboard.
3. **Secrets in `.env` only** — `NEBIUS_API_KEY`, `N8N_API_KEY`, `TELEGRAM_BOT_TOKEN`; never logged, never committed.
4. **Sandbox egress** allowlist check; sandbox never activated (except webhook-fallback, secret-header protected, deactivated immediately); sandbox deleted after verification.
5. **Dashboard**: feed publicly viewable; approve/reject/revert behind optional `DASHBOARD_TOKEN`.
6. **Patches applied by code, validated**: only affected nodes, only resolvable paths, exact-diff check.

**Env vars:** `NEBIUS_BASE_URL`, `NEBIUS_API_KEY`, `MODEL_FAST`, `MODEL_REASON`, `MODEL_JUDGE`, `N8N_HOST`, `N8N_API_KEY`, `KINTSUGI_DB_PATH`, `KINTSUGI_MOCK_LLM`, `KINTSUGI_SANDBOX_WEBHOOK_SECRET`, `DASHBOARD_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `KINTSUGI_PORT`, `KINTSUGI_KEEP_SANDBOX`, `SANDBOX_EGRESS_ALLOWLIST`, `UPSTREAM_URL`, `N8N_VERSION` (compose).

## 10. API Specification

**Receiver**

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/error-hook` | n8n Error Trigger calls on every failed execution; persists event (idempotent per execution id), worker picks it up |
| `GET` | `/repair-events` | Feed list (status filter) |
| `GET` | `/repair-events/{id}` | Detail: diagnosis, diff, verification log, agent traces |
| `POST` | `/repair-events/{id}/approve` / `reject` / `revert` | Mutations, token-gated |
| `GET` | `/healthz` · `GET /` | Health · dashboard |

**Pinned response shapes (acceptance-contract — scenarios assert these):**
- `GET /healthz` → `200 {"ok":true}`
- `POST /error-hook` → `200 {"ok":true,"event_id":"<id>","created":<bool>}`; a duplicate execution id returns `created:false` (idempotent, never 500)
- `GET /repair-events` → `200 {"events":[…]}`
- Unknown event id or unknown route → `404` (never 5xx)
- Malformed JSON body → `400` (never 500, never hang)

**pi-ai surface (internal):** `models.complete(model, context)` with `submit_verdict` tool per purpose; `LLMPort` methods: `diagnose(view, event)`, `patchPlan(view, diagnosis, feedback?)`, `gateTriage/GatePatchReview/GatePromotion/GateIteration(context)`.

## 11. Success Criteria

- [ ] End-to-end: chaos on → execution fails → error hook fires → repair event appears → sandbox verification green → tier action → dashboard (+ Telegram) reflect it → revert works
- [ ] All three demo scenarios pass against the VPS n8n
- [ ] Deterministic tier rules enforced; gates escalate-only; patch validation rejects unrelated-node edits
- [ ] Sanitizer blocks invisible-character injection and flags instruction-shaped lines (unit tested)
- [ ] Agent traces visible per event on the dashboard
- [ ] CLI `fix`/`seed-demo` work; full E2E runs with `KINTSUGI_MOCK_LLM=1`
- [ ] Deliverables: public repo (MIT at root, no secrets), README (≤10 steps, architecture diagram, tier table, security section), working demo URL, ≤3-min YouTube video, written Nebius/NVIDIA feedback section

## 12. Implementation Phases

**Phase 1 — Foundation (Oct 26 evening):** PRD re-emit; git init + scaffold commit; package/tsconfig/vitest setup; config, sanitizer, redact, diff, store, workflow-view, patch-ops + unit tests.
*Validation:* vitest green; sanitizer blocks injection fixtures.

**Phase 2 — Repair loop (Oct 27):** LLM port + Nebius provider + mock; prompts; diagnose, patch, tiers, gates, sandbox harness/verify, repair orchestrator; CLI fix/worker/api/seed-demo.
*Validation:* E2E with mock LLM: seeded failing execution → patched workflow → sandbox green → tier action.

**Phase 3 — Surfaces (Oct 28):** receiver API + dashboard with agent traces; Telegram notifier; mock upstream; seed workflows; Dockerfile + compose profiles.
*Validation:* all three scenarios pass locally; dashboard shows full lifecycle incl. traces; approve/reject/revert work.

**Phase 4 — Ship (Oct 29, buffer Oct 30):** deploy to VPS (`web_gateway`), seed real instance, all scenarios E2E, README + feedback draft, video support, repo hygiene (secrets audit, license).
*Validation:* §11 checklist all green; Devpost submission ready.

### Build order for slicing (slicing guidance — one issue per line, strictly in this order)

Component tables, API lists and feature prose elsewhere in this PRD are DESCRIPTIONS of these deliverables, not separate work items — slice exactly this list, one issue per line:

1. Walking skeleton: TS/npm scaffold (strict tsc), hono API serving `GET /healthz` returning `{"ok":true}` and binding `PORT` (fallback `KINTSUGI_PORT`, default 8080), vitest wired, CI workflow `.github/workflows/ci.yml` running typecheck+tests on PRs.
2. Config module: dotenv-lite env parsing into a typed Settings object + `.env.example`.
3. SQLite store (node:sqlite): repair events (unique per execution id), workflow snapshots, decisions, llm_traces, metrics.
4. Sanitizer + redaction: strip invisible/Bidi/tag-range characters, normalize homoglyph confusables, flag instruction-shaped lines; redact secret-shaped strings and drop n8n credential blocks.
5. Workflow diff: node-level diff (added/removed/changed with leaf paths) + changed-line count.
6. Workflow view: raw workflow JSON + execution runData → compact sanitized view (node list, edge list, failing-node input data, trigger payload capture, last-known-good diff).
7. n8n client: workflow get/create/update/delete, executions list/get-with-data, run-endpoint capability probe, activate/deactivate.
8. patch-ops: path-level operation application with strict validation (set_parameter only on existing paths; retry/onError whitelists; add/remove with connection rewiring in code; node renames disallowed; loud rejection on any violation).
9. LLMPort interface + TypeBox verdict schemas + deterministic mock implementation (scenario-aware: schema drift, 429/502, human-broke-it).
10. Nebius provider on pi-ai behind LLMPort: env-driven MODEL_FAST/MODEL_REASON/MODEL_JUDGE, `submit_verdict` tool-call pattern with text-JSON fallback.
11. Hardened prompt builders (`<data>` boundaries) + diagnose stage.
12. Patch stage: plan validation (affected-nodes scope, op schema) + application via patch-ops.
13. Deterministic tier classifier (flag-only/approve/auto-promote; escalation on doubt).
14. Four escalate-only decision gates: triage, patch-review, promotion, iteration.
15. Sandbox: harness (workflow copy, production-trigger swap to pinned manual trigger, run-endpoint primary with webhook+secret fallback, delete after unless keep-flag, static egress allowlist check) + verifier (expectations from the workflow's most recent successful execution: types, record counts, null-rate).
16. Repair orchestrator + worker loop: full pipeline with status transitions, approve/reject/revert actions, pre-repair and pre-promotion snapshots, metrics.
17. Receiver API: POST /error-hook (idempotent), GET /repair-events list + detail, POST approve/reject/revert behind the DASHBOARD_TOKEN gate, static file serving.
18. Dashboard: one htmx page — metrics chips, status-pill feed, detail with diagnosis, side-by-side JSON diff, verification log, agent-trace timeline, approve/reject/revert buttons.
19. Agent traces wired through every LLM call into llm_traces (stage, model, mode, duration, tokens, capped prompt/response, parsed verdict).
20. Telegram notifier (flag-gated, disabled by default): Tier-2 approval cards with inline Approve/Reject buttons.
21. Mock upstream chaos service: GET /api/users with old/new schema modes, POST /chaos (schema, fail_next countdown, fail_status), GET /chaos; deterministic records.
22. Seed workflows: demo chaos workflow (webhook → HTTP → Set mapping → Code validator) + error-trigger workflow + `kintsugi seed-demo` seeder that installs them and registers a baseline snapshot.
23. Dockerfile + docker-compose with dev and deploy profiles (service named `worker`; API port published on 127.0.0.1; one image, commands `kintsugi api` / `kintsugi worker` / mock-upstream bin).
24. CLI completion: `kintsugi fix <execution-id>` runs the full repair pipeline inline against a real failing execution and prints the report.
25. E2E scenario 1 — schema drift → Set-only patch → auto-promote (mock LLM).
26. E2E scenario 2 — transient 429/502 → retry/backoff patch → auto-promote once the countdown exhausts (mock LLM).
27. E2E scenario 3 — human broke the Code node → restore-from-snapshot patch → approval path (mock LLM).
28. README final: ≤10-step setup, architecture diagram, tier table, security section; repo hygiene audit (no secrets committed, MIT at root, demo assets ready).

## 13. Future Considerations

- **`models.classify()` upgrade:** swap decision gates to a true classifier API (OpenAI Decisions / TypeSafe Jev / future Nebius equivalent) behind the existing gate contract — the emerging "decision model" category; small adapter, same schemas.
- Learning from history: recurring manual approvals → auto-promote candidates per failure class; per-workflow repair health.
- Sandbox runs persisted over time as a per-workflow regression suite.
- Cross-workflow drift correlation (same upstream failing multiple workflows → one upstream fix).
- Kintsugi community node surfacing repair status inside the n8n editor.

## 14. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| pi-ai moves fast (0.x) | API drift breaks build | Pin exact version + committed lockfile; wrap behind `LLMPort` so surface area is small |
| Nebius tool-calling/format quirks | Verdicts unparseable | TypeBox-validated `submit_verdict` tool + text-JSON fallback with re-ask; mock mode unblocks everything else |
| `node:sqlite` experimental behavior | Store instability | Fallback to `better-sqlite3` isolated behind `store.ts` |
| n8n lacks `POST /workflows/{id}/run` | Primary sandbox path fails | Capability probe; webhook-trigger fallback already designed (not a patch) |
| Nebius credits arrive late | No real inference for E2E | Mock LLM mode: full E2E green before credits; swap env when they land |
| Deadline compression | Incomplete submission | Fixed scope; Telegram first cut; scenarios pinned to mock upstream; phases sequenced so surfaces come after the loop works |
| LLM patch quality | Broken/unsafe patches | LLM never authors n8n JSON; path-ops validated by code; ≤3 sandbox iterations; deterministic tiers |
| Public dashboard without auth | Strangers mutate state | `DASHBOARD_TOKEN` on mutations; feed read-only |
| Secret leakage via snapshots/LLM | Credential exposure | Redaction at every boundary; credentials never read via API; pre-submission secrets audit |

## 15. Appendix

### Decisions log

### Operator checklist (operator-only steps — never sliced into issues)
- Create the public GitHub repo and push the initial PRD/LICENSE seed (happens at factory onboarding)
- Deploy the stack to the VPS (`web_gateway` network) and publish the demo URL via the reverse proxy
- Nebius console: put `NEBIUS_BASE_URL` / `NEBIUS_API_KEY` + the two model slugs into `.env` on the VPS
- Optional: Telegram bot token + chat id
- Record the ≤3-minute demo video; submit on Devpost; review the feedback section
- **Stack pivot (2026-10-26):** Python scaffold deleted by user choice; rebuilt in TypeScript on the Pi SDK. Design (pipeline, tiers, sandbox, translation layer, gates) carried over unchanged.
- **pi SDK = libraries** (`@earendil-works/pi-ai`; not the coding-agent embed, not agent-core loop): user-confirmed "deterministic pipeline" + "I meant the libraries."
- **Dashboard:** single htmx page **with agent traces** (user: "keep the single page with agent traces").
- **One language everywhere** (user-confirmed), including mock upstream.
- **All inference through Nebius Token Factory** (user-confirmed), including decision gates (`MODEL_JUDGE`, Nano-class, defaults to `MODEL_FAST`).
- **n8n target:** existing VPS instance (n8n.techa.pro, compose stack on `web_gateway` network). Compose dev profile = all-in-one; deploy profile joins the existing network; demo URL via the VPS reverse proxy (gateway type confirmed at deploy).
- **Telegram:** built, flag-gated, shipped disabled until token provided; first cut if schedule squeezes.
- **Nebius access:** built now against env placeholders; user gaining credits; mock mode unblocks E2E meanwhile.
- **Sanitizer:** no porting sources found (`sanitize.py` / `posting_guard.py` absent) — implemented fresh per spec.
- **Redaction:** secret-shaped strings redacted in snapshots/LLM payloads/display (user's YT API key observed in a Code node on their instance — rotate it).
- **Instance safety:** Kintsugi touches only error-hook arrivals; creates exactly two workflows on the production instance (demo chaos + error trigger).
- **Decision-model research:** OpenRouter "decisions" modality / "Perplexity Decider" checked against the live API 2026-10-26 — does not exist there; the real category is classifier APIs (OpenAI Decisions `POST /v1/decisions` GPT-6 Luna, TypeSafe Jev, Cloudflare Clef), which pi-ai supports natively via `models.classify()`. Hackathon constraint keeps gates on Nebius; `classify()` is the documented upgrade path.
- **Division of labor:** agent owns code, README, compose, feedback-section draft; user owns YouTube video + Devpost form.
- **Repo:** `kintsugi`, public, MIT; GitHub remote added at publish time.
