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

## Two-agent adversarial verification gate
- Agent 1 implements the task on a separate candidate branch; it never writes directly to the default branch.
- Agent 2 independently reviews the actual patch, checks permissions/security, and dynamically generates a risk-based 20–30-case repository-specific test matrix plus an executable test harness.
- The API dispatches the test matrix and executable harness to GitHub Actions, which checks out the exact candidate commit. Dependencies are installed in a disposable resource-limited container with lifecycle scripts disabled. The generated harness then runs in a separate Docker container with no network, a read-only repository mount, no credentials, a non-root user, and CPU/memory/process limits.
- The workflow publishes a uniquely named check run containing the execution report. The API accepts only a matching report for the exact candidate SHA and run ID.
- On test failure, the actual failure evidence is sent to Agent 1. Agent 1 may repair the patch up to `AGENT_MAX_REPAIR_ITERATIONS` times (default 5); Agent 2 re-audits the repaired patch and generates a fresh test suite before retesting.
- Publication fails closed if dispatch is unavailable, the report is incomplete, any test fails, Agent 2 rejects, or the bounded repair loop is exhausted. A generated test plan is never treated as a passing execution report.
- The `Dynamic Verification Executor` workflow must exist on the target repository's default branch, and the GitHub token must be allowed to dispatch Actions workflows and read check runs. See [Agent roles and approval](docs/AGENT_ROLES_AND_APPROVAL.md).

### AI token and context budgets
The API uses bounded defaults to avoid unexpectedly large model requests. Configure these optional Render environment variables (or local API environment):
- `AGENT1_MAX_OUTPUT_TOKENS`: Agent 1 initial implementation response, default 8192.
- `AGENT1_REPAIR_MAX_OUTPUT_TOKENS`: Agent 1 repair response, default 8192.
- `AGENT2_MAX_OUTPUT_TOKENS`: Agent 2 review and re-review responses, default 8192.
- `AGENT_CONTEXT_MAX_TOKENS`: maximum repository source context sent per run, default 60000 tokens (bounded to 4000–80000).\n- `AGENT_MAX_AUDIT_REPAIR_ITERATIONS`: Agent 1 requirement-audit repair rounds, default 3 (bounded 1–6).\n- `AGENT_MAX_REPAIR_ITERATIONS`: Agent 1 failed-test repair rounds, default 5 (bounded 1–8).

Output token limits are bounded to 1024–16384. If a provider reports that it stopped because the output limit was reached, the run fails with a clear truncation error instead of attempting to parse or publish incomplete JSON. Increase the relevant limit or reduce the task/context size when that happens.

## Security before public deployment
- Replace development identity headers with proper authentication.
- Add workspace membership checks on every endpoint and socket command.
- Run agent tools in isolated containers with resource/network restrictions.
- Never mount the Docker socket into an agent container or expose credentials to the model.
- Add command idempotency, worker leases/recovery, approval records, and rate limiting.
