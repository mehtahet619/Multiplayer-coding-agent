import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { randomUUID } from "node:crypto";

const app = express();
const server = createServer(app);
const allowed = (process.env.WEB_ORIGIN || "http://localhost:5173").split(",");
app.use(cors({ origin: allowed, credentials: true }));
app.use(express.json({ limit: "1mb" }));
const io = new Server(server, { cors: { origin: allowed } });
type Session = { id: string; title: string; status: string; createdAt: string };
type Event = { type: string; sessionId: string; seq: number; timestamp: string; actor: { type: "user" | "agent" | "system"; id: string }; payload: Record<string, unknown> };
const sessions: Session[] = [];
const events = new Map<string, Event[]>();
app.get("/health", (_req, res) => res.json({ ok: true, service: "multiplayer-coding-agent-api" }));
app.get("/api/v1/sessions", (_req, res) => res.json(sessions));
app.post("/api/v1/sessions", (req, res) => {
 const session: Session = { id: randomUUID(), title: String(req.body?.title || "Shared coding session").slice(0,120), status: "idle", createdAt: new Date().toISOString() };
 sessions.unshift(session); events.set(session.id, []);
 addEvent(session.id, "session.created", { title: session.title }, "system");
 res.status(201).json(session);
});
app.get("/api/v1/sessions/:id/events", (req, res) => {
 if (!sessions.some(s => s.id === req.params.id)) return res.status(404).json({ error: "Session not found" });
 res.json(events.get(req.params.id) || []);
});
app.post("/api/v1/sessions/:id/commands", (req, res) => {
 const s = sessions.find(x => x.id === req.params.id);
 if (!s) return res.status(404).json({ error: "Session not found" });
 const type = String(req.body?.type || "");
 const payload = req.body?.payload && typeof req.body.payload === "object" ? req.body.payload : {};
 if (type === "agent.start" || type === "agent.resume") s.status = "queued";
 else if (type === "agent.pause") s.status = "paused";
 else if (type === "agent.cancel") s.status = "cancelled";
 else if (type !== "instruction.add") return res.status(400).json({ error: "Unknown command type" });
 addEvent(s.id, type, payload, "user");
 res.json({ ok: true, session: s });
});
function addEvent(sessionId: string, type: string, payload: Record<string, unknown>, actor: "user" | "agent" | "system") {
 const list = events.get(sessionId) || [];
 const event: Event = { type, sessionId, seq: list.length + 1, timestamp: new Date().toISOString(), actor: { type: actor, id: actor === "user" ? "local-user" : actor }, payload };
 list.push(event); events.set(sessionId, list); io.to(sessionId).emit("session.event", event); return event;
}
io.on("connection", socket => { socket.on("session.join", (data: {sessionId?: string}) => { if (data?.sessionId && sessions.some(s => s.id === data.sessionId)) socket.join(data.sessionId); }); });
const port = Number(process.env.PORT || process.env.API_PORT || 4000);
server.listen(port, "0.0.0.0", () => console.log("API listening on", port));
