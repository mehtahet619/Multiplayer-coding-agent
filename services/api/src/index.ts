import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseSecret = process.env.SUPABASE_SECRET_KEY;
if (!supabaseUrl || !supabaseSecret) throw new Error("SUPABASE_URL and server-only SUPABASE_SECRET_KEY must be configured.");
const supabase = createClient(supabaseUrl, supabaseSecret, { auth: { persistSession: false, autoRefreshToken: false } });
const app = express();
const server = createServer(app);
const allowed = (process.env.WEB_ORIGIN || "http://localhost:5173").split(",").map(x => x.trim());
app.use(cors({ origin: allowed, credentials: true }));
app.use(express.json({ limit: "1mb" }));
const io = new Server(server, { cors: { origin: allowed } });
type Session = { id: string; ownerId: string; title: string; status: string; createdAt: string; repository?: string; branch?: string };
type Event = { type: string; sessionId: string; seq: number; timestamp: string; actor: { type: "user" | "agent" | "system"; id: string }; payload: Record<string, unknown> };
const sessions: Session[] = [];
const events = new Map<string, Event[]>();
const instructions = new Map<string, string[]>();
const cancelled = new Set<string>();
const paused = new Set<string>();

app.get("/health", (_req, res) => res.json({ ok: true, service: "multiplayer-coding-agent-api" }));
async function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
 const header = req.header("authorization") || "";
 const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
 if (!token) return res.status(401).json({ error: "Sign in required." });
 const { data, error } = await supabase.auth.getUser(token);
 if (error || !data.user) return res.status(401).json({ error: "Invalid or expired sign-in. Please sign in again." });
 (req as any).user = data.user; next();
}
app.use("/api/v1", requireAuth);
function mapSession(row: any): Session { return { id: row.id, ownerId: row.owner_id, title: row.title, status: row.status, createdAt: row.created_at, ...(row.repository ? { repository: row.repository } : {}), ...(row.branch ? { branch: row.branch } : {}) }; }
async function ownedSession(id: string, ownerId: string): Promise<Session | null> {
 const { data, error } = await supabase.from("sessions").select("*").eq("id", id).eq("owner_id", ownerId).maybeSingle();
 if (error) throw error; return data ? mapSession(data) : null;
}
app.get("/api/v1/sessions", async (req, res) => {
 const { data, error } = await supabase.from("sessions").select("*").eq("owner_id", (req as any).user.id).order("created_at", { ascending: false });
 if (error) return res.status(500).json({ error: "Could not load sessions." });
 res.json((data || []).map(mapSession));
});
app.post("/api/v1/sessions", async (req, res) => {
 const ownerId = (req as any).user.id as string;
 const repository = typeof req.body?.repository === "string" ? req.body.repository.trim() : "";
 if (repository && !/^[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+$/.test(repository)) return res.status(400).json({ error: "Repository must be in owner/repo format." });
 const title = String(req.body?.title || "Shared coding session").trim().slice(0,120) || "Shared coding session";
 const { data, error } = await supabase.from("sessions").insert({ owner_id: ownerId, title, repository: repository || null, status: "idle" }).select("*").single();
 if (error || !data) return res.status(500).json({ error: "Could not create session in database." });
 const session = mapSession(data); sessions.unshift(session); events.set(session.id, []); instructions.set(session.id, []);
 await addEvent(session.id, "session.created", { title: session.title, repository: repository || null }, "system");
 res.status(201).json(session);
});
app.get("/api/v1/sessions/:id/events", async (req, res) => {
 const ownerId = (req as any).user.id as string;
 const session = await ownedSession(req.params.id, ownerId).catch(() => null);
 if (!session) return res.status(404).json({ error: "Session not found" });
 const { data, error } = await supabase.from("session_events").select("*").eq("session_id", session.id).eq("owner_id", ownerId).order("seq", { ascending: true });
 if (error) return res.status(500).json({ error: "Could not load session activity." });
 res.json((data || []).map((row: any) => ({ type: row.type, sessionId: row.session_id, seq: row.seq, timestamp: row.created_at, actor: { type: row.actor_type, id: row.actor_id }, payload: row.payload })));
});
app.post("/api/v1/sessions/:id/commands", async (req, res) => {
 const ownerId = (req as any).user.id as string;
 const s = await ownedSession(req.params.id, ownerId).catch(() => null);
 if (!s) return res.status(404).json({ error: "Session not found" });
 const cached = sessions.find(x => x.id === s.id); if (cached) Object.assign(cached, s); else sessions.unshift(s);
 const type = String(req.body?.type || "");
 const payload = req.body?.payload && typeof req.body.payload === "object" ? req.body.payload : {};
 if (type === "instruction.add") {
   const text = typeof payload.text === "string" ? payload.text.trim() : "";
   if (!text) return res.status(400).json({ error: "Instruction cannot be empty." });
   if (text.length > 8000) return res.status(400).json({ error: "Instruction is too long (maximum 8000 characters)." });
   const saved = await supabase.from("session_instructions").insert({ session_id: s.id, owner_id: ownerId, body: text });
   if (saved.error) return res.status(500).json({ error: "Could not save instruction." });
   instructions.set(s.id, [...(instructions.get(s.id) || []), text]);
   await addEvent(s.id, type, { text }, "user");
 } else if (type === "agent.start" || type === "agent.resume") {
   const credentials = req.body?.credentials && typeof req.body.credentials === "object" ? req.body.credentials : {};
   const provider = typeof credentials.provider === "string" ? credentials.provider : "openai";
   const providerKey = typeof credentials.providerKey === "string" ? credentials.providerKey.trim() : "";
   const model = typeof credentials.model === "string" ? credentials.model.trim() : "";
   const openaiKey = providerKey;
   const githubToken = typeof credentials.githubToken === "string" ? credentials.githubToken.trim() : "";
   if (!openaiKey || !githubToken) return res.status(400).json({ error: "Enter the selected AI provider API key and your GitHub token before starting. Credentials are used for this run and are not saved in session records." });
   if (!["openai","anthropic","gemini","openrouter"].includes(provider)) return res.status(400).json({ error: "Unsupported AI provider." });
   if (!s.repository) return res.status(400).json({ error: "Add a GitHub repository (owner/repo) when creating the session first." });
   const instructionRows = await supabase.from("session_instructions").select("body").eq("session_id", s.id).eq("owner_id", ownerId).order("created_at", { ascending: true });
   if (instructionRows.error) return res.status(500).json({ error: "Could not load instructions." });
   instructions.set(s.id, (instructionRows.data || []).map((x: any) => x.body));
   if (!(instructions.get(s.id) || []).length) return res.status(400).json({ error: "Add an instruction before starting the agent." });
   if (s.status === "running") return res.status(409).json({ error: "Agent is already running." });
   cancelled.delete(s.id); paused.delete(s.id); s.status = "running";
   await supabase.from("sessions").update({ status: "running", updated_at: new Date().toISOString() }).eq("id", s.id).eq("owner_id", ownerId);
   await addEvent(s.id, type, { status: "running" }, "user");
   void runAgent(s, { provider, providerKey: openaiKey, model, githubToken });
 } else if (type === "agent.pause") {
   paused.add(s.id); s.status = "paused"; await supabase.from("sessions").update({ status: s.status, updated_at: new Date().toISOString() }).eq("id", s.id).eq("owner_id", ownerId); await addEvent(s.id, type, { status: s.status }, "user");
 } else if (type === "agent.cancel") {
   cancelled.add(s.id); paused.delete(s.id); s.status = "cancelled"; await supabase.from("sessions").update({ status: s.status, updated_at: new Date().toISOString() }).eq("id", s.id).eq("owner_id", ownerId); await addEvent(s.id, type, { status: s.status }, "user");
 } else return res.status(400).json({ error: "Unknown command type" });
 const update = await supabase.from("sessions").update({ status: s.status, branch: s.branch || null, updated_at: new Date().toISOString() }).eq("id", s.id).eq("owner_id", ownerId);
 if (update.error) return res.status(500).json({ error: "Could not persist session state." });
 res.json({ ok: true, session: s });
});

async function addEvent(sessionId: string, type: string, payload: Record<string, unknown>, actor: "user" | "agent" | "system") {
 const session = sessions.find(x => x.id === sessionId); if (!session) return null;
 const { data: latest } = await supabase.from("session_events").select("seq").eq("session_id", sessionId).order("seq", { ascending: false }).limit(1).maybeSingle();
 const seq = Number(latest?.seq || 0) + 1, timestamp = new Date().toISOString();
 const event: Event = { type, sessionId, seq, timestamp, actor: { type: actor, id: actor === "user" ? session.ownerId : actor }, payload };
 const { error } = await supabase.from("session_events").insert({ session_id: sessionId, owner_id: session.ownerId, seq, type, actor_type: actor, actor_id: event.actor.id, payload, created_at: timestamp });
 if (error) { console.error("Could not persist session event:", error.message); return null; }
 const list = events.get(sessionId) || []; list.push(event); events.set(sessionId, list); io.to(sessionId).emit("session.event", event); return event;
}
type AgentCredentials = { provider: string; providerKey: string; model: string; githubToken: string };
async function github(path: string, token: string, init: RequestInit = {}) {
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
   await addEvent(id, "agent.started", { repository: repo, message: "Inspecting repository and preparing a change." }, "agent");
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
   await addEvent(id, "agent.analyzing", { fileCount: contents.length, message: "Sending repository context to the model." }, "agent");
   const model = credentials.model || ({ openai: "gpt-4.1-mini", anthropic: "claude-sonnet-4-20250514", gemini: "gemini-2.5-flash", openrouter: "openai/gpt-4.1-mini" } as Record<string,string>)[credentials.provider];
   let outputText = "";
   if (credentials.provider === "anthropic") {
     const response = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": credentials.providerKey, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model, max_tokens: 8192, system: "You produce safe, minimal code edits as JSON. Return valid JSON only.", messages: [{ role: "user", content: prompt }] }) });
     const data = await response.json().catch(() => ({})) as any;
     if (!response.ok) throw new Error("Anthropic API " + response.status + ": " + (data.error?.message || "request failed"));
     outputText = (data.content || []).filter((x:any)=>x.type==="text").map((x:any)=>x.text).join("\n");
   } else if (credentials.provider === "gemini") {
     const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(credentials.providerKey), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ systemInstruction: { parts: [{ text: "You produce safe, minimal code edits as JSON. Return valid JSON only." }] }, contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, responseMimeType: "application/json" } }) });
     const data = await response.json().catch(() => ({})) as any;
     if (!response.ok) throw new Error("Gemini API " + response.status + ": " + (data.error?.message || "request failed"));
     outputText = data.candidates?.[0]?.content?.parts?.map((x:any)=>x.text || "").join("\n") || "{}";
   } else {
     const endpoint = credentials.provider === "openrouter" ? "https://openrouter.ai/api/v1/chat/completions" : "https://api.openai.com/v1/chat/completions";
     const response = await fetch(endpoint, { method: "POST", headers: { Authorization: "Bearer " + credentials.providerKey, "Content-Type": "application/json", ...(credentials.provider === "openrouter" ? { "HTTP-Referer": process.env.PUBLIC_APP_URL || "https://multiplayer-agent-app.onrender.com", "X-Title": "Multiplayer Agent" } : {}) }, body: JSON.stringify({ model, temperature: 0.1, response_format: { type: "json_object" }, messages: [{ role: "system", content: "You produce safe, minimal code edits as JSON." }, { role: "user", content: prompt }] }) });
     const data = await response.json().catch(() => ({})) as any;
     if (!response.ok) throw new Error((credentials.provider === "openrouter" ? "OpenRouter" : "OpenAI") + " API " + response.status + ": " + (data.error?.message || "request failed"));
     outputText = data.choices?.[0]?.message?.content || "{}";
   }
   const output = JSON.parse(outputText.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""));
   if (cancelled.has(id)) throw new Error("Task cancelled.");
   const edits = Array.isArray(output.edits) ? output.edits.filter((e: any) => contents.some(f => f.path === e.path) && typeof e.content === "string") : [];
   if (!edits.length) { await addEvent(id, "agent.completed", { summary: output.summary || "No safe file edits were proposed.", notes: output.notes || [] }, "agent"); session.status = "completed"; await supabase.from("sessions").update({ status: "completed", updated_at: new Date().toISOString() }).eq("id", id).eq("owner_id", session.ownerId); return; }
   const branch = "agent/" + id.slice(0, 8);
   await github("/repos/" + owner + "/" + name + "/git/refs/heads/" + encodeURIComponent(base), credentials.githubToken).catch(async () => null);
   const baseRef = await github("/repos/" + owner + "/" + name + "/git/ref/heads/" + encodeURIComponent(base), credentials.githubToken);
   await github("/repos/" + owner + "/" + name + "/git/refs", credentials.githubToken, { method: "POST", body: JSON.stringify({ ref: "refs/heads/" + branch, sha: baseRef.object.sha }) });
   session.branch = branch;
   await addEvent(id, "agent.changes_proposed", { summary: output.summary || "Prepared changes.", files: edits.map((e: any) => e.path), branch }, "agent");
   for (const edit of edits) {
     if (cancelled.has(id)) throw new Error("Task cancelled before all edits were committed.");
     await waitWhilePaused(id);
     const original = contents.find(f => f.path === edit.path)!;
     await github("/repos/" + owner + "/" + name + "/contents/" + edit.path.split("/").map(encodeURIComponent).join("/"), credentials.githubToken, { method: "PUT", body: JSON.stringify({ message: "agent: " + String(output.summary || "implement requested changes").slice(0, 60), content: Buffer.from(edit.content, "utf8").toString("base64"), branch, sha: original.sha }) });
     await addEvent(id, "agent.file_committed", { path: edit.path, branch }, "agent");
   }
   addEvent(id, "agent.completed", { summary: output.summary || "Changes committed to a separate branch.", branch, compareUrl: "https://github.com/" + repo + "/compare/" + base + "..." + branch, notes: output.notes || [], warning: "Review the branch and run tests before merging. The agent has not run your project's test suite." }, "agent");
   session.status = "completed";
   await supabase.from("sessions").update({ status: "completed", branch, updated_at: new Date().toISOString() }).eq("id", id).eq("owner_id", session.ownerId);
 } catch (error) {
   session.status = cancelled.has(id) ? "cancelled" : "failed";
   await addEvent(id, "agent.failed", { error: error instanceof Error ? error.message : String(error) }, "agent");
   await supabase.from("sessions").update({ status: session.status, updated_at: new Date().toISOString() }).eq("id", id).eq("owner_id", session.ownerId);
 }
}
function waitWhilePaused(id: string): Promise<void> {
 return new Promise((resolve, reject) => {
   const check = () => { if (cancelled.has(id)) return reject(new Error("Task cancelled.")); if (!paused.has(id)) return resolve(); setTimeout(check, 500); };
   check();
 });
}
io.use(async (socket, next) => {
 const token = typeof socket.handshake.auth?.token === "string" ? socket.handshake.auth.token : "";
 if (!token) return next(new Error("Unauthorized"));
 const { data, error } = await supabase.auth.getUser(token);
 if (error || !data.user) return next(new Error("Unauthorized"));
 (socket.data as any).userId = data.user.id; next();
});
io.on("connection", socket => { socket.on("session.join", async (data: {sessionId?: string}) => {
 const sessionId = data?.sessionId; if (!sessionId) return;
 const { data: row, error } = await supabase.from("sessions").select("id").eq("id", sessionId).eq("owner_id", socket.data.userId).maybeSingle();
 if (!error && row) socket.join(sessionId);
}); });
const port = Number(process.env.PORT || process.env.API_PORT || 4000);
server.listen(port, "0.0.0.0", () => console.log("API listening on", port));
