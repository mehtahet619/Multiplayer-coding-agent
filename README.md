# Multiplayer Coding Agent

A zero-cost-first MVP starter for a shared AI coding session. The API owns durable session events; Socket.IO delivers them live; a separate Python worker can run coding tasks independently of browsers.

## Included
- React + Vite shared-session UI
- Express + Socket.IO API
- PostgreSQL schema and durable event log
- Session creation, event replay, shared instruction queue, pause/resume/cancel commands
- Python agent worker with Ollama-compatible model adapter and constrained repository tools
- Docker Compose for local development

## Prerequisites
- Docker + Docker Compose
- Node.js 20+ and pnpm (or run the web/API containers)
- Python 3.11+ for the agent worker
- Optional: Ollama and a coding model for local inference

## Quick start
1. Copy `.env.example` to `.env`.
2. Run `docker compose -f infra/docker-compose.yml up --build`.
3. In another terminal, install workspace dependencies with `corepack enable && pnpm install`.
4. Run database migration: `pnpm db:push`.
5. Run the API and web app using `pnpm dev`.
6. Optional agent worker: `cd services/agent-runtime && python -m venv .venv`; activate it, then `pip install -r requirements.txt && python -m app.worker`.

The Compose file starts PostgreSQL only by default to keep local development straightforward. Run web/API/worker with the commands above.

## MVP limitations
- Auth is a development-only email identity header. Replace it with secure cookie/session authentication before exposing publicly.
- The initial agent worker is a starter loop, not a hardened autonomous coding system. Do not run it on untrusted repositories or expose it publicly until sandboxing, authorization, rate limits, and audit controls are completed.
- Model support depends on your local hardware and the selected Ollama model.
- This is an initial scaffold; full end-to-end behavior has not been verified.

## Two-agent review gate
- Agent 1 implements the requested task using the selected coding provider/model.
- Agent 2 uses its own configured provider/model and API key as the independent permission/security reviewer.
- Agent 2 must approve the patch, report no critical/high findings, and return a 100–150-case tailored test matrix before a feature branch or pull request is created.
- The current hosted runtime generates the test matrix but does not execute all UI/API cases. Passing CI and human review are still required before merge.
- See [Agent roles and approval prompts](docs/AGENT_ROLES_AND_APPROVAL.md).

## Security before public deployment
- Replace development identity headers with proper authentication.
- Add workspace membership checks on every endpoint and socket command.
- Run agent tools in isolated containers with resource/network restrictions.
- Never mount the Docker socket into an agent container or expose credentials to the model.
- Add command idempotency, worker leases/recovery, approval records, and rate limiting.
