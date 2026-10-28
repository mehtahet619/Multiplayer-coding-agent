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

/**
 * Execute Agent 2's generated test bundle in a separately deployed, isolated runner.
 * The runner is deliberately a separate trust boundary: the API must never execute
 * arbitrary repository code in its own process. No fallback to model-only approval.
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
  const endpoint = process.env.VERIFICATION_RUNNER_URL?.trim();
  const secret = process.env.VERIFICATION_RUNNER_SECRET?.trim();
  if (!endpoint || !secret) {
    return {
      status: "unavailable", executed: false,
      summary: "Isolated verification runner is not configured. Publication is blocked; generated tests are not execution evidence.",
      testCount: input.testCases.length, passedCount: 0, failedCount: 0, failures: [],
      runner: "not-configured"
    };
  }
  let response: Response;
  try {
    response = await fetch(new URL("/v1/verify", endpoint), {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": "Bearer " + secret },
      body: JSON.stringify({
        repository: input.repository,
        baseSha: input.baseSha,
        candidateSha: input.candidateSha,
        task: input.task,
        testCases: input.testCases,
        testBundle: input.testBundle,
        githubToken: input.githubToken
      }),
      signal: AbortSignal.timeout(Number(process.env.VERIFICATION_TIMEOUT_MS || 900000))
    });
  } catch (error) {
    return {
      status: "unavailable", executed: false,
      summary: "Isolated runner could not be reached: " + (error instanceof Error ? error.message : String(error)),
      testCount: input.testCases.length, passedCount: 0, failedCount: 0, failures: [],
      runner: endpoint
    };
  }
  if (!response.ok) {
    return {
      status: "unavailable", executed: false,
      summary: "Isolated runner returned HTTP " + response.status + "; publication blocked.",
      testCount: input.testCases.length, passedCount: 0, failedCount: 0, failures: [],
      runner: endpoint
    };
  }
  const result = await response.json() as Record<string, unknown>;
  const allowedStatuses = ["passed", "failed"] as const;
  if (!allowedStatuses.includes(result.status as typeof allowedStatuses[number]) ||
      result.executed !== true ||
      typeof result.testCount !== "number" ||
      typeof result.passedCount !== "number" ||
      typeof result.failedCount !== "number" ||
      !Array.isArray(result.failures) ||
      typeof result.summary !== "string") {
    return {
      status: "unavailable", executed: false,
      summary: "Isolated runner returned an invalid or incomplete execution report; publication blocked.",
      testCount: input.testCases.length, passedCount: 0, failedCount: 0, failures: [],
      runner: endpoint
    };
  }
  const failures = result.failures.filter((f: any) => f && typeof f.id === "string" && typeof f.message === "string");
  const passed = result.status === "passed" &&
    result.testCount >= input.testCases.length &&
    result.failedCount === 0 &&
    result.passedCount === result.testCount &&
    failures.length === 0;
  return {
    status: passed ? "passed" : "failed",
    executed: true,
    summary: result.summary,
    testCount: result.testCount,
    passedCount: result.passedCount,
    failedCount: result.failedCount,
    failures,
    runner: endpoint
  };
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
