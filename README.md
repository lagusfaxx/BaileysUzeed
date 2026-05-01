# BaileysUzeed

WhatsApp gateway service for **uzeed**. Owns one persistent Baileys (WhatsApp Web) connection per registered professional and bridges messages in/out via:

- **REST API** — uzeed → baileys (request QR, send message, query status).
- **Webhooks** — baileys → uzeed (incoming message, status change, ban alert, shadowban warning).

Designed to run as an independent container in Coolify, sharing only the postgres database and redis instance with the uzeed monolith.

## Why a separate service

Baileys keeps a long-lived websocket per number. Running that inside a Next.js / Express app that gets redeployed on every push would drop sessions and force professionals to re-scan their QR. A standalone service with its own deploy cadence and lifecycle keeps connections stable.

## Architecture

```
 uzeed UI ──► uzeed/api ──► BullMQ (rate-limited) ──► REST ──► baileysuzeed ──► WhatsApp
                                                                    │
                  webhooks ◄──────────────────────────────────────┘
```

- **Outgoing**: uzeed enqueues a message in BullMQ. A worker drains the queue at <100 msg/min globally with 5 in-flight, calls `POST /messages/send`, baileys humanizes (read delay + typing) and dispatches.
- **Incoming**: baileys receives `messages.upsert`, signs a webhook with HMAC-SHA256 and POSTs to `/webhooks/whatsapp/incoming`.
- **State**: each connection lives in an in-memory `Map<professionalId, BaileysSocket>`. Auth keys persist in postgres (`whatsapp_session_creds` + `whatsapp_session_keys`) so containers can restart without forcing re-scan.

## Endpoints

All endpoints require `Authorization: Bearer ${INTERNAL_API_SECRET}` (shared with uzeed).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/sessions/:professionalId/connect` | Spin up a Baileys socket; QR is delivered via webhook + queryable state. |
| `POST` | `/sessions/:professionalId/disconnect` | Tear down socket and mark `disconnected`. |
| `POST` | `/sessions/:professionalId/logout` | Force baileys to log out (revokes the linked-device on the user's phone). |
| `GET`  | `/sessions/:professionalId` | Current state (`disconnected`, `qr_pending`, `connecting`, `warmup`, `active`, `rate_limited`, `banned`, `error`) plus QR if pending. |
| `POST` | `/messages/send` | Send a text message. Body: `{ professionalId, toPhone, body, conversationId, messageId }`. |
| `GET`  | `/health` | Liveness. |
| `GET`  | `/ready` | Readiness (DB + Redis + at least one session). |

## Webhooks emitted

POSTed to `${UZEED_WEBHOOK_URL}/<event>` with header `X-Baileys-Signature: sha256=<hmac>`.

| Event | Path | Trigger |
|---|---|---|
| `incoming` | `/webhooks/whatsapp/incoming` | New message from a contact. |
| `status` | `/webhooks/whatsapp/status` | Session state change (`qr_pending`, `active`, `banned`…). |
| `qr` | `/webhooks/whatsapp/qr` | Fresh QR string (also `qr_image_data_url`). |
| `ack` | `/webhooks/whatsapp/ack` | Delivery / read receipts. |
| `shadowban` | `/webhooks/whatsapp/shadowban` | Excess undelivered messages detected. |

## Anti-ban posture

- **Warmup**: per-day cap (20/30/50/80/120/180/250) for first 7 days; uzeed's worker honours this before enqueueing.
- **Humanization**: gaussian read delay before sending, then typing indicator for ~300ms/word with jitter.
- **Circadian rest**: refuse to send between `QUIET_HOURS_START` and `QUIET_HOURS_END` (defaults 02–08 local).
- **Reconnect**: exponential backoff (1s → 2s → 4s → … cap 60s, max 5 attempts) before flagging `banned`.
- **Shadowban detection**: hourly scan; if >5 of last 100 outgoing in last hour stayed undelivered, fire `shadowban` webhook.
- **Health check**: every 5 min, send a silent presence update; revive dead sockets that should be active.

## Local development

```bash
cp .env.example .env
# fill INTERNAL_API_SECRET, WEBHOOK_SECRET, DATABASE_URL, REDIS_URL
npm install
npm run dev
```

The first time a session connects, the QR is emitted via the `qr` webhook *and* available at `GET /sessions/:professionalId`.

## Database tables

Two tables, created automatically on first boot if missing:

```sql
CREATE TABLE whatsapp_session_creds (
  session_id  UUID PRIMARY KEY,
  creds       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE whatsapp_session_keys (
  session_id  UUID NOT NULL,
  key_type    TEXT NOT NULL,
  key_id      TEXT NOT NULL,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, key_type, key_id)
);
```

Other WhatsApp-related tables (`WhatsAppSession`, `WhatsAppConversation`, `WhatsAppMessage`, `Proxy`) are owned and migrated by the uzeed monolith via Prisma.
