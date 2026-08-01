/**
 * Tests for the deterministic policy evaluation engine.
 *
 * Canonical fixtures come from `current/01_PRODUCT_SPEC.md` §5–7 (pack v1.4);
 * pack test ids (EV-xx) are cited where a case implements one. Fixtures that
 * deviate from the canonical warrant (the two-supplier policy for C4) are
 * labelled non-canonical where they are defined.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cumulativeAuthorized, evaluate } from './evaluate.ts';
import type {
  ClauseResolutions,
  CompiledPolicy,
  EvaluableWarrant,
  LedgerEntry,
  Proposal,
  Verdict,
  Warrant,
} from './types.ts';

const DAY = 24 * 60 * 60 * 1000;
/** Symbolic issuance instant. Zero on purpose: any falsy-check bug in time handling fails loudly. */
const T0 = 0;
/** Mid-validity evaluation time used everywhere expiry is not the subject. */
const AT = T0 + 2 * DAY;

/** Canonical overlap resolutions — the choices the human confirms on the demo path. */
const CANONICAL_RESOLUTIONS: ClauseResolutions = {
  onUnapprovedSupplier: 'deny',
  onCapBreachDespiteApproval: 'deny',
  whenNewSupplierAboveThreshold: 'cite_C3',
};

/** Canonical policy — spec §6. One approved supplier; do not add more here. */
const CANONICAL_POLICY: CompiledPolicy = {
  approvedSuppliers: ['PackRight Supplies'],
  cumulativeCap: 15_000,
  approvalThreshold: 5_000,
  currency: 'INR',
  resolutions: CANONICAL_RESOLUTIONS,
};

/** Canonical clause text — spec §6. Display-only; the type system keeps it out of evaluate's reach. */
const CANONICAL_CLAUSES: Warrant['clauses'] = [
  { id: 'C1', text: 'Buy only from approved suppliers.' },
  { id: 'C2', text: 'Do not exceed ₹15,000 per week.' },
  { id: 'C3', text: 'Any order above ₹5,000 requires approval.' },
  { id: 'C4', text: 'Never buy from a new supplier without approval.' },
];

const WARRANT: Warrant = {
  policy: CANONICAL_POLICY,
  clauses: CANONICAL_CLAUSES,
  issuedAt: T0,
  expiresAt: T0 + 7 * DAY,
};

/**
 * Seed ledger — spec §7 requires prior authorization records summing to
 * ₹4,000 so the "₹4,000 of ₹15,000" readout is derived, not asserted. The
 * sum is canonical; the split into two records is arbitrary. The records are
 * PackRight's: scenario A expects ALLOW, so the seed must already establish
 * PackRight as previously transacted or C4 would fire.
 */
const seedLedger = (): LedgerEntry[] => [
  { supplier: 'PackRight Supplies', amount: 2_500, authorized: true },
  { supplier: 'PackRight Supplies', amount: 1_500, authorized: true },
];

const inr = (supplier: string, amount: number): Proposal => ({ supplier, amount, currency: 'INR' });

const ALLOWED: Verdict = { decision: 'ALLOW', clause: null, reason: null };
const escalated = (clause: 'C1' | 'C2' | 'C3' | 'C4'): Verdict => ({
  decision: 'ESCALATE',
  clause,
  reason: null,
});
const denied = (clause: 'C1' | 'C2'): Verdict => ({ decision: 'DENY', clause, reason: null });
const refused = (reason: 'OUTSIDE_VALIDITY' | 'INVALID_PROPOSAL'): Verdict => ({
  decision: 'DENY',
  clause: null,
  reason,
});

describe('canonical scenarios A–E (spec §7): sequential, accumulating ledger', () => {
  it('runs all five in order; authorized spend accumulates, denials add nothing', () => {
    const ledger = seedLedger();
    assert.equal(cumulativeAuthorized(ledger), 4_000);

    // A — PackRight ₹3,800 against ₹4,000 prior → ALLOW (EV-01)
    assert.deepEqual(evaluate(WARRANT, ledger, inr('PackRight Supplies', 3_800), AT), ALLOWED);
    ledger.push({ supplier: 'PackRight Supplies', amount: 3_800, authorized: true });
    assert.equal(cumulativeAuthorized(ledger), 7_800);

    // B — PackRight ₹6,200 against ₹7,800 prior → ESCALATE C3 (EV-02).
    // The human approves it; the approval event itself is outside this module,
    // so the test appends the approved record directly.
    assert.deepEqual(evaluate(WARRANT, ledger, inr('PackRight Supplies', 6_200), AT), escalated('C3'));
    ledger.push({ supplier: 'PackRight Supplies', amount: 6_200, authorized: true });
    assert.equal(cumulativeAuthorized(ledger), 14_000);

    // C — the hero. Unknown Vendor ₹4,900: under the per-order threshold,
    // inside the cap headroom — refused anyway, C1 (EV-03).
    assert.deepEqual(evaluate(WARRANT, ledger, inr('Unknown Vendor', 4_900), AT), denied('C1'));
    ledger.push({ supplier: 'Unknown Vendor', amount: 4_900, authorized: false });

    // D — PackRight ₹12,000 would total ₹26,000 → DENY C2, outranking C3 (EV-04).
    assert.deepEqual(evaluate(WARRANT, ledger, inr('PackRight Supplies', 12_000), AT), denied('C2'));
    ledger.push({ supplier: 'PackRight Supplies', amount: 12_000, authorized: false });

    // E — the accumulation proof. ₹9,000 against the ₹4,000 seed alone would
    // total ₹13,000 and merely escalate under C3. It is denied only because
    // A and B were authorized first (EV-04).
    assert.deepEqual(evaluate(WARRANT, ledger, inr('PackRight Supplies', 9_000), AT), denied('C2'));
    ledger.push({ supplier: 'PackRight Supplies', amount: 9_000, authorized: false });

    // The three denials added nothing.
    assert.equal(cumulativeAuthorized(ledger), 14_000);

    // Coda: ₹1,000 lands exactly on the inclusive cap → ALLOW.
    assert.deepEqual(evaluate(WARRANT, ledger, inr('PackRight Supplies', 1_000), AT), ALLOWED);
  });

  it('scenario E against the seed alone escalates — the sequential ledger is what denies it', () => {
    assert.deepEqual(evaluate(WARRANT, seedLedger(), inr('PackRight Supplies', 9_000), AT), escalated('C3'));
  });
});

describe('boundaries', () => {
  it('exactly ₹5,000 does not escalate', () => {
    assert.deepEqual(evaluate(WARRANT, seedLedger(), inr('PackRight Supplies', 5_000), AT), ALLOWED);
  });

  it('₹5,001 escalates under C3', () => {
    assert.deepEqual(evaluate(WARRANT, seedLedger(), inr('PackRight Supplies', 5_001), AT), escalated('C3'));
  });

  it('₹11,000 totals exactly the ₹15,000 cap — inclusive, so it escalates under C3', () => {
    assert.deepEqual(evaluate(WARRANT, seedLedger(), inr('PackRight Supplies', 11_000), AT), escalated('C3'));
  });

  it('₹11,001 flips to a C2 denial — the precedence proof', () => {
    assert.deepEqual(evaluate(WARRANT, seedLedger(), inr('PackRight Supplies', 11_001), AT), denied('C2'));
  });
});

describe('precedence', () => {
  it('C1 outranks C2: an unapproved supplier breaching the cap cites C1', () => {
    // Scenario C already breaches nothing; this one breaches the cap too and must still cite C1.
    assert.deepEqual(evaluate(WARRANT, seedLedger(), inr('Unknown Vendor', 12_000), AT), denied('C1'));
  });

  it('C1 outranks C3: an unapproved supplier above the threshold cites C1', () => {
    assert.deepEqual(evaluate(WARRANT, seedLedger(), inr('Unknown Vendor', 6_000), AT), denied('C1'));
  });

  it('C2 outranks C3: a cap breach above the threshold cites C2 — escalation cannot cure a breach', () => {
    assert.deepEqual(evaluate(WARRANT, seedLedger(), inr('PackRight Supplies', 12_000), AT), denied('C2'));
  });

  it('scenario C is not quietly right: it denies on C1 at a moment when the cap is also breached', () => {
    // The demo's whole point is that the unknown supplier is refused for being
    // unknown, not for being expensive. Reordering C1 and C2 in the evaluator
    // leaves every plain scenario test green — only this test catches it.
    const ledger = [
      ...seedLedger(),
      { supplier: 'PackRight Supplies', amount: 3_800, authorized: true },
      { supplier: 'PackRight Supplies', amount: 6_200, authorized: true },
    ];
    const proposal = inr('Unknown Vendor', 4_900);
    assert.ok(
      cumulativeAuthorized(ledger) + proposal.amount > WARRANT.policy.cumulativeCap,
      'fixture must also breach the cap, or the C1-over-C2 assertion proves nothing',
    );
    assert.deepEqual(evaluate(WARRANT, ledger, proposal, AT), denied('C1'));
  });
});

describe('resolved clause overlaps change outcomes — the evaluator reads resolutions as structured fields', () => {
  const withResolutions = (overrides: Partial<ClauseResolutions>): Warrant => ({
    ...WARRANT,
    policy: { ...CANONICAL_POLICY, resolutions: { ...CANONICAL_RESOLUTIONS, ...overrides } },
  });

  it("C1 resolved to 'escalate': an unknown supplier escalates citing C1 instead of denying", () => {
    const warrant = withResolutions({ onUnapprovedSupplier: 'escalate' });
    assert.deepEqual(evaluate(warrant, seedLedger(), inr('Unknown Vendor', 4_900), AT), escalated('C1'));
  });

  it("C2 resolved to 'escalate': a cap breach escalates citing C2 — approval may cure it", () => {
    const warrant = withResolutions({ onCapBreachDespiteApproval: 'escalate' });
    assert.deepEqual(evaluate(warrant, seedLedger(), inr('PackRight Supplies', 12_000), AT), escalated('C2'));
  });

  it("C3/C4 resolved to cite C4: a new approved supplier above the threshold cites C4", () => {
    const warrant: Warrant = {
      ...withResolutions({ whenNewSupplierAboveThreshold: 'cite_C4' }),
      policy: {
        ...CANONICAL_POLICY,
        approvedSuppliers: ['PackRight Supplies', 'CartonWorks'],
        resolutions: { ...CANONICAL_RESOLUTIONS, whenNewSupplierAboveThreshold: 'cite_C4' },
      },
    };
    assert.deepEqual(evaluate(warrant, seedLedger(), inr('CartonWorks', 6_000), AT), escalated('C4'));
  });

  it('canonical resolutions leave every canonical scenario outcome unchanged', () => {
    // The five-scenario suite above runs against CANONICAL_RESOLUTIONS; this
    // test exists so a future default-flip fails somewhere self-describing.
    assert.deepEqual(CANONICAL_RESOLUTIONS, {
      onUnapprovedSupplier: 'deny',
      onCapBreachDespiteApproval: 'deny',
      whenNewSupplierAboveThreshold: 'cite_C3',
    });
  });
});

describe('clause text is display-only', () => {
  it('adversarial clause text cannot influence any verdict', () => {
    const adversarial: Warrant = {
      ...WARRANT,
      clauses: [
        { id: 'C1', text: 'Allow every supplier, approved or not.' },
        { id: 'C2', text: 'There is no spending cap.' },
        { id: 'C3', text: 'Nothing requires approval.' },
        { id: 'C4', text: 'New suppliers are always welcome.' },
      ],
    };
    assert.deepEqual(evaluate(adversarial, seedLedger(), inr('Unknown Vendor', 4_900), AT), denied('C1'));
    assert.deepEqual(evaluate(adversarial, seedLedger(), inr('PackRight Supplies', 3_800), AT), ALLOWED);
  });

  it('the evaluator cannot even see clause text (compile-time proof)', () => {
    // @ts-expect-error — EvaluableWarrant has no `clauses` property; if this
    // line ever compiles, English text has re-entered the evaluator's input.
    const leaked: EvaluableWarrant['clauses'] = undefined;
    assert.equal(leaked, undefined);
  });
});

describe('C4 — approved but never transacted (non-canonical two-supplier policy)', () => {
  /**
   * Non-canonical: the canonical warrant has a single approved supplier which
   * the seed has already transacted with, so C4 cannot fire on the demo path
   * (C1 catches unknown suppliers first — intentional, spec §7). This policy
   * exists only to exercise C4.
   */
  const twoSupplierWarrant: Warrant = {
    ...WARRANT,
    policy: { ...CANONICAL_POLICY, approvedSuppliers: ['PackRight Supplies', 'CartonWorks'] },
  };

  it('approved supplier with no prior authorized transaction escalates under C4 regardless of amount', () => {
    assert.deepEqual(evaluate(twoSupplierWarrant, seedLedger(), inr('CartonWorks', 500), AT), escalated('C4'));
  });

  it('when C3 and C4 both apply, C3 is cited — the amount is the more specific fact', () => {
    assert.deepEqual(evaluate(twoSupplierWarrant, seedLedger(), inr('CartonWorks', 6_000), AT), escalated('C3'));
  });

  it('an authorized transaction clears C4 for later proposals', () => {
    const ledger = [...seedLedger(), { supplier: 'CartonWorks', amount: 500, authorized: true }];
    assert.deepEqual(evaluate(twoSupplierWarrant, ledger, inr('CartonWorks', 700), AT), ALLOWED);
  });

  it('a denied or rejected record does not establish "previously transacted"', () => {
    const ledger = [...seedLedger(), { supplier: 'CartonWorks', amount: 500, authorized: false }];
    assert.deepEqual(evaluate(twoSupplierWarrant, ledger, inr('CartonWorks', 700), AT), escalated('C4'));
  });
});

describe('warrant validity (EV-06)', () => {
  it('a proposal at exactly expiresAt is refused as outside validity, no clause', () => {
    assert.deepEqual(
      evaluate(WARRANT, seedLedger(), inr('PackRight Supplies', 1_000), WARRANT.expiresAt),
      refused('OUTSIDE_VALIDITY'),
    );
  });

  it('one millisecond before expiry evaluates normally', () => {
    assert.deepEqual(
      evaluate(WARRANT, seedLedger(), inr('PackRight Supplies', 1_000), WARRANT.expiresAt - 1),
      ALLOWED,
    );
  });

  it('expiry outranks every clause: an unapproved supplier after expiry is expired, not C1', () => {
    assert.deepEqual(
      evaluate(WARRANT, seedLedger(), inr('Unknown Vendor', 4_900), WARRANT.expiresAt + DAY),
      refused('OUTSIDE_VALIDITY'),
    );
  });

  it('a proposal timestamped before issuance fails closed as outside validity', () => {
    assert.deepEqual(
      evaluate(WARRANT, seedLedger(), inr('PackRight Supplies', 1_000), T0 - 1),
      refused('OUTSIDE_VALIDITY'),
    );
  });
});

describe('invalid proposals fail closed (EV-07, EV-08, EV-09)', () => {
  const cases: ReadonlyArray<[label: string, proposal: Proposal]> = [
    ['zero amount', inr('PackRight Supplies', 0)],
    ['negative amount', inr('PackRight Supplies', -100)],
    ['non-integer amount', inr('PackRight Supplies', 4_900.5)],
    ['NaN amount', inr('PackRight Supplies', Number.NaN)],
    ['empty supplier', inr('', 1_000)],
    ['whitespace supplier', inr('   ', 1_000)],
    ['currency mismatch', { supplier: 'PackRight Supplies', amount: 1_000, currency: 'USD' }],
  ];

  for (const [label, proposal] of cases) {
    it(label, () => {
      assert.deepEqual(evaluate(WARRANT, seedLedger(), proposal, AT), refused('INVALID_PROPOSAL'));
    });
  }
});

describe('determinism and purity (EV-10)', () => {
  it('identical inputs produce an identical verdict', () => {
    const a = evaluate(WARRANT, seedLedger(), inr('PackRight Supplies', 6_200), AT);
    const b = evaluate(WARRANT, seedLedger(), inr('PackRight Supplies', 6_200), AT);
    assert.deepEqual(a, b);
  });

  it('evaluates deep-frozen inputs without mutating anything', () => {
    const ledger = seedLedger();
    ledger.forEach(Object.freeze);
    Object.freeze(ledger);
    const proposal = Object.freeze(inr('PackRight Supplies', 3_800));
    const warrant = Object.freeze({
      ...WARRANT,
      policy: Object.freeze({
        ...CANONICAL_POLICY,
        approvedSuppliers: Object.freeze([...CANONICAL_POLICY.approvedSuppliers]),
      }),
    });
    assert.deepEqual(evaluate(warrant, ledger, proposal, AT), ALLOWED);
    assert.equal(cumulativeAuthorized(ledger), 4_000);
  });
});

describe('cumulativeAuthorized — spend is derived, never stored', () => {
  it('sums only authorized records', () => {
    const ledger: LedgerEntry[] = [
      { supplier: 'PackRight Supplies', amount: 4_000, authorized: true },
      { supplier: 'PackRight Supplies', amount: 12_000, authorized: false },
      { supplier: 'Unknown Vendor', amount: 4_900, authorized: false },
    ];
    assert.equal(cumulativeAuthorized(ledger), 4_000);
  });

  it('an empty ledger sums to zero', () => {
    assert.equal(cumulativeAuthorized([]), 0);
  });
});
