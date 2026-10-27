"""Starter polling worker. This is intentionally conservative and not a secure sandbox."""
import asyncio
import json
import os
from pathlib import Path
import urllib.request

API_BASE = os.getenv("API_BASE", "http://localhost:4000")
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen2.5-coder:7b")
REPOSITORY_ROOT = Path(os.getenv("AGENT_REPOSITORY_ROOT", "./workspace")).resolve()

def ollama_generate(prompt: str) -> str:
    body = json.dumps({"model": OLLAMA_MODEL, "prompt": prompt, "stream": False, "options": {"temperature": 0.1}}).encode()
    req = urllib.request.Request(f"{OLLAMA_BASE_URL}/api/generate", data=body, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as response:
        return json.loads(response.read().decode()).get("response", "")

def safe_path(relative: str) -> Path:
    candidate = (REPOSITORY_ROOT / relative).resolve()
    if candidate != REPOSITORY_ROOT and REPOSITORY_ROOT not in candidate.parents:
        raise ValueError("Path escapes repository root")
    return candidate

def list_files(limit: int = 100) -> list[str]:
    ignored = {".git", "node_modules", ".venv", "__pycache__"}
    result = []
    for path in REPOSITORY_ROOT.rglob("*"):
        if any(part in ignored for part in path.parts):
            continue
        if path.is_file():
            result.append(str(path.relative_to(REPOSITORY_ROOT)))
            if len(result) >= limit: break
    return result

async def main():
    print("Agent worker scaffold started.")
    print(f"Repository root: {REPOSITORY_ROOT}")
    print("This starter currently exposes safe path/list helpers and the Ollama adapter.")
    print("Connect a durable task claim API before running tasks in production.")
    while True: await asyncio.sleep(30)

if __name__ == "__main__": asyncio.run(main())
