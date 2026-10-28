export type ExecutionLayer = "ui" | "api" | "integration" | "static";
export type GeneratedTestCase = {
  id: string;
  area: string;
  scenario: string;
  expectedResult: string;
  executionLayer: ExecutionLayer;
};
export type VerificationResult = {
  status: "passed" | "failed" | "unavailable";
  executed: boolean;
  summary: string;
  testCount: number;
  passedCount: number;
  failedCount: number;
  failures: Array<{ id: string; message: string }>;
  runner: string;
};

const LAYERS = new Set<ExecutionLayer>(["ui", "api", "integration", "static"]);
const API = "https://api.github.com";
const WORKFLOW = "dynamic-verification.yml";

export function validateGeneratedTests(value: unknown): value is GeneratedTestCase[] {
  if (!Array.isArray(value) || value.length < 100 || value.length > 150) return false;
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") return false;
    const test = item as Record<string, unknown>;
    if (typeof test.id !== "string" || !test.id.trim() || ids.has(test.id)) return false;
    if (typeof test.area !== "string" || !test.area.trim()) return false;
    if (typeof test.scenario !== "string" || !test.scenario.trim()) return false;
    if (typeof test.expectedResult !== "string" || !test.expectedResult.trim()) return false;
    if (typeof test.executionLayer !== "string" || !LAYERS.has(test.executionLayer as ExecutionLayer)) return false;
    ids.add(test.id);
  }
  return true;
}

async function githubRequest(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return fetch(API + path, {
    ...init,
    headers: {
      authorization: "Bearer " + token,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      ...(init.headers || {})
    },
    signal: AbortSignal.timeout(30000)
  });
}

/**
 * Uses GitHub-hosted Actions runners. No Render Docker daemon, runner URL, or
 * runner secret is required. The workflow creates a uniquely named check run
 * containing the complete execution report; missing/invalid reports fail closed.
 */
export async function executeIsolatedVerification(input: {
  repository: string;
  baseSha: string;
  candidateSha: string;
  task: string;
  testCases: GeneratedTestCase[];
  testBundle: string;
  githubToken: string;
}): Promise<VerificationResult> {
  const unavailable = (summary: string): VerificationResult => ({
    status: "unavailable", executed: false, summary,
    testCount: input.testCases.length, passedCount: 0, failedCount: 0, failures: [],
    runner: "github-actions"
  });
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(input.repository);
  if (!match) return unavailable("Invalid repository name; publication blocked.");
  if (!/^[0-9a-f]{40}$/i.test(input.candidateSha)) return unavailable("Invalid candidate commit SHA; publication blocked.");
  if (!validateGeneratedTests(input.testCases) || input.testBundle.trim().length < 80) {
    return unavailable("Generated test matrix or executable harness is invalid; publication blocked.");
  }

  const runId = crypto.randomUUID();
  const testCases = JSON.stringify(input.testCases);
  const payload = {
    ref: "main",
    inputs: {
      run_id: runId,
      candidate_sha: input.candidateSha,
      test_cases: testCases,
      test_bundle: input.testBundle
    }
  };
  // GitHub workflow_dispatch limits the total inputs payload. Never truncate tests.
  if (JSON.stringify(payload).length > 60000) {
    return unavailable("Generated tests exceed GitHub Actions dispatch size limits. Reduce the harness size; publication blocked.");
  }

  const owner = match[1];
  const repo = match[2];
  const dispatchPath = "/repos/" + owner + "/" + repo + "/actions/workflows/" + WORKFLOW + "/dispatches";
  let dispatch: Response;
  try {
    dispatch = await githubRequest(dispatchPath, input.githubToken, {
      method: "POST", body: JSON.stringify(payload)
    });
  } catch (error) {
    return unavailable("Could not dispatch GitHub-hosted verification: " + (error instanceof Error ? error.message : String(error)));
  }
  if (dispatch.status !== 204) {
    const detail = (await dispatch.text().catch(() => "")).slice(0, 1000);
    return unavailable("GitHub Actions dispatch failed with HTTP " + dispatch.status + ". Ensure the workflow is on the default branch and the token can dispatch workflows. " + detail);
  }

  const checkName = "Agent2 Dynamic Verification " + runId;
  const deadline = Date.now() + Number(process.env.VERIFICATION_TIMEOUT_MS || 900000);
  while (Date.now() < deadline) {
    let response: Response;
    try {
      response = await githubRequest(
        "/repos/" + owner + "/" + repo + "/commits/" + encodeURIComponent(input.candidateSha) + "/check-runs?per_page=100",
        input.githubToken
      );
    } catch (error) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      continue;
    }
    if (!response.ok) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      continue;
    }
    const body = await response.json() as { check_runs?: Array<Record<string, any>> };
    const check = (body.check_runs || []).find(item => item.name === checkName);
    if (check?.status === "completed") {
      const summary = typeof check.output?.summary === "string" ? check.output.summary : "";
      let report: Record<string, any>;
      try { report = JSON.parse(summary); }
      catch { return unavailable("GitHub verification completed without a valid execution report; publication blocked."); }
      const valid = report.runId === runId &&
        report.candidateSha === input.candidateSha &&
        report.executed === true &&
        (report.status === "passed" || report.status === "failed") &&
        Number.isInteger(report.testCount) &&
        Number.isInteger(report.passedCount) &&
        Number.isInteger(report.failedCount) &&
        Array.isArray(report.failures) &&
        typeof report.summary === "string";
      if (!valid) return unavailable("GitHub verification returned a malformed or mismatched report; publication blocked.");
      const failures = report.failures.filter((f: any) => f && typeof f.id === "string" && typeof f.message === "string");
      const passed = check.conclusion === "success" &&
        report.status === "passed" &&
        report.testCount === input.testCases.length &&
        report.passedCount === report.testCount &&
        report.failedCount === 0 &&
        failures.length === 0;
      return {
        status: passed ? "passed" : "failed",
        executed: true,
        summary: report.summary,
        testCount: report.testCount,
        passedCount: report.passedCount,
        failedCount: report.failedCount,
        failures,
        runner: "github-actions:" + String(check.html_url || "")
      };
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  return unavailable("Timed out waiting for GitHub-hosted test execution. Publication blocked.");
}

export function buildRepairPrompt(task: string, originalFiles: Array<{ path: string; content: string }>, edits: Array<{ path: string; content: string }>, failures: Array<{ id: string; message: string }>, attempt: number, maxAttempts: number): string {
  return [
    "You are Agent 1 repairing a candidate that failed independently executed verification.",
    "Fix the concrete failures below. Do not weaken, delete, skip, or rewrite tests merely to make them pass.",
    "Return ONLY JSON: {summary:string,edits:[{path:string,content:string}],notes:string[]}. Each edit must be a complete file replacement and may only target files present in ORIGINAL FILES.",
    "Attempt " + attempt + " of " + maxAttempts + ". If the failure cannot be fixed safely, return edits:[] and explain why.",
    "ORIGINAL TASK:\n" + task,
    "ORIGINAL FILES:\n" + JSON.stringify(originalFiles),
    "CURRENT CANDIDATE EDITS:\n" + JSON.stringify(edits),
    "EXECUTED TEST FAILURES:\n" + JSON.stringify(failures)
  ].join("\n\n");
}
