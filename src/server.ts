import express from "express";
import helmet from "helmet";
import cors from "cors";
import compression from "compression";
import rateLimit from "express-rate-limit";
import { config } from "./config";
import { logger } from "./logger";
import { sessionsRouter } from "./api/sessionsRouter";
import { messagesRouter } from "./api/messagesRouter";
import { healthRouter } from "./api/healthRouter";

export function createServer() {
  const app = express();

  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(compression());
  app.use(cors({ origin: false })); // service is internal-only — no browser callers
  app.use(express.json({ limit: "1mb" }));

  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: 600,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  app.use((req, _res, next) => {
    logger.debug({ method: req.method, path: req.path }, "[req]");
    next();
  });

  app.use(healthRouter);
  app.use(sessionsRouter);
  app.use(messagesRouter);

  app.use((req, res) => {
    res.status(404).json({ error: "NOT_FOUND", path: req.path });
  });

  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      logger.error({ err }, "[server] unhandled");
      res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    },
  );

  return app;
}
