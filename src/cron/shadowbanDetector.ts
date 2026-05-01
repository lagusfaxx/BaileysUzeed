import { redis } from "../redis";
import { sessionManager } from "../session/sessionManager";
import { dispatchWebhook } from "../webhooks/dispatcher";
import { logger } from "../logger";

const WINDOW_MIN = 60;
const SAMPLE_SIZE = 100;
const UNDELIVERED_THRESHOLD = 5;

/**
 * Shadowban heuristic. Whatsapp can stop relaying a number's messages
 * silently — the bot keeps "sending" successfully but recipients never
 * see anything. We track outgoing message ids in a redis sorted set and
 * remove them as `delivered`/`read` acks come in. If the residue in the
 * last hour exceeds UNDELIVERED_THRESHOLD, fire an alert webhook so the
 * uzeed admin can intervene before the cap inflates.
 *
 * Scope is per-session and per-recent-window — we don't try to catch slow
 * recipients (which would naturally have a few undelivered messages in
 * the trailing window).
 */
export async function shadowbanCheckTick(): Promise<void> {
  const sessions = sessionManager.listActive();
  const now = Date.now();
  const windowStart = now - WINDOW_MIN * 60_000;

  for (const professionalId of sessions) {
    const key = `wa:outgoing:${professionalId}`;

    // total in window
    const undelivered = await redis.zcount(key, windowStart, now).catch(() => 0);
    // sample size: total entries (kept TTL'd at 6h, so this is bounded)
    const total = await redis.zcard(key).catch(() => 0);
    const sample = Math.min(total, SAMPLE_SIZE);

    if (undelivered > UNDELIVERED_THRESHOLD) {
      logger.warn(
        { professionalId, undelivered, sample },
        "[shadowban] suspected shadowban",
      );
      void dispatchWebhook("shadowban", {
        professionalId,
        undeliveredCount: undelivered,
        sampleSize: sample,
        windowMinutes: WINDOW_MIN,
      });
    }
  }
}
