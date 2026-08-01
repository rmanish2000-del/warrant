/**
 * The enforcement boundary. `evaluate()` upstream is pure and returns a
 * verdict; THIS is the component that turns verdicts into durable authority,
 * and it refuses to do so for anything the decision did not permit:
 *
 * - an approval can only attach to an ESCALATE decision — approving a DENY
 *   (or an ALLOW, which needs no approval) is rejected, not recorded;
 * - a session result can only attach to an executable decision (ALLOW, or
 *   ESCALATE with a recorded human approval);
 * - records are append-only and hash-chained: each record's hash covers its
 *   content plus the previous record's hash, so a modified record breaks
 *   verification (tamper-evident — never "cryptographically signed").
 *
 * If this class appended without checking, the cumulative cap would stop
 * meaning anything and the pure evaluator would be decoration.
 */
import { createHash } from 'node:crypto';
import type { LedgerEntry, Proposal, Verdict } from '../engine/types.ts';
import { cumulativeAuthorized } from '../engine/evaluate.ts';
import { deriveLedger } from './records.ts';
import type {
  ApprovalRecord,
  AuthorizationRecord,
  DecisionRecord,
  OperatorId,
  SessionResultRecord,
} from './records.ts';

/** Defined genesis previous-hash for the first record (AR-06). */
export const GENESIS_HASH = '0'.repeat(64);

type EnforcementErrorKind =
  | 'unknown-decision'
  | 'not-an-escalation'
  | 'conflicting-approval'
  | 'not-executable';

export class EnforcementError extends Error {
  readonly kind: EnforcementErrorKind;

  constructor(kind: EnforcementErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = 'EnforcementError';
  }
}

/** Deterministic JSON with sorted object keys, so hashes are reproducible. */
const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
};

const hashRecord = (record: Omit<AuthorizationRecord, 'recordHash'>): string =>
  createHash('sha256').update(stableStringify(record)).digest('hex');

export class AuthorizationLog {
  #records: AuthorizationRecord[] = [];
  #sequence = 0;

  get records(): readonly AuthorizationRecord[] {
    return this.#records;
  }

  /** The evaluator's view, derived fresh every time — spend is never a stored counter. */
  ledger(): LedgerEntry[] {
    return deriveLedger(this.#records);
  }

  #chain<R extends AuthorizationRecord>(build: (common: {
    id: string;
    previousHash: string;
  }) => Omit<R, 'recordHash'>): R {
    const previousHash =
      this.#records.length === 0 ? GENESIS_HASH : this.#records[this.#records.length - 1]!.recordHash;
    const withoutHash = build({ id: `rec-${++this.#sequence}`, previousHash });
    const record = { ...withoutHash, recordHash: hashRecord(withoutHash) } as R;
    this.#records.push(record);
    return record;
  }

  #decision(decisionId: string): DecisionRecord {
    const record = this.#records.find(
      (r): r is DecisionRecord => r.kind === 'decision' && r.id === decisionId,
    );
    if (!record) {
      throw new EnforcementError('unknown-decision', `no decision record ${decisionId} in the log`);
    }
    return record;
  }

  #approvalFor(decisionId: string): ApprovalRecord | undefined {
    return this.#records.find(
      (r): r is ApprovalRecord => r.kind === 'approval' && r.decisionId === decisionId,
    );
  }

  appendDecision(input: {
    warrantId: string;
    warrantVersion: number;
    proposal: Proposal;
    verdict: Verdict;
    at: number;
  }): DecisionRecord {
    const cumulativeAuthorizedBefore = cumulativeAuthorized(this.ledger());
    return this.#chain(({ id, previousHash }) => ({
      kind: 'decision' as const,
      id,
      warrantId: input.warrantId,
      warrantVersion: input.warrantVersion,
      at: input.at,
      previousHash,
      proposal: input.proposal,
      verdict: input.verdict,
      evidence: { cumulativeAuthorizedBefore },
    }));
  }

  /**
   * Record a human decision on an escalation. Refuses anything else: a DENY
   * cannot be approved into existence, an ALLOW needs no approval, and a
   * second conflicting approval is rejected. A duplicate with the identical
   * outcome returns the existing record (double-click idempotence, HA-05).
   */
  appendApproval(input: {
    decisionId: string;
    outcome: 'approved' | 'rejected';
    approvedBy: OperatorId;
    at: number;
  }): ApprovalRecord {
    const decision = this.#decision(input.decisionId);
    if (decision.verdict.decision !== 'ESCALATE') {
      throw new EnforcementError(
        'not-an-escalation',
        `decision ${input.decisionId} is ${decision.verdict.decision} — only an escalation can receive a human approval or rejection`,
      );
    }
    const existing = this.#approvalFor(input.decisionId);
    if (existing) {
      if (existing.outcome === input.outcome) return existing;
      throw new EnforcementError(
        'conflicting-approval',
        `decision ${input.decisionId} already has a recorded ${existing.outcome}; refusing to record ${input.outcome}`,
      );
    }
    return this.#chain(({ id, previousHash }) => ({
      kind: 'approval' as const,
      id,
      warrantId: decision.warrantId,
      warrantVersion: decision.warrantVersion,
      at: input.at,
      previousHash,
      decisionId: input.decisionId,
      outcome: input.outcome,
      approvedBy: input.approvedBy,
    }));
  }

  /** True iff the decision permits execution: ALLOW, or ESCALATE with a recorded approval. */
  isExecutable(decisionId: string): boolean {
    const decision = this.#decision(decisionId);
    if (decision.verdict.decision === 'ALLOW') return true;
    if (decision.verdict.decision === 'ESCALATE') {
      return this.#approvalFor(decisionId)?.outcome === 'approved';
    }
    return false;
  }

  /** Record the provider's result. Only an executable decision can carry one. */
  appendSessionResult(input: {
    decisionId: string;
    sessionRef: string;
    outcome: string;
    at: number;
  }): SessionResultRecord {
    const decision = this.#decision(input.decisionId);
    if (!this.isExecutable(input.decisionId)) {
      throw new EnforcementError(
        'not-executable',
        `decision ${input.decisionId} (${decision.verdict.decision}) does not permit execution — no session result may attach to it`,
      );
    }
    return this.#chain(({ id, previousHash }) => ({
      kind: 'session_result' as const,
      id,
      warrantId: decision.warrantId,
      warrantVersion: decision.warrantVersion,
      at: input.at,
      previousHash,
      decisionId: input.decisionId,
      sessionRef: input.sessionRef,
      outcome: input.outcome,
    }));
  }

  /** Recompute the chain. A modified or reordered record fails here (AR-04). */
  verify(): { ok: true } | { ok: false; atIndex: number; reason: string } {
    let expectedPrevious = GENESIS_HASH;
    for (const [index, record] of this.#records.entries()) {
      if (record.previousHash !== expectedPrevious) {
        return { ok: false, atIndex: index, reason: 'previous-hash mismatch' };
      }
      const { recordHash, ...rest } = record;
      if (hashRecord(rest) !== recordHash) {
        return { ok: false, atIndex: index, reason: 'record hash does not match record content' };
      }
      expectedPrevious = recordHash;
    }
    return { ok: true };
  }
}
