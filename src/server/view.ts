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
  /**
   * iframeUrl is the one deliberate URL passthrough: the provider's approval
   * page, used only as the href of the click-to-open new-tab anchor (one
   * load — the link is single-use). Everything else stays two fields + the
   * provider's own expiry and its confirmation word.
   */
  readonly payment: {
    readonly status: string;
    readonly sessionRef: string | null;
    readonly iframeUrl: string | null;
    readonly expiresAtIso: string | null;
    readonly visaConfirmation: string | null;
    /** The provider's own failure text on 'declined' — attribution, their words. */
    readonly providerError: string | null;
  } | null;
  readonly outboundCalls: number;
  /** Per-decision — the DENY panel's number. 0 for every non-executed decision even while another leg polls. */
  readonly credentialRequests: number;
  readonly sessionsAtDecision: number;
  /**
   * One plain sentence shown in the payment slot when the public demo's rate
   * limiter declined to start a session for this approval. The decision and
   * its record are complete; only the sandbox leg was withheld.
   */
  readonly paymentNotice: string | null;
}

export interface StateViewOptions {
  /** Public deployment: compile disabled, banner shown, reset offered. */
  readonly publicDemo?: boolean;
  /** Rate-limit sentence per decision id, if any. */
  readonly noticeFor?: (decisionId: string) => string | null;
}

export function stateView(
  flow: ConsoleFlow,
  cacheAvailable: boolean,
  paymentLeg: string,
  options: StateViewOptions = {},
) {
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
      payment: payment
        ? {
            status: payment.status,
            sessionRef: payment.sessionRef,
            iframeUrl: payment.iframeUrl,
            expiresAtIso: payment.expiresAtIso,
            visaConfirmation: payment.visaConfirmation,
            providerError: payment.providerError,
          }
        : null,
      outboundCalls: flow.outboundCallsFor(record.id),
      credentialRequests: flow.credentialRequestsFor(record.id),
      sessionsAtDecision: flow.sessionsAtDecision(record.id),
      paymentNotice: options.noticeFor?.(record.id) ?? null,
    };
  });

  const chain = flow.log.verify();

  return {
    cacheAvailable,
    /** 'attached (Prava sandbox)' · 'off (--nopay)' · 'not configured'. Never a key. */
    paymentLeg,
    /** True only on the public deployment: live compile off, banner on. */
    publicDemo: options.publicDemo === true,
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

/**
 * Spend status per decision entry, derived — never stored, never mutated, so
 * the log stays append-only. The KNOWN GAP, disclosed in README.md: spend
 * counts as authorized on approval, not on settlement, so a session that
 * lapses still consumes headroom. That is correct for a spending cap
 * (counting only settlements would let an agent open ten sessions and blow
 * the cap while all are in flight). This field exists so a future
 * reconciliation — an APPENDED hold-release entry, not an edit — could
 * release expired holds. Reconciliation is deliberately not built.
 */
export type SpendStatus =
  /** DENY, invalid, rejected or still-pending escalation — contributes nothing. */
  | 'not-counted'
  /** Authorized (ALLOW or approved escalation); counts toward the cap; no settlement recorded. */
  | 'hold'
  /** Authorized and a provider session result is chained to it. */
  | 'settled';

/**
 * The authorization record as a self-contained JSON document (AR-05): every
 * entry verbatim from the chained log plus derived fields, the chain
 * verification result, and the derived total. Built field-by-field like the
 * state view — no secrets exist in the log, and none can reach the export.
 */
export function exportView(flow: ConsoleFlow, exportedAtIso: string) {
  const warrant = flow.warrant;
  const records = flow.log.records;
  const sessionResultsByDecision = new Map<string, string>();
  for (const record of records) {
    if (record.kind === 'session_result') sessionResultsByDecision.set(record.decisionId, record.outcome);
  }
  const approvalsByDecision = new Map<string, 'approved' | 'rejected'>();
  for (const record of records) {
    if (record.kind === 'approval') approvalsByDecision.set(record.decisionId, record.outcome);
  }

  const ledger = flow.log.ledger();
  const chain = flow.log.verify();

  return {
    document: 'warrant-authorization-record',
    /** Tamper-evident via the hash chain. Deliberately NOT "signed" — no digital signatures exist here. */
    integrity: 'append-only, hash-chained (tamper-evident)',
    exportedAt: exportedAtIso,
    warrant: warrant
      ? {
          warrantId: 'warrant-demo-001',
          version: 1,
          issuedAt: new Date(warrant.issuedAt).toISOString(),
          expiresAt: new Date(warrant.expiresAt).toISOString(),
          currency: warrant.policy.currency,
          cumulativeCap: warrant.policy.cumulativeCap,
          approvalThreshold: warrant.policy.approvalThreshold,
          approvedSuppliers: [...warrant.policy.approvedSuppliers],
          clauses: warrant.clauses.map((c) => ({ id: c.id, text: c.text })),
        }
      : null,
    cumulativeAuthorized: ledger.reduce((sum, entry) => (entry.authorized ? sum + entry.amount : sum), 0),
    chain: chain.ok ? { verified: true } : { verified: false, atIndex: chain.atIndex, reason: chain.reason },
    entries: records.map((record) => {
      const base = {
        id: record.id,
        kind: record.kind,
        warrantId: record.warrantId,
        warrantVersion: record.warrantVersion,
        at: new Date(record.at).toISOString(),
        previousHash: record.previousHash,
        recordHash: record.recordHash,
      };
      switch (record.kind) {
        case 'decision': {
          const authorized =
            record.verdict.decision === 'ALLOW' ||
            (record.verdict.decision === 'ESCALATE' && approvalsByDecision.get(record.id) === 'approved');
          const spendStatus: SpendStatus = !authorized
            ? 'not-counted'
            : sessionResultsByDecision.has(record.id)
              ? 'settled'
              : 'hold';
          return {
            ...base,
            proposal: {
              supplier: record.proposal.supplier,
              amount: record.proposal.amount,
              currency: record.proposal.currency,
            },
            decision: record.verdict.decision,
            determiningClause: record.verdict.clause,
            reason: record.verdict.reason,
            evidence: { cumulativeAuthorizedBefore: record.evidence.cumulativeAuthorizedBefore },
            spendStatus,
          };
        }
        case 'approval':
          return { ...base, decisionId: record.decisionId, outcome: record.outcome, approvedBy: record.approvedBy };
        case 'session_result':
          return { ...base, decisionId: record.decisionId, sessionRef: record.sessionRef, outcome: record.outcome };
      }
    }),
  };
}
