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
 * know about a session. Narrowing happens by explicit field copy in
 * #createSession, so extra fields never survive into state.
 */
export interface ProviderSession {
  readonly sessionRef: string;
  readonly status: 'awaiting_verification' | 'confirmed' | 'declined';
}

export interface ProviderPort {
  createSession(args: { supplier: string; amount: number; currency: string }): Promise<ProviderSession>;
}

/** Payment leg as the console sees it. Vocabulary is camera-safe: nothing here reads as a bug. */
export interface PaymentView {
  readonly status: 'requested' | 'awaiting_verification' | 'confirmed' | 'declined' | 'unavailable';
  readonly sessionRef: string | null;
}

export interface FlowDeps {
  /** null = no payment leg attached in this build phase; the console says so honestly. */
  readonly provider: ProviderPort | null;
  readonly clock: () => number;
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
  readonly #credentialRequests = 0; // no code path increments this in this phase, and the DENY view shows it
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
   * On approval, session creation starts in the background; nothing awaits it.
   */
  approve(decisionId: string, outcome: 'approved' | 'rejected'): void {
    const approval = this.log.appendApproval({
      decisionId,
      outcome,
      approvedBy: OPERATOR_ID,
      at: this.#deps.clock(),
    });
    if (approval.outcome === 'approved' && this.#deps.provider) {
      void this.#createSession(decisionId);
    }
  }

  /** The ONLY call site of the provider port. Guarded even though approve() already gates. */
  async #createSession(decisionId: string): Promise<void> {
    if (!this.#deps.provider) return;
    if (!this.log.isExecutable(decisionId)) {
      throw new EnforcementError(
        'not-executable',
        `refusing to create a payment session for non-executable decision ${decisionId}`,
      );
    }
    const decision = this.log.records.find(
      (r): r is DecisionRecord => r.kind === 'decision' && r.id === decisionId,
    )!;
    this.#outboundCalls += 1;
    this.#outboundPerDecision.set(decisionId, (this.#outboundPerDecision.get(decisionId) ?? 0) + 1);
    this.#paymentsByDecision.set(decisionId, { status: 'requested', sessionRef: null });
    try {
      const session = await this.#deps.provider.createSession({
        supplier: decision.proposal.supplier,
        amount: decision.proposal.amount,
        currency: decision.proposal.currency,
      });
      this.#paymentSessionsCreated += 1;
      // Explicit field copy — the allowlist. Extra provider fields stop here.
      this.#paymentsByDecision.set(decisionId, {
        status: session.status,
        sessionRef: session.sessionRef,
      });
    } catch {
      this.#paymentsByDecision.set(decisionId, { status: 'unavailable', sessionRef: null });
    }
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
  flow.approve(first.id, 'approved');
  const second = flow.propose('PackRight Supplies', 1_500);
  if (second.verdict.decision !== 'ALLOW') {
    throw new Error(`seed integrity: second purchase expected ALLOW, got ${second.verdict.decision}`);
  }
}
