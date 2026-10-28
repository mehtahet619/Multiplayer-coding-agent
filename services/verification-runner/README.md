# Isolated verification runner

This is a separately deployed, authenticated runner service for Agent 2's generated executable test harness. It is not part of the API process and does not require changes to the repository's GitHub Actions workflow.

## Runtime requirements

- Python 3.12+
- Docker Engine available to the runner host (the runner invokes the Docker CLI)
- Configure `VERIFICATION_RUNNER_SECRET` to the same high-entropy secret used by the API.
- Configure the API with `VERIFICATION_RUNNER_URL` and `VERIFICATION_RUNNER_SECRET`.

Deploy this service on a host where Docker is available. The runner process must be able to access a Docker daemon; prefer a rootless Docker daemon or a TLS-protected remote daemon via `DOCKER_HOST`. If you mount a daemon socket into the runner service, that grants the runner host-level control and must be treated as a privileged infrastructure component. Never mount the socket into candidate test containers. Keep the runner reachable only from the API over HTTPS/private networking.

## Harness contract

Agent 2 must return a CommonJS JavaScript module exporting an async function (or `runTests`) accepting `{ repositoryRoot, testCases }`. It must return one result per generated case, each shaped as `{ id, passed, message }`. IDs must match the generated test matrix exactly. Missing, duplicate, malformed, or failed results fail closed.

The runner fetches the exact candidate commit, checks archive paths, installs dependencies in a resource-limited container with no credentials, then executes the harness in a second container with networking disabled, read-only root filesystem, dropped Linux capabilities, no-new-privileges, non-root UID, resource limits, and a timeout. Dependency installation is untrusted code and has network access; it receives no credentials. Review and harden the runner host before exposing it publicly.

The current runner executes Node.js projects only. If the candidate does not have a Node package manifest or the harness cannot execute all generated cases, verification fails closed rather than claiming success.
