import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isVisitorId, newVisitorId, SessionRateLimiter, VisitorStore } from './tenancy.ts';

const T0 = Date.UTC(2026, 7, 1, 10, 0, 0); // 1 Aug 2026 10:00Z — mid-day, no midnight edge

test('visitor ids are 32-hex and unique', () => {
  const a = newVisitorId();
  const b = newVisitorId();
  assert.ok(isVisitorId(a));
  assert.ok(isVisitorId(b));
  assert.notEqual(a, b);
  assert.equal(isVisitorId('not-a-visitor-id'), false);
  assert.equal(isVisitorId(a.toUpperCase()), false);
});

test('store isolates visitors and evicts idle ones', () => {
  const store = new VisitorStore<{ n: number }>({ maxVisitors: 10, idleTtlMs: 1_000 });
  store.set('a'.repeat(32), { n: 1 }, T0);
  store.set('b'.repeat(32), { n: 2 }, T0);
  assert.equal(store.get('a'.repeat(32), T0 + 1)?.n, 1);
  assert.equal(store.get('b'.repeat(32), T0 + 1)?.n, 2);
  assert.equal(store.get('c'.repeat(32), T0 + 1), null);
  // idle past TTL → gone
  assert.equal(store.get('a'.repeat(32), T0 + 5_000), null);
  assert.equal(store.sweep(T0 + 5_000), 1); // b evicted too
  assert.equal(store.size, 0);
});

test('store caps total visitors by evicting the least recently seen', () => {
  const store = new VisitorStore<number>({ maxVisitors: 2, idleTtlMs: 60_000 });
  store.set('a'.repeat(32), 1, T0);
  store.set('b'.repeat(32), 2, T0 + 1);
  store.set('c'.repeat(32), 3, T0 + 2); // evicts a
  assert.equal(store.size, 2);
  assert.equal(store.get('a'.repeat(32), T0 + 3), null);
  assert.equal(store.get('b'.repeat(32), T0 + 3), 2);
});

test('rate limiter blocks the 4th per-visitor attempt within the hour', () => {
  const limiter = new SessionRateLimiter({ perVisitorPerHour: 3, siteWidePerDay: 20 });
  const v = 'a'.repeat(32);
  assert.deepEqual(limiter.tryAcquire(v, T0), { allowed: true });
  assert.deepEqual(limiter.tryAcquire(v, T0 + 1_000), { allowed: true });
  assert.deepEqual(limiter.tryAcquire(v, T0 + 2_000), { allowed: true });
  assert.deepEqual(limiter.tryAcquire(v, T0 + 3_000), { allowed: false, scope: 'visitor' });
  // a different visitor is unaffected
  assert.deepEqual(limiter.tryAcquire('b'.repeat(32), T0 + 3_000), { allowed: true });
  // the window rolls: an hour after the first, one slot frees up
  assert.deepEqual(limiter.tryAcquire(v, T0 + 3_601_000), { allowed: true });
});

test('blocked attempts consume no budget', () => {
  const limiter = new SessionRateLimiter({ perVisitorPerHour: 1, siteWidePerDay: 20 });
  const v = 'a'.repeat(32);
  assert.deepEqual(limiter.tryAcquire(v, T0), { allowed: true });
  for (let i = 1; i <= 5; i++) {
    assert.deepEqual(limiter.tryAcquire(v, T0 + i), { allowed: false, scope: 'visitor' });
  }
  assert.equal(limiter.counts(T0 + 10).siteToday, 1); // five refusals recorded nothing
});

test('site-wide cap binds across visitors and resets at UTC midnight', () => {
  const limiter = new SessionRateLimiter({ perVisitorPerHour: 100, siteWidePerDay: 2 });
  assert.deepEqual(limiter.tryAcquire('a'.repeat(32), T0), { allowed: true });
  assert.deepEqual(limiter.tryAcquire('b'.repeat(32), T0 + 1), { allowed: true });
  assert.deepEqual(limiter.tryAcquire('c'.repeat(32), T0 + 2), { allowed: false, scope: 'site' });
  // site cap outranks a fresh visitor's untouched hourly budget
  const nextDay = Date.UTC(2026, 7, 2, 0, 0, 1);
  assert.deepEqual(limiter.tryAcquire('c'.repeat(32), nextDay), { allowed: true });
});
