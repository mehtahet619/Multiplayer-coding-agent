# Legacy verification runner

This Python/Docker HTTP runner is retained for reference only and is **not used by the current Agent 1 / Agent 2 workflow**.

The active workflow is `.github/workflows/dynamic-verification.yml`. The API dispatches it through GitHub Actions. That workflow installs dependencies in a disposable container and executes the generated Agent 2 test harness in a separate Docker container with networking disabled, a read-only repository mount, no credentials, a non-root user, and resource limits.

Do not deploy this legacy service or configure `VERIFICATION_RUNNER_SECRET` for the current product flow. Keep generated test code inside the GitHub Actions Docker sandbox.
