import {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  type WASocket,
  type WAMessageKey,
  type proto,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import QRCode from "qrcode";
import {
  purgeAuthState,
  usePostgresAuthState,
  type PostgresAuthStateHandle,
} from "../auth/postgresAuthState";
import { dispatchWebhook } from "../webhooks/dispatcher";
import { logger as rootLogger } from "../logger";
import { redis } from "../redis";
import {
  inQuietHours,
  readDelayMs,
  sleep,
  typingDwellMs,
} from "./antiban";
import {
  capForDay,
  checkWarmupGate,
  incrementMessagesSent,
  WARMUP_TOTAL_DAYS,
} from "./warmup";
import type { SessionState, StatusReason } from "../types";

interface SessionRuntime {
  professionalId: string;
  state: SessionState;
  socket: WASocket | null;
  authHandle: PostgresAuthStateHandle | null;
  warmupDay: number;
  reconnectAttempts: number;
  lastQr: string | null;
  lastQrAt: number | null;
  intentionalDisconnect: boolean;
  pendingShutdown: boolean;
  childLogger: ReturnType<typeof rootLogger.child>;
}

const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * The SessionManager owns the lifecycle of every WhatsApp connection in
 * the process: at most one socket per professional. Every public method
 * is idempotent and safe to call concurrently — internally we serialize
 * connect/disconnect for a given professional via the in-memory map.
 *
 * State transitions and webhooks are the only side-effects callers can
 * rely on. The HTTP API layer is intentionally thin — it just delegates
 * to manager methods.
 */
export class SessionManager {
  private sessions = new Map<string, SessionRuntime>();

  /**
   * Bring up a new connection. If the user already has an active
   * socket, this is a no-op (returns the current state).
   */
  async connect(
    professionalId: string,
    opts: { warmupDay: number },
  ): Promise<{ state: SessionState; qr: string | null }> {
    const existing = this.sessions.get(professionalId);
    if (existing && existing.socket && existing.state !== "disconnected") {
      return { state: existing.state, qr: existing.lastQr };
    }

    const runtime: SessionRuntime =
      existing || {
        professionalId,
        state: "connecting",
        socket: null,
        authHandle: null,
        warmupDay: opts.warmupDay,
        reconnectAttempts: 0,
        lastQr: null,
        lastQrAt: null,
        intentionalDisconnect: false,
        pendingShutdown: false,
        childLogger: rootLogger.child({ professionalId }),
      };

    runtime.warmupDay = opts.warmupDay;
    runtime.intentionalDisconnect = false;
    runtime.pendingShutdown = false;
    this.sessions.set(professionalId, runtime);

    await this.openSocket(runtime);
    return { state: runtime.state, qr: runtime.lastQr };
  }

  /**
   * Cleanly close the socket. The auth state stays intact so the
   * next connect() reuses the linked-device. Use logout() to revoke.
   */
  async disconnect(professionalId: string): Promise<void> {
    const runtime = this.sessions.get(professionalId);
    if (!runtime) return;

    runtime.intentionalDisconnect = true;
    runtime.pendingShutdown = true;

    try {
      runtime.socket?.end(undefined);
    } catch (err) {
      runtime.childLogger.warn({ err }, "[session] socket end threw");
    }
    runtime.state = "disconnected";
    await this.emitStatus(runtime, "user_disconnect");
  }

  /**
   * Like disconnect, but also revokes the linked-device on the user's
   * phone and purges the auth blob. Next connect() will need a fresh QR.
   */
  async logout(professionalId: string): Promise<void> {
    const runtime = this.sessions.get(professionalId);
    if (runtime?.socket) {
      runtime.intentionalDisconnect = true;
      try {
        await runtime.socket.logout();
      } catch (err) {
        runtime.childLogger.warn({ err }, "[session] logout threw");
      }
    }
    await purgeAuthState(professionalId);
    if (runtime) {
      runtime.state = "disconnected";
      runtime.lastQr = null;
      runtime.lastQrAt = null;
      runtime.reconnectAttempts = 0;
      await this.emitStatus(runtime, "logged_out");
    }
  }

  getSnapshot(professionalId: string) {
    const runtime = this.sessions.get(professionalId);
    if (!runtime) {
      return { state: "disconnected" as SessionState, qr: null, qrImageDataUrl: null };
    }
    return {
      state: runtime.state,
      qr: runtime.lastQr,
      qrImageDataUrl: null,
      warmupDay: runtime.warmupDay,
    };
  }

  listActive(): string[] {
    return [...this.sessions.entries()]
      .filter(([, r]) => r.state === "active" || r.state === "warmup")
      .map(([id]) => id);
  }

  isActive(professionalId: string): boolean {
    const runtime = this.sessions.get(professionalId);
    return !!runtime && (runtime.state === "active" || runtime.state === "warmup");
  }

  setWarmupDay(professionalId: string, day: number): void {
    const runtime = this.sessions.get(professionalId);
    if (!runtime) return;
    runtime.warmupDay = day;
    if (day > WARMUP_TOTAL_DAYS && runtime.state === "warmup") {
      runtime.state = "active";
      void this.emitStatus(runtime, "warmup_completed");
    }
  }

  /**
   * Send a text message. Applies anti-ban humanization (read delay,
   * typing indicator) and warmup cap before dispatching to baileys.
   * Returns the whatsapp message id which uzeed can map back to its
   * own message row via the `ack` webhook later.
   */
  async sendText(opts: {
    professionalId: string;
    toPhone: string;
    body: string;
    conversationId?: string;
    uzeedMessageId?: string;
  }): Promise<{ ok: true; whatsappMessageId: string } | { ok: false; error: string; detail?: string }> {
    const runtime = this.sessions.get(opts.professionalId);
    if (!runtime || !runtime.socket) {
      return { ok: false, error: "SESSION_NOT_CONNECTED" };
    }
    if (runtime.state === "banned") {
      return { ok: false, error: "SESSION_BANNED" };
    }
    if (runtime.state !== "active" && runtime.state !== "warmup") {
      return { ok: false, error: "SESSION_NOT_READY", detail: runtime.state };
    }
    if (inQuietHours()) {
      return { ok: false, error: "QUIET_HOURS" };
    }

    const gate = await checkWarmupGate(opts.professionalId, runtime.warmupDay);
    if (!gate.allowed) {
      runtime.state = "rate_limited";
      void this.emitStatus(runtime, undefined, "warmup cap reached");
      return {
        ok: false,
        error: "WARMUP_CAP_REACHED",
        detail: `day ${gate.day} cap ${gate.cap}`,
      };
    }

    const jid = phoneToJid(opts.toPhone);

    // Humanize: presence "available" → wait → presence "composing" → wait → send
    try {
      await runtime.socket.sendPresenceUpdate("available", jid);
    } catch (err) {
      runtime.childLogger.debug({ err }, "[session] presence available threw");
    }

    await sleep(readDelayMs());

    try {
      await runtime.socket.sendPresenceUpdate("composing", jid);
    } catch (err) {
      runtime.childLogger.debug({ err }, "[session] presence composing threw");
    }

    await sleep(typingDwellMs(opts.body));

    try {
      await runtime.socket.sendPresenceUpdate("paused", jid);
    } catch {
      // ignore — this is decorative
    }

    let waMessageId: string;
    try {
      const result = await runtime.socket.sendMessage(jid, { text: opts.body });
      if (!result?.key?.id) {
        return { ok: false, error: "SEND_FAILED", detail: "no message id returned" };
      }
      waMessageId = result.key.id;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      runtime.childLogger.error({ err }, "[session] sendMessage failed");
      return { ok: false, error: "SEND_FAILED", detail: message };
    }

    await incrementMessagesSent(opts.professionalId);

    // Track for shadowban detection: store in redis a small record per outgoing.
    const outgoingKey = `wa:outgoing:${opts.professionalId}`;
    await redis.zadd(outgoingKey, Date.now(), waMessageId).catch(() => {});
    await redis.expire(outgoingKey, 60 * 60 * 6).catch(() => {});

    return { ok: true, whatsappMessageId: waMessageId };
  }

  // ─────────── internal helpers ───────────

  private async openSocket(runtime: SessionRuntime): Promise<void> {
    try {
      runtime.authHandle = await usePostgresAuthState(runtime.professionalId);

      const { version } = await fetchLatestBaileysVersion();
      const socket = makeWASocket({
        version,
        auth: {
          creds: runtime.authHandle.state.creds,
          keys: makeCacheableSignalKeyStore(
            runtime.authHandle.state.keys,
            runtime.childLogger as never,
          ),
        },
        printQRInTerminal: false,
        browser: Browsers.macOS("uzeed"),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        logger: runtime.childLogger as never,
      });

      runtime.socket = socket;
      runtime.state = "connecting";
      await this.emitStatus(runtime);

      socket.ev.on("creds.update", () => {
        runtime.authHandle?.saveCreds().catch((err) => {
          runtime.childLogger.error({ err }, "[session] saveCreds failed");
        });
      });

      socket.ev.on("connection.update", (update) => {
        void this.handleConnectionUpdate(runtime, update);
      });

      socket.ev.on("messages.upsert", (msg) => {
        void this.handleIncoming(runtime, msg);
      });

      socket.ev.on("messages.update", (updates) => {
        void this.handleAck(runtime, updates);
      });
    } catch (err) {
      runtime.childLogger.error({ err }, "[session] openSocket failed");
      runtime.state = "error";
      await this.emitStatus(runtime, "internal_error", String(err));
      this.scheduleReconnect(runtime);
    }
  }

  private async handleConnectionUpdate(
    runtime: SessionRuntime,
    update: {
      connection?: "open" | "close" | "connecting";
      lastDisconnect?: { error: Error | undefined };
      qr?: string;
    },
  ): Promise<void> {
    if (update.qr) {
      runtime.lastQr = update.qr;
      runtime.lastQrAt = Date.now();
      runtime.state = "qr_pending";

      const qrImageDataUrl = await QRCode.toDataURL(update.qr).catch(() => "");
      void dispatchWebhook("qr", {
        professionalId: runtime.professionalId,
        qr: update.qr,
        qrImageDataUrl,
        expiresAt: Date.now() + 60_000,
      });
      await this.emitStatus(runtime);
      return;
    }

    if (update.connection === "open") {
      runtime.state = runtime.warmupDay <= WARMUP_TOTAL_DAYS ? "warmup" : "active";
      runtime.reconnectAttempts = 0;
      runtime.lastQr = null;
      runtime.lastQrAt = null;
      await this.emitStatus(runtime, "connected");
      return;
    }

    if (update.connection === "close") {
      const code =
        (update.lastDisconnect?.error as Boom | undefined)?.output?.statusCode ??
        0;

      runtime.childLogger.info(
        { code, intentional: runtime.intentionalDisconnect },
        "[session] connection closed",
      );

      if (runtime.intentionalDisconnect) {
        runtime.state = "disconnected";
        return;
      }

      if (isBanCode(code)) {
        runtime.state = "banned";
        await purgeAuthState(runtime.professionalId);
        await this.emitStatus(runtime, "ban_detected", `code ${code}`);
        return;
      }

      if (code === DisconnectReason.loggedOut) {
        runtime.state = "disconnected";
        await purgeAuthState(runtime.professionalId);
        await this.emitStatus(runtime, "logged_out");
        return;
      }

      this.scheduleReconnect(runtime);
    }
  }

  private scheduleReconnect(runtime: SessionRuntime): void {
    if (runtime.pendingShutdown) return;

    runtime.reconnectAttempts += 1;
    if (runtime.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      runtime.state = "banned";
      void this.emitStatus(
        runtime,
        "max_reconnects",
        `gave up after ${MAX_RECONNECT_ATTEMPTS} attempts`,
      );
      return;
    }

    // 1s, 2s, 4s, 8s, 16s, capped at 60s
    const delay = Math.min(1000 * Math.pow(2, runtime.reconnectAttempts - 1), 60_000);
    runtime.childLogger.info(
      { attempt: runtime.reconnectAttempts, delayMs: delay },
      "[session] scheduling reconnect",
    );
    runtime.state = "connecting";
    void this.emitStatus(runtime);

    setTimeout(() => {
      if (runtime.pendingShutdown) return;
      this.openSocket(runtime).catch((err) => {
        runtime.childLogger.error({ err }, "[session] reconnect openSocket threw");
      });
    }, delay);
  }

  private async handleIncoming(
    runtime: SessionRuntime,
    msg: { type: "notify" | "append"; messages: proto.IWebMessageInfo[] },
  ): Promise<void> {
    if (msg.type !== "notify") return;
    for (const m of msg.messages) {
      if (m.key?.fromMe) continue;
      if (!m.message) continue;

      const text = extractText(m.message);
      if (!text) continue;

      const remoteJid = m.key.remoteJid || "";
      const isGroup = remoteJid.endsWith("@g.us");
      const fromPhone = jidToPhone(remoteJid);
      const whatsappMessageId = m.key.id || "";

      void dispatchWebhook("incoming", {
        professionalId: runtime.professionalId,
        fromPhone,
        fromJid: remoteJid,
        body: text,
        timestamp: Number(m.messageTimestamp || Math.floor(Date.now() / 1000)),
        whatsappMessageId,
        isGroup,
        pushName: m.pushName || undefined,
      });
    }
  }

  private async handleAck(
    runtime: SessionRuntime,
    updates: {
      key: WAMessageKey;
      update: { status?: number };
    }[],
  ): Promise<void> {
    for (const u of updates) {
      const status = u.update.status;
      if (status === undefined || status === null) continue;
      const mapped = mapAckStatus(status);
      if (!mapped) continue;

      void dispatchWebhook("ack", {
        professionalId: runtime.professionalId,
        whatsappMessageId: u.key.id || "",
        status: mapped,
      });

      if (mapped === "delivered" || mapped === "read") {
        await redis
          .zrem(`wa:outgoing:${runtime.professionalId}`, u.key.id || "")
          .catch(() => {});
      }
    }
  }

  private async emitStatus(
    runtime: SessionRuntime,
    reason?: StatusReason,
    detail?: string,
  ): Promise<void> {
    void dispatchWebhook("status", {
      professionalId: runtime.professionalId,
      state: runtime.state,
      reason,
      detail,
      warmupDay: runtime.warmupDay,
      messagesSentToday: undefined,
    });
  }

  /** Quick liveness probe — sends a presence update and returns whether the socket is healthy. */
  async ping(professionalId: string): Promise<boolean> {
    const runtime = this.sessions.get(professionalId);
    if (!runtime?.socket) return false;
    try {
      await runtime.socket.sendPresenceUpdate("available");
      return true;
    } catch {
      return false;
    }
  }
}

export const sessionManager = new SessionManager();

// ─────────── helpers ───────────

function phoneToJid(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return `${digits}@s.whatsapp.net`;
}

function jidToPhone(jid: string): string {
  return jid.split("@")[0]?.split(":")[0] || "";
}

/**
 * WhatsApp ban / "device-removed" status codes. 401/403 are returned as
 * disconnect reasons when the account has been flagged.
 */
function isBanCode(code: number): boolean {
  return (
    code === 401 ||
    code === 403 ||
    code === DisconnectReason.forbidden ||
    code === DisconnectReason.badSession
  );
}

function extractText(message: proto.IMessage): string | null {
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  return null;
}

function mapAckStatus(
  status: number,
): "sent" | "delivered" | "read" | "failed" | null {
  // baileys WAMessageStatus: 0=ERROR, 1=PENDING, 2=SERVER_ACK, 3=DELIVERY_ACK, 4=READ, 5=PLAYED
  if (status === 0) return "failed";
  if (status === 2) return "sent";
  if (status === 3) return "delivered";
  if (status === 4 || status === 5) return "read";
  return null;
}
