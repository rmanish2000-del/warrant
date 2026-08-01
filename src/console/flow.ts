/**
 * Console flow — the state machine behind the operator console and the
 * headless runner. Pure application logic: no HTTP, no DOM, no clock reads
 * (the clock is injected), no provider specifics (the provider is a port).
 *
 * Structural guarantees, by construction rather than discipline:
 * - The payment provider is reachable from exactly one code path, and that
 *   path sits behind the enforcement boundary's `isExecutable` check plus a
 *   recorded human approval. A DENY cannot reach it; a forced approval on a
 *   DENY dies in the log's own checks.
 * - Provider work is fire-and-forget: nothing that renders the refusal (or
 *   any decision) ever awaits a payment result.
 * - Only the fields of `PaymentView` are copied off provider responses —
 *   a provider object carrying extra fields (tokens, iframe URLs) is
 *   structurally unreachable from console state.
 */
import { evaluate } from '../engine/evaluate.ts';
import type { Verdict, Warrant } from '../engine/types.ts';
import { confirm } from '../compiler/confirm.ts';
import type { FlagAnswers } from '../compiler/confirm.ts';
import type { CompileResult } from '../compiler/compile.ts';
import type { ClausePathValues, CompiledDraft } from '../compiler/schema.ts';
import { AuthorizationLog, EnforcementError } from '../records/append.ts';
import { OPERATOR_ID } from '../records/records.ts';
import type { DecisionRecord } from '../records/records.ts';

export const WARRANT_ID = 'warrant-demo-001';
export const WARRANT_VERSION = 1;

/** How the current draft reached the console — drives the load-bearing badge. */
export type CompileProvenance = 'live' | 'cache' | 'stub' | 'none';

/** The five canonical proposals, in demo order (spec §7). */
export const CANONICAL_PROPOSALS = [
  { label: 'A', supplier: 'PackRight Supplies', amount: 3_800, expected: 'ALLOW' },
  { label: 'B', supplier: 'PackRight Supplies', amount: 6_200, expected: 'ESCALATE' },
  { label: 'C', supplier: 'Unknown Vendor', amount: 4_900, expected: 'DENY' },
  { label: 'D', supplier: 'PackRight Supplies', amount: 12_000, expected: 'DENY' },
  { label: 'E', supplier: 'PackRight Supplies', amount: 9_000, expected: 'DENY' },
] as const;

/**
 * What the provider port may return — and therefore ALL the console can ever
 * know about a session. Narrowing happens by explicit field copy, so extra
 * fields (tokens, CVVs) never survive into state. Credential VALUES never
 * cross this port at all: `pollResult` reports readiness and a txn ref, not
 * the credential.
 */
export interface CreatedSession {
  readonly sessionRef: string;
  /** The provider's interactive approval page. Rendered ONLY as an iframe src, never as text. */
  readonly iframeUrl: string;
  /** The provider's own expiry — displayed as theirs, never recomputed locally. */
  readonly expiresAtIso: string;
}

export type PollOutcome =
  | { readonly kind: 'pending' }
  | { readonly kind: 'ready'; readonly txnRefId: string }
  | { readonly kind: 'failed'; readonly message: string };

export interface ProviderPort {
  createSession(args: {
    supplier: string;
    amount: number;
    currency: string;
    description: string;
  }): Promise<CreatedSession>;
  pollResult(sessionRef: string): Promise<PollOutcome>;
  reportApproved(sessionRef: string, txnRefId: string): Promise<{ visaConfirmation: string }>;
}

/** Payment leg as the console sees it. Vocabulary is camera-safe: nothing here reads as a bug. */
export interface PaymentView {
  readonly status:
    | 'requested'
    | 'awaiting_verification'
    | 'confirmed'
    | 'declined'
    | 'unavailable'
    | 'lapsed';
  readonly sessionRef: string | null;
  /** Deliberate exception to the no-URL rule: needed as iframe src for the human's passkey step. */
  readonly iframeUrl: string | null;
  readonly expiresAtIso: string | null;
  readonly visaConfirmation: string | null;
}

export interface FlowDeps {
  /** null = no payment leg attached (missing key or --nopay); the console says so honestly. */
  readonly provider: ProviderPort | null;
  readonly clock: () => number;
  /** Injected so tests are instant; defaults to real timers. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** A poll cycle really costs ~3.26s against the sandbox; default keeps a small gap. */
  readonly pollIntervalMs?: number;
}

const CANONICAL_TARGET: ClausePathValues = {
  'C1.onUnapprovedSupplier': 'deny',
  'C2.onCapBreachDespiteApproval': 'deny',
  'C4.whenNewSupplierAboveThreshold': 'cite_C3',
};

/**
 * For an arbitrary draft (model output varies run to run), pick for each flag
 * the option whose effects equal the canonical resolutions. Used by the
 * headless runner; the on-camera path is the human clicking.
 */
export function canonicalAnswersFor(draft: CompiledDraft): FlagAnswers {
  const answers: Record<string, string> = {};
  for (const flag of draft.flags) {
    const option = flag.options.find((candidate) =>
      Object.entries(candidate.sets).every(
        ([path, value]) => CANONICAL_TARGET[path as keyof ClausePathValues] === value,
      ),
    );
    if (!option) {
      throw new Error(
        `flag ${flag.id} has no option matching the canonical resolutions — resolve it manually`,
      );
    }
    answers[flag.id] = option.key;
  }
  return answers;
}

export class ConsoleFlow {
  readonly log = new AuthorizationLog();
  readonly #deps: FlowDeps;

  #draft: CompiledDraft | null = null;
  #provenance: CompileProvenance = 'none';
  #compileMeta: { model?: string; reason?: string; compiledAt?: string } = {};
  #warrant: Warrant | null = null;
  #answers: FlagAnswers | null = null;

  /** Counters shown on screen — data, not narration. */
  #outboundCalls = 0;
  #paymentSessionsCreated = 0;
  /** Bumped once per payment-result retrieval. Stays 0 for every non-executed decision. */
  #credentialRequests = 0;
  #outboundPerDecision = new Map<string, number>();
  #paymentsByDecision = new Map<string, PaymentView>();
  #sessionsAtDecision = new Map<string, number>();

  constructor(deps: FlowDeps) {
    this.#deps = deps;
  }

  adoptDraft(result: CompileResult, provenance: Exclude<CompileProvenance, 'none'>, compiledAt?: string): void {
    this.#draft = result.draft;
    this.#provenance = provenance;
    this.#compileMeta = {
      model: result.source === 'model' ? result.model : undefined,
      reason: result.source === 'stub' ? result.reason : undefined,
      compiledAt,
    };
    this.#warrant = null;
    this.#answers = null;
  }

  confirmWarrant(answers: FlagAnswers): Warrant {
    if (!this.#draft) throw new Error('nothing to confirm — compile a policy first');
    this.#warrant = confirm(this.#draft, answers, this.#deps.clock());
    this.#answers = answers;
    return this.#warrant;
  }

  /** Evaluate a proposal and record the decision. Never touches the provider. */
  propose(supplier: string, amount: number): DecisionRecord {
    const warrant = this.#requireWarrant();
    const proposal = { supplier, amount, currency: warrant.policy.currency };
    const verdict: Verdict = evaluate(warrant, this.log.ledger(), proposal, this.#deps.clock());
    const record = this.log.appendDecision({
      warrantId: WARRANT_ID,
      warrantVersion: WARRANT_VERSION,
      proposal,
      verdict,
      at: this.#deps.clock(),
    });
    this.#outboundPerDecision.set(record.id, 0);
    this.#sessionsAtDecision.set(record.id, this.#paymentSessionsCreated);
    return record;
  }

  /**
   * Record the human's decision on an escalation. The log's enforcement
   * checks run first — a DENY dies there before anything else can happen.
   * On approval, the payment leg starts in the background; nothing awaits it.
   *
   * `startPayment: false` exists for seeded history only: those approvals are
   * real records of past authority, but their execution predates this demo,
   * so no new sandbox session is created for them.
   */
  approve(
    decisionId: string,
    outcome: 'approved' | 'rejected',
    options: { startPayment?: boolean } = {},
  ): void {
    const approval = this.log.appendApproval({
      decisionId,
      outcome,
      approvedBy: OPERATOR_ID,
      at: this.#deps.clock(),
    });
    if (approval.outcome === 'approved' && this.#deps.provider && options.startPayment !== false) {
      void this.#runPaymentLeg(decisionId);
    }
  }

  #bumpOutbound(decisionId: string): void {
    this.#outboundCalls += 1;
    this.#outboundPerDecision.set(decisionId, (this.#outboundPerDecision.get(decisionId) ?? 0) + 1);
  }

  #setPayment(decisionId: string, view: PaymentView): void {
    this.#paymentsByDecision.set(decisionId, view);
  }

  /**
   * The ONLY call sites of the provider port, all behind isExecutable plus a
   * recorded human approval. Fire-and-forget: the refusal path (and every
   * other decision) renders regardless of what happens in here.
   */
  async #runPaymentLeg(decisionId: string): Promise<void> {
    const provider = this.#deps.provider;
    if (!provider) return;
    if (!this.log.isExecutable(decisionId)) {
      throw new EnforcementError(
        'not-executable',
        `refusing to create a payment session for non-executable decision ${decisionId}`,
      );
    }
    const decision = this.log.records.find(
      (r): r is DecisionRecord => r.kind === 'decision' && r.id === decisionId,
    )!;
    const none = { sessionRef: null, iframeUrl: null, expiresAtIso: null, visaConfirmation: null };
    this.#bumpOutbound(decisionId);
    this.#setPayment(decisionId, { status: 'requested', ...none });
    let session: CreatedSession;
    try {
      const created = await provider.createSession({
        supplier: decision.proposal.supplier,
        amount: decision.proposal.amount,
        currency: decision.proposal.currency,
        description: `authorized purchase — ${decision.proposal.supplier}`,
      });
      this.#paymentSessionsCreated += 1;
      // Explicit field copy — the allowlist. Extra provider fields stop here.
      session = {
        sessionRef: created.sessionRef,
        iframeUrl: created.iframeUrl,
        expiresAtIso: created.expiresAtIso,
      };
    } catch {
      this.#setPayment(decisionId, { status: 'unavailable', ...none });
      return;
    }
    this.#setPayment(decisionId, {
      status: 'awaiting_verification',
      sessionRef: session.sessionRef,
      iframeUrl: session.iframeUrl,
      expiresAtIso: session.expiresAtIso,
      visaConfirmation: null,
    });
    try {
      await this.#watchSession(decisionId, session);
    } catch {
      this.#setPayment(decisionId, {
        status: 'unavailable',
        sessionRef: session.sessionRef,
        iframeUrl: null,
        expiresAtIso: session.expiresAtIso,
        visaConfirmation: null,
      });
    }
  }

  /**
   * Background watcher. THE TRAP, honored: never wait for status "completed"
   * — the port's pollResult answers "does the credential exist yet", which the
   * provider implementation checks via line_items token presence. Terminates
   * on the provider's own expires_at; a session that lapses is worded as
   * lapsed, never as an error.
   */
  async #watchSession(decisionId: string, session: CreatedSession): Promise<void> {
    const provider = this.#deps.provider!;
    const sleep = this.#deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const interval = this.#deps.pollIntervalMs ?? 4_000;
    const expiresAtMs = Date.parse(session.expiresAtIso);
    while (this.#deps.clock() < expiresAtMs) {
      await sleep(interval);
      this.#credentialRequests += 1;
      this.#bumpOutbound(decisionId);
      const outcome = await provider.pollResult(session.sessionRef);
      if (outcome.kind === 'pending') continue;
      if (outcome.kind === 'failed') {
        this.#setPayment(decisionId, {
          status: 'declined',
          sessionRef: session.sessionRef,
          iframeUrl: null,
          expiresAtIso: session.expiresAtIso,
          visaConfirmation: null,
        });
        return;
      }
      this.#bumpOutbound(decisionId);
      const report = await provider.reportApproved(session.sessionRef, outcome.txnRefId);
      this.log.appendSessionResult({
        decisionId,
        sessionRef: session.sessionRef,
        outcome: report.visaConfirmation,
        at: this.#deps.clock(),
      });
      this.#setPayment(decisionId, {
        status: 'confirmed',
        sessionRef: session.sessionRef,
        iframeUrl: null,
        expiresAtIso: session.expiresAtIso,
        visaConfirmation: report.visaConfirmation,
      });
      return;
    }
    this.#setPayment(decisionId, {
      status: 'lapsed',
      sessionRef: session.sessionRef,
      iframeUrl: null,
      expiresAtIso: session.expiresAtIso,
      visaConfirmation: null,
    });
  }

  #requireWarrant(): Warrant {
    if (!this.#warrant) throw new Error('no active warrant — confirm the draft first');
    return this.#warrant;
  }

  // ----- read side -----

  get draft(): CompiledDraft | null {
    return this.#draft;
  }
  get provenance(): CompileProvenance {
    return this.#provenance;
  }
  get compileMeta(): { model?: string; reason?: string; compiledAt?: string } {
    return this.#compileMeta;
  }
  get warrant(): Warrant | null {
    return this.#warrant;
  }
  get answers(): FlagAnswers | null {
    return this.#answers;
  }
  get outboundCalls(): number {
    return this.#outboundCalls;
  }
  get paymentSessionsCreated(): number {
    return this.#paymentSessionsCreated;
  }
  get credentialRequests(): number {
    return this.#credentialRequests;
  }
  outboundCallsFor(decisionId: string): number {
    return this.#outboundPerDecision.get(decisionId) ?? 0;
  }
  paymentFor(decisionId: string): PaymentView | null {
    return this.#paymentsByDecision.get(decisionId) ?? null;
  }
  sessionsAtDecision(decisionId: string): number {
    return this.#sessionsAtDecision.get(decisionId) ?? 0;
  }
}

/**
 * Seed the ₹4,000 prior history THROUGH the enforcement boundary — real
 * decisions, and a real recorded approval by the named operator (the first
 * PackRight purchase escalates under C4, exactly as a first purchase should).
 * Throws if the seed does not come out as designed: seeded data must be real.
 */
export function seedHistory(flow: ConsoleFlow): void {
  const first = flow.propose('PackRight Supplies', 2_500);
  if (first.verdict.decision !== 'ESCALATE') {
    throw new Error(`seed integrity: first purchase expected to ESCALATE (C4), got ${first.verdict.decision}`);
  }
  // Real approval record; no payment leg — seeded history's execution predates this demo.
  flow.approve(first.id, 'approved', { startPayment: false });
  const second = flow.propose('PackRight Supplies', 1_500);
  if (second.verdict.decision !== 'ALLOW') {
    throw new Error(`seed integrity: second purchase expected ALLOW, got ${second.verdict.decision}`);
  }
}
