/**
 * Deterministic policy evaluation. Pure functions, no clock, no I/O, no
 * dependencies. The model never decides: this module's verdict is the
 * enforcement decision, and everything it reads is a structured field.
 *
 * Evaluation order IS clause precedence — each check only runs if every
 * check above it passed:
 *
 *   validity → proposal shape → C1 → C2 → C3 → C4 → ALLOW
 *
 * - Validity first: outside the mandate nothing is evaluated (EV-06).
 * - C1 before C2: an unapproved supplier is refused for being unknown, not
 *   for being expensive — scenario C breaches the cap arithmetically and
 *   must still cite C1.
 * - C2 before C3: a hard cap breach outranks the approval threshold, because
 *   escalation cannot cure a breach.
 * - C3 before C4: where both apply, both escalate — the amount is the more
 *   specific fact, so C3 is cited.
 */
import type { EvaluableWarrant, LedgerEntry, Proposal, Verdict } from './types.ts';

/**
 * Cumulative authorized spend under the warrant, derived by summation every
 * time it is needed. There is no stored counter and no rolling window
 * (invariant 7); the limit window is aligned to warrant validity, so the
 * ledger for this warrant is the window.
 */
export function cumulativeAuthorized(ledger: readonly LedgerEntry[]): number {
  let total = 0;
  for (const entry of ledger) {
    if (entry.authorized) total += entry.amount;
  }
  return total;
}

/** C4's question: has this supplier an authorized transaction under this warrant? */
function hasTransacted(ledger: readonly LedgerEntry[], supplier: string): boolean {
  return ledger.some((entry) => entry.authorized && entry.supplier === supplier);
}

/** EV-07/08/09 — a proposal the engine refuses to reason about at all. */
function isWellFormed(proposal: Proposal, warrantCurrency: string): boolean {
  return (
    proposal.supplier.trim().length > 0 &&
    Number.isSafeInteger(proposal.amount) &&
    proposal.amount > 0 &&
    proposal.currency === warrantCurrency
  );
}

export function evaluate(
  warrant: EvaluableWarrant,
  ledger: readonly LedgerEntry[],
  proposal: Proposal,
  at: number,
): Verdict {
  // Phrased positively so a NaN timestamp fails closed too.
  const withinValidity = at >= warrant.issuedAt && at < warrant.expiresAt;
  if (!withinValidity) {
    return { decision: 'DENY', clause: null, reason: 'EXPIRED_MANDATE' };
  }

  if (!isWellFormed(proposal, warrant.policy.currency)) {
    return { decision: 'DENY', clause: null, reason: 'INVALID_PROPOSAL' };
  }

  const { approvedSuppliers, cumulativeCap, approvalThreshold, resolutions } = warrant.policy;

  // C1 — approved suppliers only. The human resolved what "only" means for an
  // unknown supplier; the canonical resolution is deny.
  if (!approvedSuppliers.includes(proposal.supplier)) {
    return resolutions.onUnapprovedSupplier === 'deny'
      ? { decision: 'DENY', clause: 'C1', reason: null }
      : { decision: 'ESCALATE', clause: 'C1', reason: null };
  }

  // C2 — the cap is inclusive: a running total of exactly the cap is not a
  // breach. Whether approval can cure a breach is the human's resolved choice;
  // canonically it cannot ("escalation cannot cure a breach").
  if (cumulativeAuthorized(ledger) + proposal.amount > cumulativeCap) {
    return resolutions.onCapBreachDespiteApproval === 'deny'
      ? { decision: 'DENY', clause: 'C2', reason: null }
      : { decision: 'ESCALATE', clause: 'C2', reason: null };
  }

  const isNewSupplier = !hasTransacted(ledger, proposal.supplier);

  // C3 — strictly above the threshold escalates; exactly at it does not.
  // Where C3 and C4 both apply the outcome is escalation either way; the
  // citation is the human's resolved choice (canonically C3, the amount
  // being the more specific fact).
  if (proposal.amount > approvalThreshold) {
    const clause =
      isNewSupplier && resolutions.whenNewSupplierAboveThreshold === 'cite_C4' ? 'C4' : 'C3';
    return { decision: 'ESCALATE', clause, reason: null };
  }

  // C4 — approved, but no prior authorized transaction under this warrant.
  if (isNewSupplier) {
    return { decision: 'ESCALATE', clause: 'C4', reason: null };
  }

  return { decision: 'ALLOW', clause: null, reason: null };
}
