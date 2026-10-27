import { z } from "zod";

export const CommandSchema = z.object({
  sessionId: z.string().min(1),
  idempotencyKey: z.string().min(8).max(128),
  type: z.enum(["instruction.add", "agent.start", "agent.pause", "agent.resume", "agent.cancel"]),
  payload: z.record(z.unknown()).default({})
});
export type Command = z.infer<typeof CommandSchema>;

export const SessionEventSchema = z.object({
  type: z.string(),
  sessionId: z.string(),
  seq: z.number().int().positive(),
  timestamp: z.string(),
  actor: z.object({ type: z.enum(["user", "agent", "system"]), id: z.string() }),
  payload: z.record(z.unknown())
});
export type SessionEvent = z.infer<typeof SessionEventSchema>;
