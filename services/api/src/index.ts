import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { randomUUID } from "node:crypto";

const app = express();
const server = createServer(app);
const allowed = (process.env.WEB_ORIGIN || "http://localhost:5173").split(",").map(x => x.trim());
app.use(cors({ origin: allowed, credentials: true }));
app.use(express.json({ limit: "1mb" }));
const io = new Server(server, { cors: { origin: allowed } });
type Session = { id: string; title: string; status: string; createdAt: string; repository?: string; branch?: string };
type Event = { type: string; sessionId: string; seq: number; timestamp: string; actor: { type: "user" | "agent" | "system"; id: string }; payload: Record<string, unknown> };
const sessions: Session[] = [];
const events = new Map<string, Event[]>();
const instructions = new Map<string, string[]>();
const cancelled = new Set<string>();
const paused = new Set<string>();

app.get("/health", (_req, res) => res.json({ ok: true, service: "multiplayer-coding-agent-api", customerKeysSupported: true }));
app.get("/api/v1/sessions", (_req, res) => res.json(sessions));
app.post("/api/v1/sessions", (req, res) => {
 const repository = typeof req.body?.repository === "string" ? req.body.repository.trim() : "";
 if (repository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return res.status(400).json({ error: "Repository must be in owner/repo format." });
 const session: Session = { id: randomUUID(), title: String(req.body?.title || "Shared coding session").slice(0,120), status: "idle", createdAt: new Date().toISOString(), ...(repository ? { repository } : {}) };
 sessions.unshift(session); events.set(session.id, []); instructions.set(session.id, []);
 addEvent(session.id, "session.created", { title: session.title, repository: repository || null }, "system");
 res.status(201).json(session);
});
app.get("/api/v1/sessions/:id/events", (req, res) => {
 if (!sessions.some(s => s.id === req.params.id)) return res.status(404).json({ error: "Session not found" });
 res.json(events.get(req.params.id) || []);
});
app.post("/api/v1/sessions/:id/commands", async (req, res) => {
 const s = sessions.find(x => x.id === req.params.id);
 if (!s) return res.status(404).json({ error: "Session not found" });
 const type = String(req.body?.type || "");
 const payload = req.body?.payload && typeof req.body.payload === "object" ? req.body.payload : {};
 if (type === "instruction.add") {
   const text = typeof payload.text === "string" ? payload.text.trim() : "";
   if (!text) return res.status(400).json({ error: "Instruction cannot be empty." });
   if (text.length > 8000) return res.status(400).json({ error: "Instruction is too long (maximum 8000 characters)." });
   instructions.set(s.id, [...(instructions.get(s.id) || []), text]);
   addEvent(s.id, type, { text }, "user");
 } else if (type === "agent.start" || type === "agent.resume") {
   const credentials = req.body?.credentials && typeof req.body.credentials === "object" ? req.body.credentials : {};\n   const openaiKey = typeof credentials.openaiApiKey === "string" ? credentials.openaiApiKey.trim() : process.env.OPENAI_API_KEY || "";
   const githubToken = typeof credentials.githubToken === "string" ? credentials.githubToken.trim() : process.env.GITHUB_TOKEN || "";
   if (!openaiKey || !githubToken) return res.status(400).json({ error: "Enter your OpenAI API key and GitHub token before starting the agent. Keys are used for this run and are not saved in session records." });
   if (!s.repository) return res.status(400).json({ error: "Add a GitHub repository (owner/repo) when creating the session first." });
   if (!(instructions.get(s.id) || []).length) return res.status(400).json({ error: "Add an instruction before starting the agent." });
   if (s.status === "running") return res.status(409).json({ error: "Agent is already running." });
   cancelled.delete(s.id); paused.delete(s.id); s.status = "running";
   addEvent(s.id, type, { status: "running" }, "user");
   void runAgent(s, { openaiKey, githubToken });
 } else if (type === "agent.pause") {
   paused.add(s.id); s.status = "paused"; addEvent(s.id, type, { status: s.status }, "user");
 } else if (type === "agent.cancel") {
   cancelled.add(s.id); paused.delete(s.id); s.status = "cancelled"; addEvent(s.id, type, { status: s.status }, "user");
 } else return res.status(400).json({ error: "Unknown command type" });
 res.json({ ok: true, session: s });
});

function addEvent(sessionId: string, type: string, payload: Record<string, unknown>, actor: "user" | "agent" | "system") {
 const list = events.get(sessionId) || [];
 const event: Event = { type, sessionId, seq: list.length + 1, timestamp: new Date().toISOString(), actor: { type: actor, id: actor === "user" ? "local-user" : actor }, payload };
 list.push(event); events.set(sessionId, list); io.to(sessionId).emit("session.event", event); return event;
}
type AgentCredentials = { openaiKey: string; githubToken: string };\nasync function github(path: string, token: string, init: RequestInit = {}) {
 const response = await fetch("https://api.github.com" + path, { ...init, headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json", ...(init.headers || {}) } });
 const data = await response.json().catch(() => ({}));
 if (!response.ok) throw new Error("GitHub API " + response.status + ": " + String((data as any).message || "request failed"));
 return data as any;
}
async function runAgent(session: Session, credentials: AgentCredentials) {
 const id = session.id;
 try {
   const repo = session.repository!;
   const [owner, name] = repo.split("/");
   addEvent(id, "agent.started", { repository: repo, message: "Inspecting repository and preparing a change." }, "agent");
   const repoInfo = await github("/repos/" + owner + "/" + name, credentials.githubToken);
   const base = repoInfo.default_branch || "main";
   const tree = await github("/repos/" + owner + "/" + name + "/git/trees/" + encodeURIComponent(base) + "?recursive=1", credentials.githubToken);
   const files = (tree.tree || []).filter((x: any) => x.type === "blob" && /\.(ts|tsx|js|jsx|json|md|css|html|py|go|rs|yml|yaml)$/.test(x.path) && !/(node_modules|dist|build|\.lock$|\.min\.)/.test(x.path)).slice(0, 12);
   const contents: Array<{path:string;sha:string;content:string}> = [];
   for (const file of files) {
     if (cancelled.has(id)) throw new Error("Task cancelled.");
     if (paused.has(id)) { await waitWhilePaused(id); }
     const blob = await github("/repos/" + owner + "/" + name + "/contents/" + file.path.split("/").map(encodeURIComponent).join("/") + "?ref=" + encodeURIComponent(base), credentials.githubToken);
     if (blob.encoding === "base64" && typeof blob.content === "string") {
       const decoded = Buffer.from(blob.content.replace(/\n/g, ""), "base64").toString("utf8");
       if (decoded.length < 12000) contents.push({ path: file.path, sha: blob.sha, content: decoded });
     }
   }
   const task = (instructions.get(id) || []).join("\n\n");
   const prompt = "You are a careful coding agent. Review the supplied repository files and implement the user's task. Return ONLY JSON matching {summary:string, edits:[{path:string,content:string}], notes:string[]}. Each edit must contain the COMPLETE replacement file content. Only edit existing files included in the input; never edit secrets, CI deployment config, package lockfiles, or files outside the task scope. If the task cannot be safely completed from the provided files, return edits:[] and explain in summary/notes. Keep edits focused.\nTASK:\n" + task + "\nFILES:\n" + JSON.stringify(contents.map(f => ({path:f.path,content:f.content})));
   addEvent(id, "agent.analyzing", { fileCount: contents.length, message: "Sending repository context to the model." }, "agent");
   const modelResponse = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { Authorization: "Bearer " + credentials.openaiKey, "Content-Type": "application/json" }, body: JSON.stringify({ model: process.env.OPENAI_MODEL || "gpt-4.1-mini", temperature: 0.1, response_format: { type: "json_object" }, messages: [{ role: "system", content: "You produce safe, minimal code edits as JSON." }, { role: "user", content: prompt }] }) });
   const result = await modelResponse.json().catch(() => ({})) as any;
   if (!modelResponse.ok) throw new Error("Model API " + modelResponse.status + ": " + (result.error?.message || "request failed"));
   const output = JSON.parse(result.choices?.[0]?.message?.content || "{}");
   if (cancelled.has(id)) throw new Error("Task cancelled.");
   const edits = Array.isArray(output.edits) ? output.edits.filter((e: any) => contents.some(f => f.path === e.path) && typeof e.content === "string") : [];
   if (!edits.length) { addEvent(id, "agent.completed", { summary: output.summary || "No safe file edits were proposed.", notes: output.notes || [] }, "agent"); session.status = "completed"; return; }
   const branch = "agent/" + id.slice(0, 8);
   await github("/repos/" + owner + "/" + name + "/git/refs/heads/" + encodeURIComponent(base), credentials.githubToken).catch(async () => null);
   const baseRef = await github("/repos/" + owner + "/" + name + "/git/ref/heads/" + encodeURIComponent(base), credentials.githubToken);
   await github("/repos/" + owner + "/" + name + "/git/refs", credentials.githubToken, { method: "POST", body: JSON.stringify({ ref: "refs/heads/" + branch, sha: baseRef.object.sha }) });
   session.branch = branch;
   addEvent(id, "agent.changes_proposed", { summary: output.summary || "Prepared changes.", files: edits.map((e: any) => e.path), branch }, "agent");
   for (const edit of edits) {
     if (cancelled.has(id)) throw new Error("Task cancelled before all edits were committed.");
     await waitWhilePaused(id);
     const original = contents.find(f => f.path === edit.path)!;
     await github("/repos/" + owner + "/" + name + "/contents/" + edit.path.split("/").map(encodeURIComponent).join("/"), credentials.githubToken, { method: "PUT", body: JSON.stringify({ message: "agent: " + String(output.summary || "implement requested changes").slice(0, 60), content: Buffer.from(edit.content, "utf8").toString("base64"), branch, sha: original.sha }) });
     addEvent(id, "agent.file_committed", { path: edit.path, branch }, "agent");
   }
   addEvent(id, "agent.completed", { summary: output.summary || "Changes committed to a separate branch.", branch, compareUrl: "https://github.com/" + repo + "/compare/" + base + "..." + branch, notes: output.notes || [], warning: "Review the branch and run tests before merging. The agent has not run your project's test suite." }, "agent");
   session.status = "completed";
 } catch (error) {
   session.status = cancelled.has(id) ? "cancelled" : "failed";
   addEvent(id, "agent.failed", { error: error instanceof Error ? error.message : String(error) }, "agent");
 }
}
function waitWhilePaused(id: string): Promise<void> {
 return new Promise((resolve, reject) => {
   const check = () => { if (cancelled.has(id)) return reject(new Error("Task cancelled.")); if (!paused.has(id)) return resolve(); setTimeout(check, 500); };
   check();
 });
}
io.on("connection", socket => { socket.on("session.join", (data: {sessionId?: string}) => { if (data?.sessionId && sessions.some(s => s.id === data.sessionId)) socket.join(data.sessionId); }); });
const port = Number(process.env.PORT || process.env.API_PORT || 4000);
server.listen(port, "0.0.0.0", () => console.log("API listening on", port));
