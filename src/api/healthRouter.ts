import { Router } from "express";
import { pool } from "../db";
import { redis } from "../redis";
import { sessionManager } from "../session/sessionManager";

export const healthRouter = Router();

healthRouter.get("/health", (_req, res) => {
  res.json({ ok: true });
});

healthRouter.get("/ready", async (_req, res) => {
  const checks: Record<string, boolean | string> = {};
  try {
    await pool.query("SELECT 1");
    checks.db = true;
  } catch (err) {
    checks.db = (err as Error).message;
  }

  try {
    const pong = await redis.ping();
    checks.redis = pong === "PONG";
  } catch (err) {
    checks.redis = (err as Error).message;
  }

  checks.activeSessions = sessionManager.listActive().length.toString();

  const ok = checks.db === true && checks.redis === true;
  res.status(ok ? 200 : 503).json({ ok, checks });
});
