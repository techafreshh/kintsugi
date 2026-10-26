# Kintsugi

**Self-repairing agent for n8n** — *every break becomes a golden seam.*

Kintsugi watches failed n8n executions, diagnoses the root cause with an LLM, patches the workflow JSON, **verifies the patch by replaying the original failed payload in a sandbox**, and then auto-promotes low-risk fixes or parks riskier ones for human approval. One-click revert is always available.

Built for the **Nebius x NVIDIA Global AI Hackathon**.

## Status

🚧 Under construction — the product is being built by the [pi-dark-factory](https://github.com/techafreshh/pi-dark-factory) from the PRD in [`.agents/PRDs/PRD.md`](.agents/PRDs/PRD.md). This README will grow the full setup guide (≤10 steps), architecture diagram, tier table, and security section as the components land.
