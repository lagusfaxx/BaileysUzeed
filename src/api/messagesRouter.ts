import { Router } from "express";
import { z } from "zod";
import { sessionManager } from "../session/sessionManager";
import { asyncHandler, requireInternalAuth } from "./middleware";
import { logger } from "../logger";

export const messagesRouter = Router();

messagesRouter.use(requireInternalAuth);

const sendSchema = z.object({
  professionalId: z.string().uuid(),
  toPhone: z.string().min(6).max(20),
  body: z.string().min(1).max(4096),
  conversationId: z.string().uuid().optional(),
  uzeedMessageId: z.string().uuid().optional(),
});

messagesRouter.post(
  "/messages/send",
  asyncHandler(async (req, res) => {
    const input = sendSchema.parse(req.body);
    const result = await sessionManager.sendText(input);

    if (!result.ok) {
      res.status(409).json({
        ok: false,
        error: result.error,
        detail: result.detail,
      });
      return;
    }
    res.json({
      ok: true,
      whatsappMessageId: result.whatsappMessageId,
      conversationId: input.conversationId,
      uzeedMessageId: input.uzeedMessageId,
    });
  }),
);

messagesRouter.use((err: unknown, _req: unknown, res: any, _next: unknown) => {
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: "INVALID_REQUEST", issues: err.issues });
    return;
  }
  logger.error({ err }, "[messages-router] unhandled error");
  res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
});
