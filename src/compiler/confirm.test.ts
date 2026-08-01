import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { confirm, ConfirmationError, WARRANT_VALIDITY_MS } from './confirm.ts';
import { stubDraft } from './draft.ts';
import type { CompiledDraft } from './schema.ts';
import { evaluate } from '../engine/evaluate.ts';

const T0 = 1_754_000_000_000; // arbitrary fixed instant, passed in — never read from a clock

/** Stub draft answers: refuse unknown suppliers, cap absolute, cite C3 — the canonical choices. */
const CANONICAL_ANSWERS = {
  'sys-c1-c4-unknown-supplier': 'A',
  'sys-c2-c3-approval-vs-cap': 'A',
  'sys-c3-c4-citation': 'A',
} as const;

const expectBlocked = (fn: () => unknown, kind: ConfirmationError['kind'], fragment: string) => {
  assert.throws(
    fn,
    (err: unknown) =>
      err instanceof ConfirmationError && err.kind === kind && err.message.includes(fragment),
  );
};

describe('confirm() blocks — no warrant while any flag is unanswered', () => {
  it('throws with every unanswered flag id listed', () => {
    expectBlocked(() => confirm(stubDraft(), {}, T0), 'unanswered', 'sys-c1-c4-unknown-supplier');
    expectBlocked(() => confirm(stubDraft(), {}, T0), 'unanswered', 'sys-c3-c4-citation');
  });

  it('throws while even one flag remains unanswered', () => {
    const partial = { 'sys-c1-c4-unknown-supplier': 'A', 'sys-c2-c3-approval-vs-cap': 'A' };
    expectBlocked(() => confirm(stubDraft(), partial, T0), 'unanswered', 'sys-c3-c4-citation');
  });

  it('throws on an answer for a flag the draft does not contain', () => {
    const answers = { ...CANONICAL_ANSWERS, 'made-up-flag': 'A' };
    expectBlocked(() => confirm(stubDraft(), answers, T0), 'unknown-flag', 'made-up-flag');
  });

  it('throws on an answer key matching no option', () => {
    const answers = { ...CANONICAL_ANSWERS, 'sys-c1-c4-unknown-supplier': 'Z' };
    expectBlocked(() => confirm(stubDraft(), answers, T0), 'unknown-option', '"Z"');
  });

  it('throws on a non-finite confirmation time', () => {
    expectBlocked(() => confirm(stubDraft(), CANONICAL_ANSWERS, Number.NaN), 'invalid-time', 'NaN');
  });
});

describe('confirm() — answers apply and validity is system-stamped', () => {
  it('produces the canonical warrant from the stub draft', () => {
    const warrant = confirm(stubDraft(), CANONICAL_ANSWERS, T0);
    assert.deepEqual(warrant.policy, {
      approvedSuppliers: ['PackRight Supplies'],
      cumulativeCap: 15_000,
      approvalThreshold: 5_000,
      currency: 'INR',
      resolutions: {
        onUnapprovedSupplier: 'deny',
        onCapBreachDespiteApproval: 'deny',
        whenNewSupplierAboveThreshold: 'cite_C3',
      },
    });
    assert.equal(warrant.issuedAt, T0);
    assert.equal(warrant.expiresAt - warrant.issuedAt, WARRANT_VALIDITY_MS);
    assert.equal(WARRANT_VALIDITY_MS, 7 * 24 * 60 * 60 * 1000);
  });

  it('matches option keys case-insensitively — real runs returned a,b,c and A,B,C', () => {
    const lower = Object.fromEntries(
      Object.entries(CANONICAL_ANSWERS).map(([id, key]) => [id, key.toLowerCase()]),
    );
    assert.deepEqual(confirm(stubDraft(), lower, T0), confirm(stubDraft(), CANONICAL_ANSWERS, T0));
  });

  it("a chosen 'escalate' option flows into the warrant's resolutions", () => {
    const answers = { ...CANONICAL_ANSWERS, 'sys-c1-c4-unknown-supplier': 'B' };
    const warrant = confirm(stubDraft(), answers, T0);
    assert.equal(warrant.policy.resolutions.onUnapprovedSupplier, 'escalate');
  });

  it('identical inputs produce identical warrants', () => {
    assert.deepEqual(confirm(stubDraft(), CANONICAL_ANSWERS, T0), confirm(stubDraft(), CANONICAL_ANSWERS, T0));
  });
});

describe('confirm() fails closed on unresolved drafts', () => {
  it('refuses a draft whose limit was never stated', () => {
    const unresolved: CompiledDraft = { ...stubDraft(), cumulativeLimit: null };
    expectBlocked(() => confirm(unresolved, CANONICAL_ANSWERS, T0), 'unresolved-draft', 'cumulativeLimit');
  });

  it('refuses a draft with unresolved currency', () => {
    const unresolved: CompiledDraft = { ...stubDraft(), currency: null };
    expectBlocked(() => confirm(unresolved, CANONICAL_ANSWERS, T0), 'unresolved-draft', 'currency');
  });
});

describe('confirmed warrant drives the engine — end to end', () => {
  it('scenario C: the confirmed refusal choice is why the unknown vendor is denied', () => {
    const warrant = confirm(stubDraft(), CANONICAL_ANSWERS, T0);
    const ledger = [
      { supplier: 'PackRight Supplies', amount: 4_000, authorized: true },
      { supplier: 'PackRight Supplies', amount: 3_800, authorized: true },
      { supplier: 'PackRight Supplies', amount: 6_200, authorized: true },
    ];
    const verdict = evaluate(
      warrant,
      ledger,
      { supplier: 'Unknown Vendor', amount: 4_900, currency: 'INR' },
      T0 + 24 * 60 * 60 * 1000,
    );
    assert.deepEqual(verdict, { decision: 'DENY', clause: 'C1', reason: null });
  });

  it('the same draft confirmed with the escalate choice changes that verdict — the choice is load-bearing', () => {
    const answers = { ...CANONICAL_ANSWERS, 'sys-c1-c4-unknown-supplier': 'B' };
    const warrant = confirm(stubDraft(), answers, T0);
    const verdict = evaluate(
      warrant,
      [{ supplier: 'PackRight Supplies', amount: 4_000, authorized: true }],
      { supplier: 'Unknown Vendor', amount: 4_900, currency: 'INR' },
      T0 + 24 * 60 * 60 * 1000,
    );
    assert.deepEqual(verdict, { decision: 'ESCALATE', clause: 'C1', reason: null });
  });
});
