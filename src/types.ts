export type SessionState =
  | "disconnected"
  | "qr_pending"
  | "connecting"
  | "warmup"
  | "active"
  | "rate_limited"
  | "banned"
  | "error";

export type WebhookEvent =
  | "incoming"
  | "status"
  | "qr"
  | "ack"
  | "shadowban";

export type StatusReason =
  | "user_disconnect"
  | "logged_out"
  | "ban_detected"
  | "qr_timeout"
  | "connected"
  | "warmup_advanced"
  | "warmup_completed"
  | "max_reconnects"
  | "internal_error";

export interface IncomingMessagePayload {
  professionalId: string;
  fromPhone: string;
  fromJid: string;
  body: string;
  timestamp: number;
  whatsappMessageId: string;
  isGroup: boolean;
  pushName?: string;
}

export interface StatusPayload {
  professionalId: string;
  state: SessionState;
  reason?: StatusReason;
  detail?: string;
  warmupDay?: number;
  messagesSentToday?: number;
}

export interface QrPayload {
  professionalId: string;
  qr: string;
  qrImageDataUrl: string;
  expiresAt: number;
}

export interface AckPayload {
  professionalId: string;
  whatsappMessageId: string;
  conversationId?: string;
  uzeedMessageId?: string;
  status: "sent" | "delivered" | "read" | "failed";
  detail?: string;
}

export interface ShadowbanPayload {
  professionalId: string;
  undeliveredCount: number;
  sampleSize: number;
  windowMinutes: number;
}
