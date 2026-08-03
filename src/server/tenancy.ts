/**
 * Public-demo tenancy — visitor isolation and payment rate limiting.
 *
 * Each visitor is a random 128-bit id carried in an HttpOnly cookie. The id
 * carries no data, so it needs no signature: possession of the id IS the
 * session, and ids are unguessable. State is in-memory per process — the
 * public demo runs as one persistent Node process by design (the flow keeps
 * live payment watchers; serverless recycling would corrupt a run mid-click).
 *
 * The rate limiter guards the founder's sandbox card (30 transactions/day,
 * organizer-issued): session creation is capped per visitor per rolling hour
 * and site-wide per UTC day. Counters live here, outside the flows, so a
 * visitor restarting their demo run keeps their spent budget.
 */
import { randomBytes } from 'node:crypto';

export const newVisitorId = (): string => randomBytes(16).toString('hex');

/** Strict cookie-value shape: exactly 32 lowercase hex chars. */
export const isVisitorId = (value: string): boolean => /^[0-9a-f]{32}$/.test(value);

interface VisitorRecord<T> {
  value: T;
  lastSeenAt: number;
}

/**
 * Bounded per-visitor state. Idle visitors are evicted after `idleTtlMs`;
 * when `maxVisitors` is exceeded the least-recently-seen visitor is evicted.
 * Eviction only drops the map entry — an in-flight payment watcher holds its
 * own reference and self-terminates on the provider's session expiry.
 */
export class VisitorStore<T> {
  readonly #maxVisitors: number;
  readonly #idleTtlMs: number;
  readonly #map = new Map<string, VisitorRecord<T>>();

  constructor(options: { maxVisitors: number; idleTtlMs: number }) {
    this.#maxVisitors = options.maxVisitors;
    this.#idleTtlMs = options.idleTtlMs;
  }

  get(id: string, now: number): T | null {
    const record = this.#map.get(id);
    if (!record) return null;
    if (now - record.lastSeenAt > this.#idleTtlMs) {
      this.#map.delete(id);
      return null;
    }
    record.lastSeenAt = now;
    return record.value;
  }

  set(id: string, value: T, now: number): void {
    this.#map.set(id, { value, lastSeenAt: now });
    if (this.#map.size > this.#maxVisitors) {
      let oldestId: string | null = null;
      let oldestSeen = Infinity;
      for (const [key, record] of this.#map) {
        if (record.lastSeenAt < oldestSeen) {
          oldestSeen = record.lastSeenAt;
          oldestId = key;
        }
      }
      if (oldestId !== null) this.#map.delete(oldestId);
    }
  }

  /** Drop idle visitors; returns how many were evicted. */
  sweep(now: number): number {
    let evicted = 0;
    for (const [key, record] of this.#map) {
      if (now - record.lastSeenAt > this.#idleTtlMs) {
        this.#map.delete(key);
        evicted += 1;
      }
    }
    return evicted;
  }

  get size(): number {
    return this.#map.size;
  }
}

export interface RateLimitConfig {
  readonly perVisitorPerHour: number;
  readonly siteWidePerDay: number;
}

export type RateDecision = { allowed: true } | { allowed: false; scope: 'visitor' | 'site' };

const HOUR_MS = 3_600_000;

const utcMidnight = (now: number): number => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

/**
 * Counts payment-session creations. `tryAcquire` both checks and records:
 * a refusal records nothing, so blocked attempts never consume budget.
 * Site-wide window is the UTC calendar day (matches the on-screen sentence
 * "for today"); per-visitor window is a rolling hour.
 */
export class SessionRateLimiter {
  readonly #config: RateLimitConfig;
  readonly #byVisitor = new Map<string, number[]>();
  #site: number[] = [];

  constructor(config: RateLimitConfig) {
    this.#config = config;
  }

  tryAcquire(visitorId: string, now: number): RateDecision {
    this.#site = this.#site.filter((t) => t >= utcMidnight(now));
    if (this.#site.length >= this.#config.siteWidePerDay) return { allowed: false, scope: 'site' };

    const visitorTimes = (this.#byVisitor.get(visitorId) ?? []).filter((t) => t > now - HOUR_MS);
    if (visitorTimes.length >= this.#config.perVisitorPerHour) {
      this.#byVisitor.set(visitorId, visitorTimes);
      return { allowed: false, scope: 'visitor' };
    }

    visitorTimes.push(now);
    this.#byVisitor.set(visitorId, visitorTimes);
    this.#site.push(now);
    return { allowed: true };
  }

  /** Observability only — never rendered to visitors. */
  counts(now: number): { siteToday: number } {
    return { siteToday: this.#site.filter((t) => t >= utcMidnight(now)).length };
  }
}
