import { Pool } from "pg";
import { config } from "./config";
import { logger } from "./logger";

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => {
  logger.error({ err }, "[pg] idle client error");
});

/**
 * Create the auth-state tables if they don't exist. We create them ourselves
 * (rather than relying on uzeed's Prisma migration) so the baileys service
 * can boot independently against any postgres that has the connection.
 *
 * uzeed-side WhatsApp tables (WhatsAppSession, WhatsAppMessage, etc.) are
 * owned by uzeed's prisma schema; we never touch them from here.
 */
export async function ensureAuthStateTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_session_creds (
      session_id  UUID PRIMARY KEY,
      creds       JSONB NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_session_keys (
      session_id  UUID NOT NULL,
      key_type    TEXT NOT NULL,
      key_id      TEXT NOT NULL,
      value       JSONB NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (session_id, key_type, key_id)
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS whatsapp_session_keys_by_session
      ON whatsapp_session_keys(session_id);
  `);
}

export async function shutdownDb(): Promise<void> {
  await pool.end().catch(() => {});
}
