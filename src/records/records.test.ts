import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Verdict } from '../engine/types.ts';
import { cumulativeAuthorized, evaluate } from '../engine/evaluate.ts';
import { confirm } from '../compiler/confirm.ts';
import { stubDraft } from '../compiler/draft.ts';
import { deriveLedger, LedgerIntegrityError, OPERATOR_ID } from './records.ts';
import type { ApprovalRecord, AuthorizationRecord, DecisionRecord } from './records.ts';

const T0 = 1_754_000_000_000;
let counter = 0;

/** Hash fields carry placeholders until the chain module lands; the shape is what is frozen. */
const common = () => ({
  id: `rec-${++counter}`,
  warrantId: 'warrant-demo-001',
  warrantVersion: 1,
  at: T0 + counter * 1_000,
  previousHash: 'placeholder',
  recordHash: 'placeholder',
});

const decision = (supplier: string, amount: number, verdict: Verdict, before: number): DecisionRecord => ({
  kind: 'decision',
  ...common(),
  proposal: { supplier, amount, currency: 'INR' },
  verdict,
  evidence: { cumulativeAuthorizedBefore: before },
});

const approval = (decisionId: string, outcome: 'approved' | 'rejected'): ApprovalRecord => ({
  kind: 'approval',
  ...common(),
  decisionId,
  outcome,
  approvedBy: OPERATOR_ID,
});

const ALLOW: Verdict = { decision: 'ALLOW', clause: null, reason: null };
const ESCALATE_C3: Verdict = { decision: 'ESCALATE', clause: 'C3', reason: null };
const DENY_C1: Verdict = { decision: 'DENY', clause: 'C1', reason: null };
const DENY_C2: Verdict = { decision: 'DENY', clause: 'C2', reason: null };

describe('deriveLedger — authorized is derived from verdict + approval, never stored', () => {
  it('an ALLOW decision is authorized on its own', () => {
    const ledger = deriveLedger([decision('PackRight Supplies', 3_800, ALLOW, 4_000)]);
    assert.deepEqual(ledger, [{ supplier: 'PackRight Supplies', amount: 3_800, authorized: true }]);
  });

  it('an escalation is authorized only once a human approval record links to it', () => {
    const d = decision('PackRight Supplies', 6_200, ESCALATE_C3, 7_800);
    assert.equal(deriveLedger([d])[0]?.authorized, false); // pending — invariant 3
    assert.equal(deriveLedger([d, approval(d.id, 'approved')])[0]?.authorized, true);
    assert.equal(deriveLedger([d, approval(d.id, 'rejected')])[0]?.authorized, false);
  });

  it('denials contribute nothing regardless of anything else in the log', () => {
    const ledger = deriveLedger([
      decision('Unknown Vendor', 4_900, DENY_C1, 14_000),
      decision('PackRight Supplies', 12_000, DENY_C2, 14_000),
    ]);
    assert.ok(ledger.every((entry) => !entry.authorized));
    assert.equal(cumulativeAuthorized(ledger), 0);
  });

  it('a session result is provenance, not spend — the ledger view ignores it', () => {
    const d = decision('PackRight Supplies', 3_800, ALLOW, 0);
    const sessionResult: AuthorizationRecord = {
      kind: 'session_result',
      ...common(),
      decisionId: d.id,
      sessionRef: 'sess-demo-1',
      outcome: 'SUCCESS',
    };
    const ledger = deriveLedger([d, sessionResult]);
    assert.equal(ledger.length, 1);
    assert.equal(cumulativeAuthorized(ledger), 3_800);
  });
});

describe('deriveLedger fails closed on an inconsistent log', () => {
  it('approval referencing a missing decision throws', () => {
    assert.throws(
      () => deriveLedger([approval('no-such-decision', 'approved')]),
      LedgerIntegrityError,
    );
  });

  it('an approval attached to a DENY throws — an approved denial must be impossible', () => {
    const d = decision('Unknown Vendor', 4_900, DENY_C1, 14_000);
    assert.throws(() => deriveLedger([d, approval(d.id, 'approved')]), LedgerIntegrityError);
  });

  it('conflicting approvals throw; identical duplicates collapse (double-click idempotence)', () => {
    const d = decision('PackRight Supplies', 6_200, ESCALATE_C3, 7_800);
    assert.throws(
      () => deriveLedger([d, approval(d.id, 'approved'), approval(d.id, 'rejected')]),
      LedgerIntegrityError,
    );
    const ledger = deriveLedger([d, approval(d.id, 'approved'), approval(d.id, 'approved')]);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]?.authorized, true);
  });

  it('a session result referencing a missing decision throws', () => {
    const stray: AuthorizationRecord = {
      kind: 'session_result',
      ...common(),
      decisionId: 'no-such-decision',
      sessionRef: 'sess-x',
      outcome: 'SUCCESS',
    };
    assert.throws(() => deriveLedger([stray]), LedgerIntegrityError);
  });
});

describe('record log drives the canonical demo end to end', () => {
  it('seed + A allowed + B approved ⇒ scenario C denies on C1 and E denies on C2, from records alone', () => {
    const warrant = confirm(
      stubDraft(),
      {
        'sys-c1-c4-unknown-supplier': 'A',
        'sys-c2-c3-approval-vs-cap': 'A',
        'sys-c3-c4-citation': 'A',
      },
      T0,
    );
    const at = T0 + 24 * 60 * 60 * 1000;

    const log: AuthorizationRecord[] = [decision('PackRight Supplies', 4_000, ALLOW, 0)];
    const scenarioA = decision('PackRight Supplies', 3_800, ALLOW, 4_000);
    const scenarioB = decision('PackRight Supplies', 6_200, ESCALATE_C3, 7_800);
    log.push(scenarioA, scenarioB, approval(scenarioB.id, 'approved'));

    const ledger = deriveLedger(log);
    assert.equal(cumulativeAuthorized(ledger), 14_000);

    assert.deepEqual(
      evaluate(warrant, ledger, { supplier: 'Unknown Vendor', amount: 4_900, currency: 'INR' }, at),
      DENY_C1,
    );
    assert.deepEqual(
      evaluate(warrant, ledger, { supplier: 'PackRight Supplies', amount: 9_000, currency: 'INR' }, at),
      DENY_C2,
    );
  });
});
