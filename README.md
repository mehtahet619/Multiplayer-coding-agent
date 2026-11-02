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
- The Python polling worker is a scaffold and is not used by the hosted GitHub-based two-agent workflow. The API workflow uses GitHub-hosted Actions and a disposable Docker sandbox for generated test execution.
- Model support depends on your local hardware and the selected Ollama model.
- This is an initial scaffold; full end-to-end behavior has not been verified.

## Autonomous Agent 1 / Agent 2 workflow
- Agent 1 generates complete-file edits from relevance-ranked repository context. No branch is created before review.
- Agent 2 first audits the original task against every proposed change. If requirements are missing or critical/high findings exist, it sends failure evidence to Agent 1 for bounded repair and independently re-audits.
- Only after the audit passes does Agent 2 generate a fresh 20–30-case risk-based test matrix and executable test harness.
- GitHub Actions checks out the exact candidate SHA. Dependencies install in a disposable resource-limited container with package lifecycle scripts disabled. The generated harness runs in a separate Docker container with no network, a read-only repository mount, no credentials, a non-root user, and CPU/memory/process limits.
- Actual test failures go back to Agent 1. Agent 2 re-audits every repair and creates a fresh suite before retesting. Pull-request creation is blocked unless all tests and repository CI pass.
- Configure `AGENT_MAX_AUDIT_REPAIR_ITERATIONS` (default 3) and `AGENT_MAX_REPAIR_ITERATIONS` (default 5) to control the bounded repair loops. See [Agent roles and approval](docs/AGENT_ROLES_AND_APPROVAL.md).

### AI token and context budgets
The API uses bounded defaults to avoid unexpectedly large model requests. Configure these optional Render environment variables (or local API environment):
- `AGENT1_MAX_OUTPUT_TOKENS`: Agent 1 initial implementation response, default 8192.
- `AGENT1_REPAIR_MAX_OUTPUT_TOKENS`: Agent 1 repair response, default 8192.
- `AGENT2_MAX_OUTPUT_TOKENS`: Agent 2 review and re-review responses, default 8192.
- `AGENT_CONTEXT_MAX_TOKENS`: repository context budget, default 60000 tokens (bounded to 4000–80000).
- `AGENT_MAX_AUDIT_REPAIR_ITERATIONS`: requirement-audit repair rounds, default 3 (bounded 1–6).
- `AGENT_MAX_REPAIR_ITERATIONS`: failed-test repair rounds, default 5 (bounded 1–8).

Output token limits are bounded to 1024–16384. If a provider reports that it stopped because the output limit was reached, the run fails with a clear truncation error instead of attempting to parse or publish incomplete JSON. Increase the relevant limit or reduce the task/context size when that happens.

## Security before public deployment
- Keep generated test harness execution inside the network-isolated Docker sandbox.
- Never mount the Docker socket into a candidate container or expose credentials to model/test processes.
- Add command idempotency, worker leases/recovery, approval records, and rate limiting.
