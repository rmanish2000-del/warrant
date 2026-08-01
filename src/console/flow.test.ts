import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalAnswersFor, CANONICAL_PROPOSALS, ConsoleFlow, seedHistory } from './flow.ts';
import type { ProviderPort, ProviderSession } from './flow.ts';
import { stubDraft } from '../compiler/draft.ts';
import { cumulativeAuthorized } from '../engine/evaluate.ts';
import { EnforcementError } from '../records/append.ts';

const T0 = 1_754_000_000_000;

/** Deterministic ticking clock: strictly increasing, injected — the flow never reads Date. */
const makeClock = () => {
  let t = T0;
  return () => (t += 1_000);
};

/** Counts every call; resolves instantly with a sandbox-shaped session. */
const countingProvider = () => {
  const calls: { supplier: string; amount: number }[] = [];
  const port: ProviderPort = {
    async createSession(args) {
      calls.push({ supplier: args.supplier, amount: args.amount });
      return { sessionRef: `sess-${calls.length}`, status: 'awaiting_verification' };
    },
  };
  return { port, calls };
};

const readyFlow = (provider: ProviderPort | null = null) => {
  const flow = new ConsoleFlow({ provider, clock: makeClock() });
  flow.adoptDraft({ source: 'stub', draft: stubDraft(), reason: 'test' }, 'stub');
  flow.confirmWarrant(canonicalAnswersFor(stubDraft()));
  seedHistory(flow);
  return flow;
};

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('seeded history goes through the enforcement boundary', () => {
  it('seeds ₹4,000 via a C4 escalation approved by the named operator, then an ALLOW', () => {
    const flow = readyFlow();
    assert.equal(cumulativeAuthorized(flow.log.ledger()), 4_000);
    const approval = flow.log.records.find((r) => r.kind === 'approval');
    assert.ok(approval && approval.kind === 'approval' && approval.approvedBy === 'ops-manager');
    assert.deepEqual(flow.log.verify(), { ok: true });
  });
});

describe('the five canonical scenarios, end to end against the live ledger', () => {
  it('runs A–E in order with the expected verdicts, clauses, and running totals', async () => {
    const { port, calls } = countingProvider();
    const flow = readyFlow(port);
    await settle(); // let the seed approval's background session creation land
    const sessionsBeforeScenarios = flow.paymentSessionsCreated;

    // A — ALLOW, nothing breached
    const a = flow.propose('PackRight Supplies', 3_800);
    assert.deepEqual(a.verdict, { decision: 'ALLOW', clause: null, reason: null });
    assert.equal(a.evidence.cumulativeAuthorizedBefore, 4_000);

    // B — ESCALATE C3; waits for the human, then is approved
    const b = flow.propose('PackRight Supplies', 6_200);
    assert.deepEqual(b.verdict, { decision: 'ESCALATE', clause: 'C3', reason: null });
    assert.equal(flow.log.ledger().at(-1)?.authorized, false); // pending — no auto-approve
    flow.approve(b.id, 'approved');
    await settle();
    assert.equal(cumulativeAuthorized(flow.log.ledger()), 14_000);

    // C — the hero: under every limit, refused anyway; the cap is ALSO breached
    const c = flow.propose('Unknown Vendor', 4_900);
    assert.ok(c.evidence.cumulativeAuthorizedBefore + 4_900 > 15_000, 'fixture must breach the cap');
    assert.deepEqual(c.verdict, { decision: 'DENY', clause: 'C1', reason: null });
    assert.equal(flow.outboundCallsFor(c.id), 0);
    assert.equal(flow.paymentSessionsCreated, flow.sessionsAtDecision(c.id), 'sessions unchanged by the refusal');

    // D and E — cumulative denials
    const d = flow.propose('PackRight Supplies', 12_000);
    assert.deepEqual(d.verdict, { decision: 'DENY', clause: 'C2', reason: null });
    const e = flow.propose('PackRight Supplies', 9_000);
    assert.deepEqual(e.verdict, { decision: 'DENY', clause: 'C2', reason: null });

    assert.equal(cumulativeAuthorized(flow.log.ledger()), 14_000);
    // Provider was touched exactly twice across the whole demo: seed approval + scenario B.
    assert.equal(calls.length, 2);
    assert.deepEqual(flow.log.verify(), { ok: true });
    assert.equal(flow.paymentSessionsCreated, sessionsBeforeScenarios + 1);
  });

  it('CANONICAL_PROPOSALS matches the spec table', () => {
    assert.deepEqual(
      CANONICAL_PROPOSALS.map((p) => [p.supplier, p.amount, p.expected]),
      [
        ['PackRight Supplies', 3_800, 'ALLOW'],
        ['PackRight Supplies', 6_200, 'ESCALATE'],
        ['Unknown Vendor', 4_900, 'DENY'],
        ['PackRight Supplies', 12_000, 'DENY'],
        ['PackRight Supplies', 9_000, 'DENY'],
      ],
    );
  });
});

describe('DENY makes zero outbound calls — proven with an injected transport', () => {
  it('scenario C: the provider port is never invoked for a refusal', () => {
    const { port, calls } = countingProvider();
    const flow = readyFlow(port);
    const callsBefore = calls.length;
    const c = flow.propose('Unknown Vendor', 4_900);
    assert.equal(c.verdict.decision, 'DENY');
    assert.equal(calls.length, callsBefore);
    assert.equal(flow.outboundCallsFor(c.id), 0);
  });

  it('forcing an approval onto a DENY throws at the boundary and STILL makes zero calls', () => {
    const { port, calls } = countingProvider();
    const flow = readyFlow(port);
    const callsBefore = calls.length;
    const c = flow.propose('Unknown Vendor', 4_900);
    assert.throws(
      () => flow.approve(c.id, 'approved'),
      (err: unknown) => err instanceof EnforcementError && err.kind === 'not-an-escalation',
    );
    assert.equal(calls.length, callsBefore);
    assert.equal(flow.outboundCallsFor(c.id), 0);
    assert.equal(flow.paymentFor(c.id), null);
  });
});

describe('rejection path — a human says no', () => {
  it('a rejected escalation creates no session, requests no credential, and is recorded as rejected', async () => {
    const { port, calls } = countingProvider();
    const flow = readyFlow(port);
    const callsBefore = calls.length;
    const spendBefore = cumulativeAuthorized(flow.log.ledger());

    const b = flow.propose('PackRight Supplies', 6_200);
    flow.approve(b.id, 'rejected');
    await settle();

    assert.equal(calls.length, callsBefore);
    assert.equal(flow.paymentFor(b.id), null);
    assert.equal(flow.credentialRequests, 0);
    assert.equal(cumulativeAuthorized(flow.log.ledger()), spendBefore);
    const approval = flow.log.records.findLast((r) => r.kind === 'approval');
    assert.ok(approval?.kind === 'approval' && approval.outcome === 'rejected' && approval.decisionId === b.id);
  });
});

describe('the refusal never waits on the payment leg — structurally', () => {
  it('with a provider that never resolves, the next decision still renders', async () => {
    const never: ProviderPort = { createSession: () => new Promise<ProviderSession>(() => {}) };
    const flow = new ConsoleFlow({ provider: never, clock: makeClock() });
    flow.adoptDraft({ source: 'stub', draft: stubDraft(), reason: 'test' }, 'stub');
    flow.confirmWarrant(canonicalAnswersFor(stubDraft()));
    // Seed by hand here: the never-resolving provider leaves the seed approval pending forever,
    // which is exactly the point — nothing below waits on it.
    const s1 = flow.propose('PackRight Supplies', 2_500);
    flow.approve(s1.id, 'approved');

    assert.equal(flow.paymentFor(s1.id)?.status, 'requested');
    const c = flow.propose('Unknown Vendor', 4_900);
    assert.equal(c.verdict.decision, 'DENY'); // refusal rendered while payment leg hangs
    assert.equal(flow.paymentFor(s1.id)?.status, 'requested'); // still in flight, still readable
  });
});

describe('screen safety — provider extras are structurally unreachable', () => {
  it('extra fields on a provider response never survive into payment state', async () => {
    const leaky: ProviderPort = {
      async createSession() {
        return {
          sessionRef: 'sess-1',
          status: 'awaiting_verification',
          session_token: 'tok-should-never-appear',
          iframe_url: 'https://should.never.appear',
        } as unknown as ProviderSession;
      },
    };
    const flow = new ConsoleFlow({ provider: leaky, clock: makeClock() });
    flow.adoptDraft({ source: 'stub', draft: stubDraft(), reason: 'test' }, 'stub');
    flow.confirmWarrant(canonicalAnswersFor(stubDraft()));
    const s1 = flow.propose('PackRight Supplies', 2_500);
    flow.approve(s1.id, 'approved');
    await settle();

    const payment = flow.paymentFor(s1.id);
    assert.deepEqual(payment, { status: 'awaiting_verification', sessionRef: 'sess-1' });
    assert.ok(!JSON.stringify(payment).includes('tok-should-never-appear'));
    assert.ok(!JSON.stringify(payment).includes('iframe_url'));
  });
});
