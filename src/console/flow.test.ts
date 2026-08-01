import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalAnswersFor, CANONICAL_PROPOSALS, ConsoleFlow, seedHistory } from './flow.ts';
import type { CreatedSession, PollOutcome, ProviderPort } from './flow.ts';
import { stubDraft } from '../compiler/draft.ts';
import { cumulativeAuthorized } from '../engine/evaluate.ts';
import { EnforcementError } from '../records/append.ts';

const T0 = 1_754_000_000_000;

/** Deterministic ticking clock: strictly increasing, injected — the flow never reads Date. */
const makeClock = () => {
  let t = T0;
  return () => (t += 1_000);
};

const FAR_EXPIRY = new Date(T0 + 10 * 60_000).toISOString();

/** Counts every port call; the passkey is presumed done — first poll is ready. */
const countingProvider = () => {
  const calls: { method: 'create' | 'poll' | 'report'; supplier?: string }[] = [];
  let seq = 0;
  const port: ProviderPort = {
    async createSession(args) {
      calls.push({ method: 'create', supplier: args.supplier });
      seq += 1;
      return { sessionRef: `sess-${seq}`, iframeUrl: 'https://sandbox.collect.example/opaque', expiresAtIso: FAR_EXPIRY };
    },
    async pollResult() {
      calls.push({ method: 'poll' });
      return { kind: 'ready', txnRefId: 'tli-test' };
    },
    async reportApproved() {
      calls.push({ method: 'report' });
      return { visaConfirmation: 'SUCCESS' };
    },
  };
  const creates = () => calls.filter((c) => c.method === 'create').length;
  return { port, calls, creates };
};

const readyFlow = (provider: ProviderPort | null = null) => {
  const flow = new ConsoleFlow({ provider, clock: makeClock(), sleep: async () => {}, pollIntervalMs: 1 });
  flow.adoptDraft({ source: 'stub', draft: stubDraft(), reason: 'test' }, 'stub');
  flow.confirmWarrant(canonicalAnswersFor(stubDraft()));
  seedHistory(flow);
  return flow;
};

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

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
    const { port, calls, creates } = countingProvider();
    const flow = readyFlow(port);
    await settle();
    // Seeded approvals record authority but never execute — no session for them.
    assert.equal(creates(), 0);
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
    // Exactly one session across the whole demo — scenario B's — with its poll and report.
    assert.equal(creates(), 1);
    assert.deepEqual(calls.map((c) => c.method), ['create', 'poll', 'report']);
    assert.equal(flow.paymentSessionsCreated, sessionsBeforeScenarios + 1);
    // The payment leg completed in the background: confirmation surfaced, result chained.
    const payment = flow.paymentFor(b.id);
    assert.equal(payment?.status, 'confirmed');
    assert.equal(payment?.visaConfirmation, 'SUCCESS');
    const sessionResult = flow.log.records.findLast((r) => r.kind === 'session_result');
    assert.ok(sessionResult?.kind === 'session_result' && sessionResult.outcome === 'SUCCESS' && sessionResult.decisionId === b.id);
    assert.deepEqual(flow.log.verify(), { ok: true });
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
    const never: ProviderPort = {
      createSession: () => new Promise(() => {}),
      pollResult: () => new Promise(() => {}),
      reportApproved: () => new Promise(() => {}),
    };
    const flow = new ConsoleFlow({ provider: never, clock: makeClock(), sleep: async () => {}, pollIntervalMs: 1 });
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
  it('extra fields on provider responses never survive into payment state', async () => {
    const leaky: ProviderPort = {
      async createSession() {
        return {
          sessionRef: 'sess-1',
          iframeUrl: 'https://sandbox.collect.example/opaque',
          expiresAtIso: FAR_EXPIRY,
          session_token: 'tok-should-never-appear',
        } as unknown as CreatedSession;
      },
      async pollResult() {
        return {
          kind: 'ready',
          txnRefId: 'tli-1',
          token: 'credential-should-never-appear',
          dynamic_cvv: '999',
        } as unknown as PollOutcome;
      },
      async reportApproved() {
        return { visaConfirmation: 'SUCCESS', session_token: 'again-no' } as never;
      },
    };
    const flow = new ConsoleFlow({ provider: leaky, clock: makeClock(), sleep: async () => {}, pollIntervalMs: 1 });
    flow.adoptDraft({ source: 'stub', draft: stubDraft(), reason: 'test' }, 'stub');
    flow.confirmWarrant(canonicalAnswersFor(stubDraft()));
    const s1 = flow.propose('PackRight Supplies', 2_500);
    flow.approve(s1.id, 'approved');
    await settle();

    const payment = flow.paymentFor(s1.id);
    assert.deepEqual(payment, {
      status: 'confirmed',
      sessionRef: 'sess-1',
      iframeUrl: null,
      expiresAtIso: FAR_EXPIRY,
      visaConfirmation: 'SUCCESS',
    });
    const everything = JSON.stringify({ payment, records: flow.log.records });
    assert.ok(!everything.includes('tok-should-never-appear'));
    assert.ok(!everything.includes('credential-should-never-appear'));
    assert.ok(!everything.includes('dynamic_cvv'));
  });
});

describe('session lapse — the provider clock ends the watch, wordlessly safe', () => {
  it('a session nobody approves lapses at the provider expiry; nothing is chained', async () => {
    const alwaysPending: ProviderPort = {
      async createSession() {
        // Expires 5 ticking-clock seconds out, so the watcher terminates quickly.
        return { sessionRef: 'sess-lapse', iframeUrl: 'https://x.example', expiresAtIso: new Date(T0 + 60_000).toISOString() };
      },
      async pollResult() {
        return { kind: 'pending' };
      },
      async reportApproved() {
        throw new Error('must not be called');
      },
    };
    const flow = new ConsoleFlow({ provider: alwaysPending, clock: makeClock(), sleep: async () => {}, pollIntervalMs: 1 });
    flow.adoptDraft({ source: 'stub', draft: stubDraft(), reason: 'test' }, 'stub');
    flow.confirmWarrant(canonicalAnswersFor(stubDraft()));
    const s1 = flow.propose('PackRight Supplies', 2_500);
    flow.approve(s1.id, 'approved');
    // Let the watcher run until the ticking clock passes the provider expiry.
    for (let i = 0; i < 80; i += 1) await settle();

    assert.equal(flow.paymentFor(s1.id)?.status, 'lapsed');
    assert.equal(flow.log.records.some((r) => r.kind === 'session_result'), false);
  });
});
