"""Isolated dynamic verification runner.

Deploy as a separate service with Docker available. Never mount the host filesystem or
Docker socket into candidate test containers. The runner uses Docker only to create
short-lived containers with no network, read-only rootfs, resource limits, and no secrets.
"""
from __future__ import annotations
import json
import os
import re
import subprocess
import tempfile
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SECRET = os.environ.get("VERIFICATION_RUNNER_SECRET", "")
PORT = int(os.environ.get("PORT", "8080"))
MAX_BODY = 2_000_000
TIMEOUT = int(os.environ.get("VERIFICATION_TIMEOUT_SECONDS", "900"))
IMAGE = os.environ.get("VERIFICATION_NODE_IMAGE", "node:22-bookworm-slim")

def github_json(url: str, token: str):
    req = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "multiplayer-agent-verification-runner",
    })
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.loads(response.read().decode())

def write_archive(repo: str, sha: str, token: str, root: Path):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo) or not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("Invalid repository or commit SHA")
    owner, name = repo.split("/", 1)
    # Fetch the archive directly; the endpoint returns a redirect to the archive bytes.
    req = urllib.request.Request(f"https://api.github.com/repos/{owner}/{name}/tarball/{sha}", headers={
        "Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
        "User-Agent": "multiplayer-agent-verification-runner",
    })
    with urllib.request.urlopen(req, timeout=60) as response:
        archive = response.read(50_000_001)
    if len(archive) > 50_000_000:
        raise ValueError("Repository archive exceeds 50 MB limit")
    archive_path = root / "source.tar.gz"
    archive_path.write_bytes(archive)
    # Python tarfile extraction is guarded against traversal and links.
    import tarfile
    with tarfile.open(archive_path, "r:gz") as tar:
        members = tar.getmembers()
        if len(members) > 10000:
            raise ValueError("Repository contains too many files")
        for member in members:
            parts = Path(member.name).parts
            if member.issym() or member.islnk() or member.isdev() or ".." in parts:
                raise ValueError("Unsafe archive member")
        top = members[0].name.split("/")[0] if members else ""
        source = root / "repo"
        source.mkdir()
        for member in members:
            rel = Path(*Path(member.name).parts[1:])
            if not rel.parts:
                continue
            member.name = str(rel)
            tar.extract(member, source, filter="data")
    archive_path.unlink(missing_ok=True)
    return root / "repo"

def docker_run(repo_dir: Path, bundle: str, cases: list, timeout: int):
    # Bundle contract: CommonJS module exporting async function({ repositoryRoot, testCases }).
    # The wrapper demands one explicit pass/fail result per generated test ID.
    harness = repo_dir / ".agent-generated-tests.cjs"
    harness.write_text(bundle, encoding="utf-8")
    wrapper = repo_dir / ".agent-runner-wrapper.cjs"
    wrapper.write_text("""
const fs = require('node:fs');
(async () => {
  const fn = require('./.agent-generated-tests.cjs');
  const run = typeof fn === 'function' ? fn : fn.runTests;
  if (typeof run !== 'function') throw new Error('testBundle must export a function or runTests');
  const testCases = JSON.parse(fs.readFileSync('/agent-input/test-cases.json', 'utf8'));
  const results = await run({ repositoryRoot: process.cwd(), testCases });
  if (!Array.isArray(results)) throw new Error('Harness must return an array of per-case results');
  process.stdout.write(JSON.stringify({ results }) + '\\n');
})().catch(e => { console.error(e && e.stack || String(e)); process.exit(2); });
""", encoding="utf-8")
    input_dir = repo_dir.parent / "agent-input"
    input_dir.mkdir()
    (input_dir / "test-cases.json").write_text(json.dumps(cases), encoding="utf-8")
    # Dependency installation runs in an isolated container without credentials.
    # Network is enabled only for installation; actual tests run with network disabled.
    package = repo_dir / "package.json"
    if package.exists():
        install = subprocess.run(
            ["docker", "run", "--rm", "--network", "bridge", "--memory", "2g", "--cpus", "2",
             "--pids-limit", "256", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
             "-v", f"{repo_dir}:/workspace:rw", "-w", "/workspace", IMAGE,
             "sh", "-lc", "if [ -f pnpm-lock.yaml ]; then corepack enable && pnpm install --frozen-lockfile; elif [ -f package-lock.json ]; then npm ci --ignore-scripts=false; else npm install --ignore-scripts=false; fi"],
            capture_output=True, text=True, timeout=min(timeout, 600), check=False)
        if install.returncode != 0:
            return {"status": "failed", "executed": True, "summary": "Dependency installation failed in isolated container.",
                    "testCount": len(cases), "passedCount": 0, "failedCount": len(cases),
                    "failures": [{"id": "SETUP", "message": (install.stderr or install.stdout)[-5000:]}]}
    command = ["docker", "run", "--rm", "--network", "none", "--memory", "2g", "--cpus", "2",
               "--pids-limit", "256", "--read-only", "--cap-drop", "ALL",
               "--security-opt", "no-new-privileges", "--user", "65532:65532",
               "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
               "-v", f"{repo_dir}:/workspace:ro", "-v", f"{input_dir}:/agent-input:ro",
               "-w", "/workspace", IMAGE, "node", ".agent-runner-wrapper.cjs"]
    try:
        proc = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        return {"status": "failed", "executed": True, "summary": "Isolated test execution timed out.",
                "testCount": len(cases), "passedCount": 0, "failedCount": len(cases),
                "failures": [{"id": "TIMEOUT", "message": f"Exceeded {timeout} seconds"}]}
    if proc.returncode != 0:
        return {"status": "failed", "executed": True, "summary": "Generated test harness failed in isolated execution.",
                "testCount": len(cases), "passedCount": 0, "failedCount": len(cases),
                "failures": [{"id": "HARNESS", "message": (proc.stderr or proc.stdout)[-5000:]}]}
    try:
        report_line = next(line for line in reversed(proc.stdout.splitlines()) if line.startswith('{"results"'))
        results = json.loads(report_line)["results"]
    except Exception:
        return {"status": "failed", "executed": True, "summary": "Runner did not receive a valid structured test report.",
                "testCount": len(cases), "passedCount": 0, "failedCount": len(cases),
                "failures": [{"id": "REPORT", "message": proc.stdout[-5000:]}]}
    expected = {case["id"] for case in cases}
    seen = set()
    failures = []
    passed = 0
    for result in results:
        if not isinstance(result, dict) or not isinstance(result.get("id"), str) or result["id"] not in expected or result["id"] in seen:
            failures.append({"id": "REPORT", "message": "Unknown, malformed, or duplicate result ID"})
            continue
        seen.add(result["id"])
        if result.get("passed") is True:
            passed += 1
        else:
            failures.append({"id": result["id"], "message": str(result.get("message", "Test failed"))[:2000]})
    missing = expected - seen
    failures.extend({"id": case_id, "message": "No result returned for generated test case"} for case_id in sorted(missing))
    failed = len(cases) - passed
    ok = not failures and len(seen) == len(expected) and passed == len(cases)
    return {"status": "passed" if ok else "failed", "executed": True,
            "summary": f"Executed {len(cases)} generated cases: {passed} passed, {failed} failed.",
            "testCount": len(cases), "passedCount": passed, "failedCount": failed,
            "failures": failures[:200], "runner": "docker-network-none"}

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/v1/verify":
            self.send_error(404); return
        if not SECRET or self.headers.get("Authorization") != "Bearer " + SECRET:
            self.send_error(401); return
        length = int(self.headers.get("Content-Length", "0"))
        if length < 1 or length > MAX_BODY:
            self.send_error(413); return
        try:
            payload = json.loads(self.rfile.read(length))
            cases = payload.get("testCases")
            bundle = payload.get("testBundle")
            token = payload.get("githubToken")
            if not isinstance(cases, list) or not 100 <= len(cases) <= 150 or not isinstance(bundle, str) or len(bundle) < 80:
                raise ValueError("Invalid generated test plan or harness")
            if not isinstance(token, str) or not token:
                raise ValueError("GitHub token required to fetch the candidate commit")
            with tempfile.TemporaryDirectory(prefix="mca-verify-") as tmp:
                root = Path(tmp)
                repo_dir = write_archive(payload["repository"], payload["candidateSha"], token, root)
                result = docker_run(repo_dir, bundle, cases, TIMEOUT)
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        except Exception as exc:
            self.send_response(500); self.send_header("Content-Type", "application/json"); self.end_headers()
            self.wfile.write(json.dumps({"error": str(exc)[:2000]}).encode())

    def log_message(self, fmt, *args):
        print("verification-runner:", fmt % args)

if __name__ == "__main__":
    if not SECRET:
        raise SystemExit("VERIFICATION_RUNNER_SECRET must be configured")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
