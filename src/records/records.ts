/**
 * Append-only authorization record types and the ledger derivation.
 *
 * Event-sourced by design: records are never updated. An approval and a
 * provider result arrive after the decision they concern, so each is its own
 * chained append referencing the decision record — not a mutation of it.
 *
 * The load-bearing property: `authorized` is DERIVED, never stored. A bare
 * {supplier, amount} row that nobody can trace to a verdict is unrepresentable
 * — spend counts only what a decision record's verdict (plus, for an
 * escalation, its linked human approval) says it may. The evaluator's
 * LedgerEntry is a view computed here, and the evaluator never reads
 * `evidence` — that field exists for reconstruction, not for arithmetic
 * (invariant 7 stays intact).
 */
import type { LedgerEntry, Proposal, Verdict } from '../engine/types.ts';

/**
 * The demo's single fixed operator identity. Multi-tenant RBAC is out of
 * scope, and nothing gets typed on camera — the type admits exactly one value.
 */
export const OPERATOR_ID = 'ops-manager';
export type OperatorId = typeof OPERATOR_ID;

/** Fields every chained record carries. Hash values are computed by the (future) chain module. */
export interface RecordCommon {
  /** Unique id within the log. */
  readonly id: string;
  readonly warrantId: string;
  readonly warrantVersion: number;
  /** Epoch ms, system-stamped at append. */
  readonly at: number;
  /** Hash of the previous record; a defined genesis value for the first (AR-06). */
  readonly previousHash: string;
  readonly recordHash: string;
}

/** One evaluated proposal, with the verdict exactly as the evaluator returned it. */
export interface DecisionRecord extends RecordCommon {
  readonly kind: 'decision';
  readonly proposal: Proposal;
  readonly verdict: Verdict;
  /** Snapshot for reconstruction only — never read back by the evaluator. */
  readonly evidence: { readonly cumulativeAuthorizedBefore: number };
}

/** A human decision on an escalated proposal. Only ever valid against an ESCALATE decision. */
export interface ApprovalRecord extends RecordCommon {
  readonly kind: 'approval';
  readonly decisionId: string;
  readonly outcome: 'approved' | 'rejected';
  readonly approvedBy: OperatorId;
}

/** The provider's own result for an executed authorization, appended in the background (PR-10). */
export interface SessionResultRecord extends RecordCommon {
  readonly kind: 'session_result';
  readonly decisionId: string;
  /** Provider session id — a reference, never a credential. */
  readonly sessionRef: string;
  /** The provider's word, verbatim (e.g. "SUCCESS"). */
  readonly outcome: string;
}

export type AuthorizationRecord = DecisionRecord | ApprovalRecord | SessionResultRecord;

/** Thrown when the log is internally inconsistent; derivation fails closed (EV-12 spirit). */
export class LedgerIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerIntegrityError';
  }
}

/**
 * Derive the evaluator's ledger view from the record log.
 *
 * authorized ⇔ verdict is ALLOW, or verdict is ESCALATE with a linked human
 * approval whose outcome is 'approved'. Everything else — denials, rejected
 * or still-pending escalations — contributes nothing to spend and does not
 * establish C4 transaction history.
 *
 * Fails closed on: an approval referencing a missing decision, an approval
 * attached to a non-ESCALATE decision (an approved DENY must be impossible —
 * HA-03), and conflicting approvals for the same decision. A duplicate
 * approval with the identical outcome collapses to one (double-click
 * idempotence — HA-05).
 */
export function deriveLedger(log: readonly AuthorizationRecord[]): LedgerEntry[] {
  const decisions = new Map<string, DecisionRecord>();
  for (const record of log) {
    if (record.kind === 'decision') {
      if (decisions.has(record.id)) {
        throw new LedgerIntegrityError(`duplicate decision record id ${record.id}`);
      }
      decisions.set(record.id, record);
    }
  }

  const approvals = new Map<string, ApprovalRecord>();
  for (const record of log) {
    if (record.kind !== 'approval') continue;
    const decision = decisions.get(record.decisionId);
    if (!decision) {
      throw new LedgerIntegrityError(
        `approval ${record.id} references missing decision ${record.decisionId} — refusing to compute a total from an inconsistent log`,
      );
    }
    if (decision.verdict.decision !== 'ESCALATE') {
      throw new LedgerIntegrityError(
        `approval ${record.id} attached to a ${decision.verdict.decision} decision — only an escalation can be approved or rejected`,
      );
    }
    const prior = approvals.get(record.decisionId);
    if (prior && prior.outcome !== record.outcome) {
      throw new LedgerIntegrityError(
        `conflicting approvals for decision ${record.decisionId} (${prior.outcome} vs ${record.outcome})`,
      );
    }
    approvals.set(record.decisionId, prior ?? record);
  }

  for (const record of log) {
    if (record.kind === 'session_result' && !decisions.has(record.decisionId)) {
      throw new LedgerIntegrityError(
        `session result ${record.id} references missing decision ${record.decisionId}`,
      );
    }
  }

  return [...decisions.values()].map((decision) => ({
    supplier: decision.proposal.supplier,
    amount: decision.proposal.amount,
    authorized:
      decision.verdict.decision === 'ALLOW' ||
      (decision.verdict.decision === 'ESCALATE' &&
        approvals.get(decision.id)?.outcome === 'approved'),
  }));
}
