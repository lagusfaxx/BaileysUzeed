import {
  AuthenticationCreds,
  AuthenticationState,
  BufferJSON,
  initAuthCreds,
  proto,
  SignalDataTypeMap,
} from "@whiskeysockets/baileys";
import { pool } from "../db";
import { logger } from "../logger";

/**
 * PostgresAuthState
 *
 * Drop-in replacement for `useMultiFileAuthState` from baileys. Instead of
 * persisting `creds.json` and `<type>-<id>.json` files in a folder, we store
 * everything in two postgres tables (created by `ensureAuthStateTables`):
 *
 *   whatsapp_session_creds(session_id PK, creds JSONB)
 *   whatsapp_session_keys(session_id, key_type, key_id, value JSONB)
 *
 * The reason this is custom: baileys' default file-based store would lose
 * keys whenever the container restarts on Coolify, forcing professionals to
 * re-scan the QR every deploy. With postgres-backed auth, the linked-device
 * survives container churn.
 *
 * Buffer / proto serialization mirrors useMultiFileAuthState exactly:
 * - JSON.stringify(value, BufferJSON.replacer) on write
 * - JSON.parse(text, BufferJSON.reviver) on read
 * - app-state-sync-key values rehydrate via proto.Message.AppStateSyncKeyData.fromObject
 */
export interface PostgresAuthStateHandle {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  removeAll: () => Promise<void>;
}

export async function usePostgresAuthState(
  sessionId: string,
): Promise<PostgresAuthStateHandle> {
  const creds = (await readCreds(sessionId)) || initAuthCreds();

  const get: AuthenticationState["keys"]["get"] = async (type, ids) => {
    const out: { [_: string]: SignalDataTypeMap[typeof type] } = {};
    if (ids.length === 0) return out;

    const { rows } = await pool.query<{ key_id: string; value: unknown }>(
      `SELECT key_id, value FROM whatsapp_session_keys
        WHERE session_id = $1 AND key_type = $2 AND key_id = ANY($3::text[])`,
      [sessionId, type, ids],
    );

    for (const row of rows) {
      let value = JSON.parse(JSON.stringify(row.value), BufferJSON.reviver);
      if (type === "app-state-sync-key" && value) {
        value = proto.Message.AppStateSyncKeyData.fromObject(value);
      }
      out[row.key_id] = value;
    }
    return out;
  };

  const set: AuthenticationState["keys"]["set"] = async (data) => {
    const operations: Promise<unknown>[] = [];
    for (const category of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
      const map = data[category];
      if (!map) continue;
      for (const id of Object.keys(map)) {
        const value = (map as Record<string, unknown>)[id];
        if (value) {
          const serialized = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
          operations.push(
            pool.query(
              `INSERT INTO whatsapp_session_keys (session_id, key_type, key_id, value, updated_at)
               VALUES ($1, $2, $3, $4::jsonb, NOW())
               ON CONFLICT (session_id, key_type, key_id)
               DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
              [sessionId, category, id, serialized],
            ),
          );
        } else {
          operations.push(
            pool.query(
              `DELETE FROM whatsapp_session_keys
                WHERE session_id = $1 AND key_type = $2 AND key_id = $3`,
              [sessionId, category, id],
            ),
          );
        }
      }
    }
    await Promise.all(operations);
  };

  const saveCreds = async () => {
    const serialized = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
    await pool.query(
      `INSERT INTO whatsapp_session_creds (session_id, creds, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (session_id)
       DO UPDATE SET creds = EXCLUDED.creds, updated_at = NOW()`,
      [sessionId, serialized],
    );
  };

  const removeAll = async () => {
    await pool.query(
      `DELETE FROM whatsapp_session_keys WHERE session_id = $1`,
      [sessionId],
    );
    await pool.query(
      `DELETE FROM whatsapp_session_creds WHERE session_id = $1`,
      [sessionId],
    );
    logger.info({ sessionId }, "[auth-state] purged");
  };

  return {
    state: { creds, keys: { get, set } },
    saveCreds,
    removeAll,
  };
}

async function readCreds(
  sessionId: string,
): Promise<AuthenticationCreds | null> {
  const { rows } = await pool.query<{ creds: unknown }>(
    `SELECT creds FROM whatsapp_session_creds WHERE session_id = $1`,
    [sessionId],
  );
  if (rows.length === 0) return null;
  return JSON.parse(JSON.stringify(rows[0].creds), BufferJSON.reviver);
}

export async function purgeAuthState(sessionId: string): Promise<void> {
  await pool.query(`DELETE FROM whatsapp_session_keys WHERE session_id = $1`, [
    sessionId,
  ]);
  await pool.query(`DELETE FROM whatsapp_session_creds WHERE session_id = $1`, [
    sessionId,
  ]);
}
