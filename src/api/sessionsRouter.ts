import { Router } from "express";
import { z } from "zod";
import QRCode from "qrcode";
import { sessionManager } from "../session/sessionManager";
import { asyncHandler, requireInternalAuth } from "./middleware";
import { logger } from "../logger";

export const sessionsRouter = Router();

sessionsRouter.use(requireInternalAuth);

const connectSchema = z.object({
  warmupDay: z.number().int().min(1).max(99).optional(),
});

const uuidParam = z.string().uuid();

sessionsRouter.post(
  "/sessions/:professionalId/connect",
  asyncHandler(async (req, res) => {
    const professionalId = uuidParam.parse(req.params.professionalId);
    const body = connectSchema.parse(req.body || {});
    const warmupDay = body.warmupDay ?? 1;

    const result = await sessionManager.connect(professionalId, { warmupDay });
    const qrImageDataUrl = result.qr ? await QRCode.toDataURL(result.qr) : null;

    res.json({
      ok: true,
      professionalId,
      state: result.state,
      qr: result.qr,
      qrImageDataUrl,
    });
  }),
);

sessionsRouter.post(
  "/sessions/:professionalId/disconnect",
  asyncHandler(async (req, res) => {
    const professionalId = uuidParam.parse(req.params.professionalId);
    await sessionManager.disconnect(professionalId);
    res.json({ ok: true });
  }),
);

sessionsRouter.post(
  "/sessions/:professionalId/logout",
  asyncHandler(async (req, res) => {
    const professionalId = uuidParam.parse(req.params.professionalId);
    await sessionManager.logout(professionalId);
    res.json({ ok: true });
  }),
);

sessionsRouter.get(
  "/sessions/:professionalId",
  asyncHandler(async (req, res) => {
    const professionalId = uuidParam.parse(req.params.professionalId);
    const snap = sessionManager.getSnapshot(professionalId);
    const qrImageDataUrl = snap.qr ? await QRCode.toDataURL(snap.qr) : null;
    res.json({ ...snap, professionalId, qrImageDataUrl });
  }),
);

const warmupSchema = z.object({
  warmupDay: z.number().int().min(1).max(99),
});

sessionsRouter.post(
  "/sessions/:professionalId/warmup-day",
  asyncHandler(async (req, res) => {
    const professionalId = uuidParam.parse(req.params.professionalId);
    const { warmupDay } = warmupSchema.parse(req.body || {});
    sessionManager.setWarmupDay(professionalId, warmupDay);
    res.json({ ok: true, warmupDay });
  }),
);

sessionsRouter.get(
  "/sessions",
  asyncHandler(async (_req, res) => {
    const ids = sessionManager.listActive();
    res.json({ active: ids, count: ids.length });
  }),
);

sessionsRouter.use((err: unknown, _req: unknown, res: any, _next: unknown) => {
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: "INVALID_REQUEST", issues: err.issues });
    return;
  }
  logger.error({ err }, "[sessions-router] unhandled error");
  res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
});
