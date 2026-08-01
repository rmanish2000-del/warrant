import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalAnswersFor, ConsoleFlow, seedHistory } from '../console/flow.ts';
import type { ProviderPort } from '../console/flow.ts';
import { stubDraft } from '../compiler/draft.ts';
import { exportView } from './view.ts';

const T0 = 1_754_000_000_000;
const makeClock = () => {
  let t = T0;
  return () => (t += 1_000);
};

const instantProvider = (): ProviderPort => ({
  async createSession() {
    return {
      sessionRef: 'ses_test_1',
      iframeUrl: 'https://sandbox.collect.example/opaque?session=ses_test_1',
      expiresAtIso: new Date(T0 + 15 * 60_000).toISOString(),
    };
  },
  async pollResult() {
    return { kind: 'ready', txnRefId: 'tli_test_1' };
  },
  async reportApproved() {
    return { visaConfirmation: 'SUCCESS' };
  },
});

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** Seed + A allowed + B escalated/approved/settled + C denied — every entry kind and status. */
const fullFlow = async (provider: ProviderPort | null) => {
  const flow = new ConsoleFlow({ provider, clock: makeClock(), sleep: async () => {}, pollIntervalMs: 1 });
  flow.adoptDraft({ source: 'stub', draft: stubDraft(), reason: 'test' }, 'stub');
  flow.confirmWarrant(canonicalAnswersFor(stubDraft()));
  seedHistory(flow);
  flow.propose('PackRight Supplies', 3_800);
  const b = flow.propose('PackRight Supplies', 6_200);
  flow.approve(b.id, 'approved');
  await settle();
  flow.propose('Unknown Vendor', 4_900);
  return { flow, b };
};

describe('exportView — the record as a self-contained JSON document (AR-05)', () => {
  it('round-trips through JSON with every entry, the chain result, and the derived total', async () => {
    const { flow } = await fullFlow(instantProvider());
    const doc = exportView(flow, '2026-08-01T12:00:00.000Z');
    const parsed = JSON.parse(JSON.stringify(doc)) as typeof doc;

    assert.equal(parsed.document, 'warrant-authorization-record');
    assert.equal(parsed.integrity, 'append-only, hash-chained (tamper-evident)');
    assert.ok(!parsed.integrity.includes('sign'), 'never "signed", never "cryptographically" anything');
    assert.deepEqual(parsed.chain, { verified: true });
    assert.equal(parsed.cumulativeAuthorized, 14_000);
    assert.equal(parsed.warrant?.approvedSuppliers[0], 'PackRight Supplies');
    // seed decision + approval + seed decision + A + B + approval + session_result + C
    assert.equal(parsed.entries.length, 8);
    for (const entry of parsed.entries) {
      assert.ok(entry.previousHash.length > 0 && entry.recordHash.length === 64);
    }
  });

  it('derives spendStatus per decision: hold, settled, and not-counted', async () => {
    const { flow, b } = await fullFlow(instantProvider());
    const doc = exportView(flow, '2026-08-01T12:00:00.000Z');
    const decisions = doc.entries.filter((e) => e.kind === 'decision') as Array<{
      id: string;
      proposal: { supplier: string; amount: number };
      decision: string;
      spendStatus: string;
    }>;

    // B executed end to end → settled.
    assert.equal(decisions.find((d) => d.id === b.id)?.spendStatus, 'settled');
    // A allowed but never executed (no provider call for ALLOW in this build) → hold.
    assert.equal(decisions.find((d) => d.proposal.amount === 3_800)?.spendStatus, 'hold');
    // Seed escalation approved, execution predates the demo → hold.
    assert.equal(decisions.find((d) => d.proposal.amount === 2_500)?.spendStatus, 'hold');
    // The refusal → not-counted.
    assert.equal(decisions.find((d) => d.proposal.supplier === 'Unknown Vendor')?.spendStatus, 'not-counted');
    // Holds and settlements both count toward the derived total; not-counted doesn't.
    assert.equal(doc.cumulativeAuthorized, 14_000);
  });

  it('a rejected escalation and a pending escalation are both not-counted', async () => {
    const flow = new ConsoleFlow({ provider: null, clock: makeClock() });
    flow.adoptDraft({ source: 'stub', draft: stubDraft(), reason: 'test' }, 'stub');
    flow.confirmWarrant(canonicalAnswersFor(stubDraft()));
    seedHistory(flow);
    const rejected = flow.propose('PackRight Supplies', 6_200);
    flow.approve(rejected.id, 'rejected');
    const pending = flow.propose('PackRight Supplies', 5_500);

    const doc = exportView(flow, '2026-08-01T12:00:00.000Z');
    const byId = new Map(doc.entries.map((e) => [e.id, e]));
    assert.equal((byId.get(rejected.id) as { spendStatus?: string }).spendStatus, 'not-counted');
    assert.equal((byId.get(pending.id) as { spendStatus?: string }).spendStatus, 'not-counted');
  });

  it('contains no secrets and no provider URLs — grep the whole document', async () => {
    const { flow } = await fullFlow(instantProvider());
    const serialized = JSON.stringify(exportView(flow, '2026-08-01T12:00:00.000Z'));
    for (const forbidden of ['iframeUrl', 'iframe_url', 'session_token', 'token"', 'dynamic_cvv', 'collect.example', 'Bearer']) {
      assert.ok(!serialized.includes(forbidden), `export must not contain ${forbidden}`);
    }
    // Session references are fine and expected.
    assert.ok(serialized.includes('ses_test_1'));
    assert.ok(serialized.includes('SUCCESS'));
  });

  it('a tampered log exports with chain.verified false — the export never hides it', async () => {
    const { flow } = await fullFlow(null);
    (flow.log.records[0] as { at: number }).at = 1;
    const doc = exportView(flow, '2026-08-01T12:00:00.000Z');
    assert.equal(doc.chain.verified, false);
  });
});
