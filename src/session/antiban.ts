import { config } from "../config";

/**
 * Sample a gaussian (Box–Muller) and clamp to [min, max]. We use this for
 * "read delay" — the pause before sending — to mimic a person reading the
 * message they're replying to. A flat constant is the most obvious bot tell.
 */
export function gaussianMs(
  mean: number,
  stdev: number,
  min: number,
  max: number,
): number {
  const u1 = Math.max(Math.random(), 1e-9);
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const sample = mean + z * stdev;
  return Math.round(Math.min(Math.max(sample, min), max));
}

export function readDelayMs(): number {
  return gaussianMs(
    config.readDelayMeanMs,
    config.readDelayStdevMs,
    config.readDelayMinMs,
    config.readDelayMaxMs,
  );
}

/**
 * Typing dwell scales with content length and gets some noise so two
 * 5-word messages don't go out with identical "typing" times.
 */
export function typingDwellMs(text: string): number {
  const words = Math.max(1, text.trim().split(/\s+/).length);
  const base = words * config.typingMsPerWord;
  const jitter = (Math.random() * 2 - 1) * config.typingJitterMs;
  return Math.max(400, Math.round(base + jitter));
}

/**
 * Circadian quiet hours: refuse to send between QUIET_HOURS_START and
 * QUIET_HOURS_END (in container TZ). A bot that sends at 4am every day
 * pattern-matches to whatsapp; humans mostly don't.
 */
export function inQuietHours(now: Date = new Date()): boolean {
  const hour = now.getHours();
  const start = config.quietHoursStart;
  const end = config.quietHoursEnd;
  if (start === end) return false;
  if (start < end) {
    return hour >= start && hour < end;
  }
  // window wraps midnight (e.g. 22 → 6)
  return hour >= start || hour < end;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
