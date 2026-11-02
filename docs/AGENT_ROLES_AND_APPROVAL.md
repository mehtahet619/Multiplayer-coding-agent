# Autonomous Agent 1 / Agent 2 implementation and verification

## Agent 1: coding agent

Agent 1 receives the original task, a repository tree, and relevance-ranked source files within the configured context budget. It returns complete-file edits for existing in-scope files. It cannot publish directly to the default branch.

Agent 1 uses the selected coding provider (OpenAI, Anthropic, Gemini, or OpenRouter). Its provider key is supplied for the active run and is not stored in session records.

## Agent 2: independent requirement auditor and test engineer

Agent 2 uses its own provider, API key, and model selection. It runs two separate model calls in order:

1. **Requirement Auditor:** translate the original request into explicit acceptance criteria, inspect every proposed edit against the criteria and original source, and check security, authorization, data exposure, injection, dependency/configuration risk, regressions, correctness, accessibility, UI states, API behavior, and error handling.
2. **Test Engineer:** only after the Requirement Auditor approves every criterion, create a fresh 20–30-case risk-based test matrix and an executable CommonJS test harness. Cases must cover the applicable acceptance criteria, positive and negative behavior, authorization, security, regressions, edge cases, and failure/recovery paths.

The Requirement Auditor and Test Engineer are separate model requests. The Test Engineer is never called unless the audit has returned explicit, complete acceptance criteria marked met and no critical/high finding. A generated test plan is not evidence that tests passed. Agent 2 must return one result for every generated test ID. Missing, duplicate, malformed, or failed results block publication.

## Autonomous audit and repair loop

1. Agent 1 proposes changes in memory. No branch or commit is created.
2. Agent 2 audits the original task against the proposed implementation.
3. If requirements are missing or a critical/high finding exists, Agent 2 sends Agent 1 the unmet criteria and failure evidence, not a proposed solution.
4. Agent 1 repairs the implementation. Agent 2 independently re-audits the revised changes.
5. The audit/repair loop runs up to `AGENT_MAX_AUDIT_REPAIR_ITERATIONS` (default 3, bounded 1–6). It stops if Agent 1 cannot return valid in-scope edits, the reviewer rejects without actionable repair evidence, or the limit is reached.
6. Only after the audit passes does Agent 2 generate tests.
7. The test suite runs on the exact candidate commit in a disposable Docker container on a GitHub-hosted runner. Dependency installation occurs in a separate resource-limited container with network access and package lifecycle scripts disabled. The actual generated test harness runs with **no network**, a disposable repository copy, no credentials, no Linux capabilities, a non-root user, and CPU/memory/process limits.
8. If tests fail, Agent 2 reports the actual failed test IDs and evidence to Agent 1. Agent 1 repairs; Agent 2 re-audits and creates a fresh test suite. The execution/repair loop runs up to `AGENT_MAX_REPAIR_ITERATIONS` (default 5, bounded 1–8).
9. After the requirement audit passes, the candidate is committed to a separate feature branch so the exact commit can be tested. A pull request is opened only after the generated suite passes and repository CI succeeds. Neither agent merges to the default branch.

## Failure behavior

The workflow fails closed. Invalid model JSON, incomplete acceptance criteria, critical/high findings, oversized review context, invalid test plans, unavailable GitHub Actions dispatch, failed sandbox execution, incomplete reports, failing tests, failed repository CI, and exhausted repair loops all block pull-request creation.

The generated test harness is untrusted code. It is not executed directly on the GitHub-hosted runner. The workflow runs it only inside the constrained Docker container. Do not add provider keys, GitHub tokens, or other secrets to the container environment or mounted workspace.

## Configuration

- `AGENT_CONTEXT_MAX_TOKENS`: repository context budget, default 60,000 tokens.
- `AGENT1_MAX_OUTPUT_TOKENS`: Agent 1 initial implementation output, default 8,192.
- `AGENT1_REPAIR_MAX_OUTPUT_TOKENS`: Agent 1 repair output, default 8,192.
- `AGENT2_MAX_OUTPUT_TOKENS`: Agent 2 audit/test output, default 8,192.
- `AGENT_MAX_AUDIT_REPAIR_ITERATIONS`: requirement-audit repair rounds, default 3, bounded 1–6.
- `AGENT_MAX_REPAIR_ITERATIONS`: failed-test repair rounds, default 5, bounded 1–8.

The GitHub token must be able to read repository contents, create branches and pull requests, dispatch the verification workflow, and read check runs. The `Dynamic Verification Executor` workflow must be present on the repository default branch.

## Human responsibility

The user supplies the task and credentials at the start. No human handoff is required between Agent 1 and Agent 2. A person must still review the final pull request and decide whether to merge it.
