import { sessionManager } from "../session/sessionManager";
import { logger } from "../logger";
import { pool } from "../db";

/**
 * Every N minutes, ping every active socket and revive any session that
 * postgres says should be active but isn't in our in-memory map. That can
 * happen after a container restart before uzeed has had a chance to call
 * /sessions/:id/connect again.
 */
export async function healthCheckTick(): Promise<void> {
  // 1. Ping live sockets
  const active = sessionManager.listActive();
  for (const professionalId of active) {
    const ok = await sessionManager.ping(professionalId);
    if (!ok) {
      logger.warn({ professionalId }, "[health] ping failed, attempting reconnect");
      try {
        await sessionManager.connect(professionalId, { warmupDay: 1 });
      } catch (err) {
        logger.error({ err, professionalId }, "[health] reconnect failed");
      }
    }
  }

  // 2. Revive missing sockets — query uzeed-owned WhatsAppSession rows
  // (read-only access; we only need professional_id + warmup_day + state).
  // The uzeed schema names the table "WhatsAppSession" with quoted casing.
  let rows: Array<{ professionalId: string; warmupDay: number }> = [];
  try {
    const result = await pool.query<{ professionalId: string; warmupDay: number }>(
      `SELECT "professionalId", "warmupDay"
         FROM "WhatsAppSession"
        WHERE state IN ('active', 'warmup', 'rate_limited')`,
    );
    rows = result.rows;
  } catch (err) {
    // Table may not exist yet (uzeed hasn't migrated). That's OK on first boot.
    logger.debug({ err }, "[health] WhatsAppSession query skipped");
    return;
  }

  for (const row of rows) {
    const snap = sessionManager.getSnapshot(row.professionalId);
    if (snap.state === "disconnected" || snap.state === "error") {
      logger.info(
        { professionalId: row.professionalId },
        "[health] reviving missing session",
      );
      try {
        await sessionManager.connect(row.professionalId, {
          warmupDay: row.warmupDay,
        });
      } catch (err) {
        logger.error(
          { err, professionalId: row.professionalId },
          "[health] revive failed",
        );
      }
    }
  }
}
