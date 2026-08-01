import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Verdict } from '../engine/types.ts';
import { AuthorizationLog, EnforcementError, GENESIS_HASH } from './append.ts';
import { OPERATOR_ID } from './records.ts';

const T0 = 1_754_000_000_000;
const ALLOW: Verdict = { decision: 'ALLOW', clause: null, reason: null };
const ESCALATE_C3: Verdict = { decision: 'ESCALATE', clause: 'C3', reason: null };
const DENY_C1: Verdict = { decision: 'DENY', clause: 'C1', reason: null };

const proposal = (supplier: string, amount: number) => ({ supplier, amount, currency: 'INR' });

const newLog = () => new AuthorizationLog();

const expectEnforcement = (fn: () => unknown, kind: EnforcementError['kind']) => {
  assert.throws(fn, (err: unknown) => err instanceof EnforcementError && err.kind === kind);
};

describe('enforcement boundary — nothing appends except from a decision that permitted it', () => {
  it('THE test: an approval against a DENY is rejected, not recorded', () => {
    const log = newLog();
    const deny = log.appendDecision({
      warrantId: 'w', warrantVersion: 1, proposal: proposal('Unknown Vendor', 4_900), verdict: DENY_C1, at: T0,
    });
    expectEnforcement(
      () => log.appendApproval({ decisionId: deny.id, outcome: 'approved', approvedBy: OPERATOR_ID, at: T0 + 1 }),
      'not-an-escalation',
    );
    // Nothing was appended, and the denial still contributes nothing.
    assert.equal(log.records.length, 1);
    assert.deepEqual(log.ledger(), [{ supplier: 'Unknown Vendor', amount: 4_900, authorized: false }]);
  });

  it('an ALLOW cannot receive an approval either — it never asked for one', () => {
    const log = newLog();
    const allow = log.appendDecision({
      warrantId: 'w', warrantVersion: 1, proposal: proposal('PackRight Supplies', 3_800), verdict: ALLOW, at: T0,
    });
    expectEnforcement(
      () => log.appendApproval({ decisionId: allow.id, outcome: 'approved', approvedBy: OPERATOR_ID, at: T0 + 1 }),
      'not-an-escalation',
    );
  });

  it('an approval for a decision that does not exist is rejected', () => {
    expectEnforcement(
      () => newLog().appendApproval({ decisionId: 'ghost', outcome: 'approved', approvedBy: OPERATOR_ID, at: T0 }),
      'unknown-decision',
    );
  });

  it('a rejected escalation is recorded as rejected and permits nothing', () => {
    const log = newLog();
    const esc = log.appendDecision({
      warrantId: 'w', warrantVersion: 1, proposal: proposal('PackRight Supplies', 6_200), verdict: ESCALATE_C3, at: T0,
    });
    const rejection = log.appendApproval({ decisionId: esc.id, outcome: 'rejected', approvedBy: OPERATOR_ID, at: T0 + 1 });
    assert.equal(rejection.outcome, 'rejected');
    assert.equal(log.isExecutable(esc.id), false);
    assert.deepEqual(log.ledger(), [{ supplier: 'PackRight Supplies', amount: 6_200, authorized: false }]);
    expectEnforcement(
      () => log.appendSessionResult({ decisionId: esc.id, sessionRef: 's-1', outcome: 'SUCCESS', at: T0 + 2 }),
      'not-executable',
    );
  });

  it('a pending escalation is not executable; an approved one is', () => {
    const log = newLog();
    const esc = log.appendDecision({
      warrantId: 'w', warrantVersion: 1, proposal: proposal('PackRight Supplies', 6_200), verdict: ESCALATE_C3, at: T0,
    });
    assert.equal(log.isExecutable(esc.id), false);
    log.appendApproval({ decisionId: esc.id, outcome: 'approved', approvedBy: OPERATOR_ID, at: T0 + 1 });
    assert.equal(log.isExecutable(esc.id), true);
    const session = log.appendSessionResult({ decisionId: esc.id, sessionRef: 's-1', outcome: 'SUCCESS', at: T0 + 2 });
    assert.equal(session.sessionRef, 's-1');
  });

  it('a session result against a DENY is rejected', () => {
    const log = newLog();
    const deny = log.appendDecision({
      warrantId: 'w', warrantVersion: 1, proposal: proposal('Unknown Vendor', 4_900), verdict: DENY_C1, at: T0,
    });
    expectEnforcement(
      () => log.appendSessionResult({ decisionId: deny.id, sessionRef: 's-1', outcome: 'SUCCESS', at: T0 + 1 }),
      'not-executable',
    );
  });

  it('double-click approval is idempotent; a conflicting second approval is rejected', () => {
    const log = newLog();
    const esc = log.appendDecision({
      warrantId: 'w', warrantVersion: 1, proposal: proposal('PackRight Supplies', 6_200), verdict: ESCALATE_C3, at: T0,
    });
    const first = log.appendApproval({ decisionId: esc.id, outcome: 'approved', approvedBy: OPERATOR_ID, at: T0 + 1 });
    const second = log.appendApproval({ decisionId: esc.id, outcome: 'approved', approvedBy: OPERATOR_ID, at: T0 + 5 });
    assert.equal(second.id, first.id); // no duplicate record
    expectEnforcement(
      () => log.appendApproval({ decisionId: esc.id, outcome: 'rejected', approvedBy: OPERATOR_ID, at: T0 + 6 }),
      'conflicting-approval',
    );
  });
});

describe('hash chain — tamper-evident, never "cryptographically signed"', () => {
  const build = () => {
    const log = newLog();
    const a = log.appendDecision({
      warrantId: 'w', warrantVersion: 1, proposal: proposal('PackRight Supplies', 6_200), verdict: ESCALATE_C3, at: T0,
    });
    log.appendApproval({ decisionId: a.id, outcome: 'approved', approvedBy: OPERATOR_ID, at: T0 + 1 });
    log.appendDecision({
      warrantId: 'w', warrantVersion: 1, proposal: proposal('Unknown Vendor', 4_900), verdict: DENY_C1, at: T0 + 2,
    });
    return log;
  };

  it('a fresh log verifies, starting from the defined genesis value', () => {
    const log = build();
    assert.equal(log.records[0]?.previousHash, GENESIS_HASH);
    assert.deepEqual(log.verify(), { ok: true });
    for (let i = 1; i < log.records.length; i++) {
      assert.equal(log.records[i]?.previousHash, log.records[i - 1]?.recordHash);
    }
  });

  it('a modified record fails verification (AR-04)', () => {
    const log = build();
    // Records are readonly by type; simulate an attacker editing the ledger file.
    const tampered = log.records[0] as { at: number };
    tampered.at = T0 + 999;
    const result = log.verify();
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.atIndex, 0);
  });

  it('identical operations produce identical hashes — determinism holds at the record layer', () => {
    const a = build();
    const b = build();
    assert.deepEqual(a.records.map((r) => r.recordHash), b.records.map((r) => r.recordHash));
  });
});
