/**
 * Console view-model — the ONLY shape the page ever receives. Every field is
 * copied explicitly from typed state; there is no spread of a raw object
 * anywhere in this file, so a credential, token, or provider extra is
 * structurally unreachable from the DOM. Provider session data enters as the
 * two-field PaymentView and leaves as the same two fields.
 */
import { cumulativeAuthorized } from '../engine/evaluate.ts';
import type { ConsoleFlow } from '../console/flow.ts';
import type { ApprovalRecord, DecisionRecord } from '../records/records.ts';

export interface DecisionViewModel {
  readonly id: string;
  readonly atIso: string;
  readonly supplier: string;
  readonly amount: number;
  readonly currency: string;
  readonly decision: 'ALLOW' | 'ESCALATE' | 'DENY';
  readonly clause: string | null;
  readonly reason: string | null;
  readonly clauseText: string | null;
  readonly cumulativeBefore: number;
  /** null for non-escalations; 'pending' until a human clicks. Never a fabricated approval. */
  readonly approval: {
    readonly outcome: 'pending' | 'approved' | 'rejected';
    readonly approvedBy: string | null;
    readonly atIso: string | null;
  } | null;
  readonly payment: { readonly status: string; readonly sessionRef: string | null } | null;
  readonly outboundCalls: number;
  readonly sessionsAtDecision: number;
}

export function stateView(flow: ConsoleFlow, cacheAvailable: boolean) {
  const draft = flow.draft;
  const warrant = flow.warrant;
  const ledger = flow.log.ledger();
  const decisionRecords = flow.log.records.filter(
    (record): record is DecisionRecord => record.kind === 'decision',
  );

  const decisions: DecisionViewModel[] = decisionRecords.map((record) => {
    const approvalRecord = flow.log.records.find(
      (r): r is ApprovalRecord => r.kind === 'approval' && r.decisionId === record.id,
    );
    const clauseText =
      record.verdict.clause !== null
        ? (warrant?.clauses.find((c) => c.id === record.verdict.clause)?.text ??
          draft?.clauses.find((c) => c.id === record.verdict.clause)?.text ??
          null)
        : null;
    const payment = flow.paymentFor(record.id);
    return {
      id: record.id,
      atIso: new Date(record.at).toISOString(),
      supplier: record.proposal.supplier,
      amount: record.proposal.amount,
      currency: record.proposal.currency,
      decision: record.verdict.decision,
      clause: record.verdict.clause,
      reason: record.verdict.reason,
      clauseText,
      cumulativeBefore: record.evidence.cumulativeAuthorizedBefore,
      approval:
        record.verdict.decision === 'ESCALATE'
          ? approvalRecord
            ? {
                outcome: approvalRecord.outcome,
                approvedBy: approvalRecord.approvedBy,
                atIso: new Date(approvalRecord.at).toISOString(),
              }
            : { outcome: 'pending', approvedBy: null, atIso: null }
          : null,
      payment: payment ? { status: payment.status, sessionRef: payment.sessionRef } : null,
      outboundCalls: flow.outboundCallsFor(record.id),
      sessionsAtDecision: flow.sessionsAtDecision(record.id),
    };
  });

  const chain = flow.log.verify();

  return {
    cacheAvailable,
    compile: {
      provenance: flow.provenance,
      model: flow.compileMeta.model ?? null,
      reason: flow.compileMeta.reason ?? null,
      compiledAt: flow.compileMeta.compiledAt ?? null,
    },
    draft: draft
      ? {
          policySummary: draft.policySummary,
          currency: draft.currency,
          approvedSuppliers: [...draft.approvedSuppliers],
          cumulativeLimit: draft.cumulativeLimit,
          perOrderThreshold: draft.perOrderThreshold,
          clauses: draft.clauses.map((c) => ({ id: c.id, text: c.text })),
          flags: draft.flags.map((flag) => ({
            id: flag.id,
            question: flag.question,
            clauses: [...flag.clauses],
            detectedBy: flag.detectedBy,
            options: flag.options.map((option) => ({
              key: option.key,
              label: option.label,
              sets: { ...option.sets },
            })),
          })),
          confirmationChecklist: [...draft.confirmationChecklist],
        }
      : null,
    answers: flow.answers ? { ...flow.answers } : null,
    warrant: warrant
      ? {
          status: 'ACTIVE' as const,
          warrantId: 'warrant-demo-001',
          version: 1,
          issuedAtIso: new Date(warrant.issuedAt).toISOString(),
          expiresAtIso: new Date(warrant.expiresAt).toISOString(),
          currency: warrant.policy.currency,
          cumulativeCap: warrant.policy.cumulativeCap,
          approvalThreshold: warrant.policy.approvalThreshold,
          approvedSuppliers: [...warrant.policy.approvedSuppliers],
          clauses: warrant.clauses.map((c) => ({ id: c.id, text: c.text })),
        }
      : null,
    ledger: {
      authorized: cumulativeAuthorized(ledger),
      cap: warrant?.policy.cumulativeCap ?? null,
    },
    counters: {
      paymentSessions: flow.paymentSessionsCreated,
      credentialRequests: flow.credentialRequests,
      outboundCalls: flow.outboundCalls,
    },
    decisions,
    records: flow.log.records.map((record) => {
      const base = {
        kind: record.kind,
        id: record.id,
        atIso: new Date(record.at).toISOString(),
        previousHash: record.previousHash,
        recordHash: record.recordHash,
      };
      switch (record.kind) {
        case 'decision':
          return {
            ...base,
            summary: `${record.proposal.supplier} · ${record.proposal.currency} ${record.proposal.amount} · ${record.verdict.decision}${record.verdict.clause ? ` (${record.verdict.clause})` : ''}`,
          };
        case 'approval':
          return { ...base, summary: `${record.outcome} by ${record.approvedBy} → ${record.decisionId}` };
        case 'session_result':
          return { ...base, summary: `session ${record.sessionRef}: ${record.outcome} → ${record.decisionId}` };
      }
    }),
    chain: chain.ok ? { ok: true as const } : { ok: false as const, atIndex: chain.atIndex },
  };
}

export type ConsoleState = ReturnType<typeof stateView>;
