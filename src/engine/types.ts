/**
 * Core types for the deterministic policy evaluation engine.
 *
 * Spec: Warrant-PreHackathon-Pack `current/01_PRODUCT_SPEC.md` §5–7 (pack v1.4).
 *
 * Conventions, fixed for the whole engine:
 * - Amounts are integer rupees. The canonical demo uses whole ₹ throughout;
 *   a non-integer amount is an invalid proposal, not a rounding candidate.
 * - Timestamps are epoch milliseconds and are always passed in as parameters.
 *   Nothing in the engine reads a clock (invariant 5: determinism).
 */

/** Clause ids fixed by the canonical compiled warrant (spec §6). */
export type ClauseId = 'C1' | 'C2' | 'C3' | 'C4';

/**
 * Clauses that can determine a DENY.
 * C1 — approved suppliers only (the human resolved unknown-supplier to deny).
 * C2 — cumulative cap over the limit window; escalation cannot cure a breach.
 */
export type DenialClause = 'C1' | 'C2';

/**
 * Clauses that can determine an ESCALATE.
 * C3 — amount strictly above the approval threshold.
 * C4 — approved supplier with no prior authorized transaction under this
 *      warrant. Under the strict allowlist reading C4 can never fire for an
 *      unapproved supplier — C1 catches it first. Intentional (spec §7).
 */
export type EscalationClause = 'C3' | 'C4';

/**
 * Denials that are not clause breaches — both fail closed.
 * EXPIRED_MANDATE — the proposal falls outside warrant validity (EV-06).
 *   Also used for a proposal timestamped before issuance: outside validity
 *   is outside validity.
 * INVALID_PROPOSAL — malformed input: missing supplier, zero / negative /
 *   non-integer amount, or currency mismatch (EV-07, EV-08, EV-09).
 */
export type DenialReason = 'EXPIRED_MANDATE' | 'INVALID_PROPOSAL';

/** The constraint fields of the compiled warrant that the evaluator enforces. */
export interface CompiledPolicy {
  /** C1 / C4 — exact supplier names as confirmed by the human. */
  readonly approvedSuppliers: readonly string[];
  /**
   * C2 — cumulative cap in integer ₹ across the limit window. The window is
   * aligned to warrant validity (invariant 8), so "under this warrant" and
   * "inside the window" are the same set of records — no rolling arithmetic.
   * The cap is inclusive: a running total of exactly the cap is not a breach.
   */
  readonly cumulativeCap: number;
  /** C3 — amounts strictly above this escalate, integer ₹. Exactly at the threshold does not. */
  readonly approvalThreshold: number;
  /** Warrant currency ("INR" in the demo). Proposals in any other currency are refused. */
  readonly currency: string;
}

/** One clause of the compiled warrant as confirmed by the human — id plus display text (spec §6). */
export interface ClauseText {
  readonly id: ClauseId;
  readonly text: string;
}

/**
 * An active warrant. Validity is system-stamped at human confirmation
 * (invariant 6) — the model never emits `issuedAt`/`expiresAt`.
 */
export interface Warrant {
  readonly policy: CompiledPolicy;
  /**
   * Clause display text for the console and the record ("C1 — Buy only from
   * approved suppliers."). Display-only: evaluation never reads it. The
   * evaluator's parameter type (`EvaluableWarrant`) excludes this field, so a
   * compiled English string cannot influence a verdict.
   */
  readonly clauses: readonly ClauseText[];
  /** Epoch ms, stamped by the system at confirmation. */
  readonly issuedAt: number;
  /** Epoch ms, issuedAt + 7 days, stamped by the system. Valid while issuedAt ≤ t < expiresAt. */
  readonly expiresAt: number;
}

/**
 * What the evaluator is allowed to see: structured constraint fields and
 * system-stamped validity only. `clauses` (English text) is typed out of
 * reach — "Claude compiles, code decides" is enforced at the type boundary,
 * not by discipline.
 */
export type EvaluableWarrant = Omit<Warrant, 'clauses'>;

/**
 * The evaluator's view of one prior decision under this warrant. The full
 * authorization record (hash chain, approval events, session refs) is a later
 * module; the evaluator consumes only what clause evaluation needs.
 *
 * Ledger integrity (EV-12 — deleted records must fail closed) is the record
 * module's job: the caller hands the evaluator a verified view. The evaluator
 * itself never recomputes or second-guesses history.
 */
export interface LedgerEntry {
  readonly supplier: string;
  readonly amount: number;
  /**
   * True for ALLOW outcomes and human-approved escalations — these count
   * toward cumulative spend and establish "previously transacted" for C4.
   * False for denials and rejected escalations — these contribute nothing.
   */
  readonly authorized: boolean;
}

/** A purchase the agent proposes. Evaluation time is a separate parameter, never a field the agent controls. */
export interface Proposal {
  readonly supplier: string;
  readonly amount: number;
  readonly currency: string;
}

/**
 * The evaluator's result. Exactly one determining clause is ever cited, and
 * the union enforces it: `clause` is non-null on exactly the outcomes a clause
 * produced, and no variant can carry two clauses or a clause plus a reason.
 *
 * - ALLOW      → clause null, reason null (nothing breached).
 * - ESCALATE   → determining clause C3 or C4.
 * - DENY       → determining clause C1 or C2, *or* a non-clause reason
 *                (expired mandate / invalid proposal) with clause null.
 */
export type Verdict =
  | { readonly decision: 'ALLOW'; readonly clause: null; readonly reason: null }
  | { readonly decision: 'ESCALATE'; readonly clause: EscalationClause; readonly reason: null }
  | { readonly decision: 'DENY'; readonly clause: DenialClause; readonly reason: null }
  | { readonly decision: 'DENY'; readonly clause: null; readonly reason: DenialReason };
