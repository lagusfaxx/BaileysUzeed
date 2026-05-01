import "dotenv/config";
import cron from "node-cron";
import { config } from "./config";
import { logger } from "./logger";
import { createServer } from "./server";
import { ensureAuthStateTables, shutdownDb } from "./db";
import { shutdownRedis } from "./redis";
import { healthCheckTick } from "./cron/healthCheck";
import { shadowbanCheckTick } from "./cron/shadowbanDetector";
import { warmupAdvanceTick } from "./cron/warmupAdvance";

async function main(): Promise<void> {
  await ensureAuthStateTables();
  logger.info("[boot] auth-state tables ready");

  const app = createServer();
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, "[boot] listening");
  });

  scheduleCrons();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "[shutdown] starting");
    server.close();
    await shutdownRedis();
    await shutdownDb();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "[unhandled-rejection]");
  });
  process.on("uncaughtException", (err) => {
    logger.error({ err }, "[uncaught-exception]");
  });
}

function scheduleCrons(): void {
  cron.schedule(`*/${config.healthCheckIntervalMin} * * * *`, () => {
    healthCheckTick().catch((err) =>
      logger.error({ err }, "[cron] health-check failed"),
    );
  });

  cron.schedule(`*/${config.shadowbanCheckIntervalMin} * * * *`, () => {
    shadowbanCheckTick().catch((err) =>
      logger.error({ err }, "[cron] shadowban-check failed"),
    );
  });

  cron.schedule(config.warmupAdvanceCron, () => {
    warmupAdvanceTick().catch((err) =>
      logger.error({ err }, "[cron] warmup-advance failed"),
    );
  });

  // initial tick a few seconds after boot, once API is listening
  setTimeout(() => {
    healthCheckTick().catch((err) =>
      logger.error({ err }, "[cron] initial health-check failed"),
    );
  }, 8_000);

  logger.info(
    {
      healthEvery: `${config.healthCheckIntervalMin}m`,
      shadowbanEvery: `${config.shadowbanCheckIntervalMin}m`,
      warmupCron: config.warmupAdvanceCron,
    },
    "[cron] scheduled",
  );
}

main().catch((err) => {
  logger.error({ err }, "[boot] failed");
  process.exit(1);
});
