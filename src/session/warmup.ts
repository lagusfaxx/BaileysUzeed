import { redis } from "../redis";

/**
 * Warmup schedule. WhatsApp's anti-bot heuristics react to volume spikes on
 * fresh numbers; the only known-good mitigation is to grow the daily cap
 * gradually for the first week.
 *
 * Day 1: 20  Day 2: 30  Day 3: 50
 * Day 4: 80  Day 5: 120 Day 6: 180  Day 7: 250
 * Day 8+: unlimited (whatsapp's own ~1k–2k cap takes over).
 */
export const WARMUP_CAPS: Readonly<Record<number, number>> = Object.freeze({
  1: 20,
  2: 30,
  3: 50,
  4: 80,
  5: 120,
  6: 180,
  7: 250,
});

export const WARMUP_TOTAL_DAYS = 7;

export function capForDay(day: number): number {
  if (day < 1) return 0;
  if (day > WARMUP_TOTAL_DAYS) return Number.POSITIVE_INFINITY;
  return WARMUP_CAPS[day];
}

function dailyCounterKey(professionalId: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `wa:warmup:${professionalId}:${today}`;
}

export async function getMessagesSentToday(
  professionalId: string,
): Promise<number> {
  const value = await redis.get(dailyCounterKey(professionalId));
  return value ? Number(value) : 0;
}

export async function incrementMessagesSent(
  professionalId: string,
): Promise<number> {
  const key = dailyCounterKey(professionalId);
  const next = await redis.incr(key);
  if (next === 1) {
    // expire 36h from creation so the counter survives clock skew across midnight
    await redis.expire(key, 36 * 60 * 60);
  }
  return next;
}

export interface WarmupGate {
  allowed: boolean;
  day: number;
  cap: number;
  sent: number;
  reason?: "warmup_cap_reached";
}

export async function checkWarmupGate(
  professionalId: string,
  warmupDay: number,
): Promise<WarmupGate> {
  const cap = capForDay(warmupDay);
  const sent = await getMessagesSentToday(professionalId);
  if (sent >= cap) {
    return { allowed: false, day: warmupDay, cap, sent, reason: "warmup_cap_reached" };
  }
  return { allowed: true, day: warmupDay, cap, sent };
}
