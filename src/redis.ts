import IORedis from "ioredis";
import { config } from "./config";
import { logger } from "./logger";

export const redis = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect: false,
});

redis.on("error", (err) => {
  logger.error({ err }, "[redis] error");
});

redis.on("connect", () => {
  logger.info("[redis] connected");
});

export async function shutdownRedis(): Promise<void> {
  await redis.quit().catch(() => {});
}
