import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  env: process.env.NODE_ENV || "development",
  port: num("PORT", 3010),
  logLevel: process.env.LOG_LEVEL || "info",

  databaseUrl: required("DATABASE_URL"),
  redisUrl: required("REDIS_URL"),

  internalApiSecret: required("INTERNAL_API_SECRET"),

  uzeedWebhookUrl: required("UZEED_WEBHOOK_URL").replace(/\/$/, ""),
  webhookSecret: required("WEBHOOK_SECRET"),

  quietHoursStart: num("QUIET_HOURS_START", 2),
  quietHoursEnd: num("QUIET_HOURS_END", 8),

  readDelayMeanMs: num("READ_DELAY_MEAN_MS", 1500),
  readDelayStdevMs: num("READ_DELAY_STDEV_MS", 600),
  readDelayMinMs: num("READ_DELAY_MIN_MS", 400),
  readDelayMaxMs: num("READ_DELAY_MAX_MS", 4500),

  typingMsPerWord: num("TYPING_MS_PER_WORD", 300),
  typingJitterMs: num("TYPING_JITTER_MS", 400),

  healthCheckIntervalMin: num("HEALTH_CHECK_INTERVAL_MIN", 5),
  shadowbanCheckIntervalMin: num("SHADOWBAN_CHECK_INTERVAL_MIN", 60),
  warmupAdvanceCron: process.env.WARMUP_ADVANCE_CRON || "0 3 * * *",
};

export type AppConfig = typeof config;
