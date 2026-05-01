import { pool } from "../db";
import { sessionManager } from "../session/sessionManager";
import { dispatchWebhook } from "../webhooks/dispatcher";
import { logger } from "../logger";
import { WARMUP_TOTAL_DAYS } from "../session/warmup";

/**
 * Daily warmup tick. For every session in `warmup` state, increment its
 * day counter. When day 7 finishes, the next tick promotes it to `active`.
 *
 * Runs once a day (configurable via WARMUP_ADVANCE_CRON). The actual write
 * to uzeed's `WhatsAppSession` table goes through a webhook so uzeed remains
 * the source of truth for session metadata; we only need to keep the
 * in-memory cap aligned.
 */
export async function warmupAdvanceTick(): Promise<void> {
  let rows: Array<{ professionalId: string; warmupDay: number }> = [];
  try {
    const result = await pool.query<{ professionalId: string; warmupDay: number }>(
      `SELECT "professionalId", "warmupDay"
         FROM "WhatsAppSession"
        WHERE state IN ('warmup', 'active', 'rate_limited')`,
    );
    rows = result.rows;
  } catch (err) {
    logger.debug({ err }, "[warmup-cron] WhatsAppSession query skipped");
    return;
  }

  for (const row of rows) {
    const nextDay = row.warmupDay + 1;
    sessionManager.setWarmupDay(row.professionalId, nextDay);

    void dispatchWebhook("status", {
      professionalId: row.professionalId,
      state: nextDay > WARMUP_TOTAL_DAYS ? "active" : "warmup",
      reason: nextDay > WARMUP_TOTAL_DAYS ? "warmup_completed" : "warmup_advanced",
      warmupDay: nextDay,
    });
  }
  logger.info({ count: rows.length }, "[warmup-cron] advanced");
}
