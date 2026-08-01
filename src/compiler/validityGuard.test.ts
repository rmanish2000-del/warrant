import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertNoValidityKeys, CompilerRejection, findValidityKeys } from './validityGuard.ts';

const rejects = (value: unknown, expectedPath: string) => {
  assert.throws(
    () => assertNoValidityKeys(value),
    (err: unknown) =>
      err instanceof CompilerRejection &&
      err.stage === 'validity-guard' &&
      err.message.includes(expectedPath),
  );
};

describe('validity guard — the model must not emit its own mandate lifetime', () => {
  it('rejects a top-level validity key', () => {
    rejects({ expires_at: '2026-08-08T00:00:00Z' }, '$.expires_at');
  });

  it('rejects the nested case — schema alone would not catch a permissive sub-object', () => {
    rejects(
      { constraints: { validity: { expires_at: 'x' } } },
      '$.constraints.validity',
    );
  });

  it('rejects a validity key buried inside an array of objects', () => {
    rejects(
      { clauses: [{ id: 'C1', text: 'ok' }, { id: 'C2', effectiveFrom: 'tomorrow' }] },
      '$.clauses[1].effectiveFrom',
    );
  });

  it('rejects camelCase and every pattern alternative', () => {
    for (const key of [
      'startsAt_valid',
      'expiresAt',
      'validUntil',
      'until',
      'effective_date',
      'ttlSeconds',
      'durationDays',
      'limitPeriod',
      'renewalDate',
    ]) {
      rejects({ [key]: 1 }, key);
    }
  });

  it('reports every offending path, not just the first', () => {
    const hits = findValidityKeys({ expires_at: 1, nested: { renew_on: 2 } });
    assert.deepEqual(hits, ['$.expires_at', '$.nested.renew_on']);
  });

  it('inspects keys only — values may talk about durations', () => {
    assert.doesNotThrow(() =>
      assertNoValidityKeys({
        policySummary: 'Do not exceed ₹15,000 per week; the mandate expires when revoked.',
        clauses: [{ id: 'C2', text: 'Do not exceed ₹15,000 per week.' }],
      }),
    );
  });

  it('passes a clean draft-shaped object', () => {
    assert.doesNotThrow(() =>
      assertNoValidityKeys({
        currency: 'INR',
        approvedSuppliers: ['PackRight Supplies'],
        cumulativeLimit: 15_000,
        perOrderThreshold: 5_000,
        flags: [{ id: 'f1', options: [{ key: 'A', sets: { 'C1.onUnapprovedSupplier': 'deny' } }] }],
      }),
    );
  });
});
