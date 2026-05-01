import crypto from "node:crypto";
import { config } from "../config";
import { logger } from "../logger";
import type {
  AckPayload,
  IncomingMessagePayload,
  QrPayload,
  ShadowbanPayload,
  StatusPayload,
  WebhookEvent,
} from "../types";

type EventPayloadMap = {
  incoming: IncomingMessagePayload;
  status: StatusPayload;
  qr: QrPayload;
  ack: AckPayload;
  shadowban: ShadowbanPayload;
};

function sign(body: string): string {
  return (
    "sha256=" +
    crypto.createHmac("sha256", config.webhookSecret).update(body).digest("hex")
  );
}

/**
 * Fire-and-retry HTTP POST. Webhooks are best-effort; we log failures but
 * never throw to callers because that would bring down the baileys event
 * loop. If uzeed is down, status updates are eventually rebuilt by the
 * health check loop on the next reconnect.
 */
export async function dispatchWebhook<E extends WebhookEvent>(
  event: E,
  payload: EventPayloadMap[E],
): Promise<void> {
  const url = `${config.uzeedWebhookUrl}/${event}`;
  const body = JSON.stringify({ event, payload, sentAt: Date.now() });
  const signature = sign(body);

  const maxAttempts = 4;
  let attempt = 0;
  let lastErr: unknown = null;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Baileys-Signature": signature,
          "X-Baileys-Event": event,
        },
        body,
        signal: AbortSignal.timeout(8_000),
      });

      if (res.ok) {
        return;
      }

      // Don't retry 4xx (usually a programming bug — we'll just spam logs)
      if (res.status >= 400 && res.status < 500) {
        logger.warn(
          { event, url, status: res.status },
          "[webhook] 4xx, not retrying",
        );
        return;
      }
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }

    if (attempt < maxAttempts) {
      const backoff = 500 * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }

  logger.error(
    { event, url, err: lastErr },
    "[webhook] giving up after retries",
  );
}
