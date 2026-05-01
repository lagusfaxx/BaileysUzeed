import pino from "pino";
import { config } from "./config";

export const logger = pino({
  level: config.logLevel,
  base: { service: "baileysuzeed" },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(config.env === "development"
    ? {
        transport: {
          target: "pino/file",
          options: { destination: 1 },
        },
      }
    : {}),
});

export type Logger = typeof logger;
