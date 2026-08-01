/**
 * Human confirmation — the moment a draft becomes an enforceable warrant.
 *
 * - `confirm()` throws while any ambiguity flag is unanswered. There is no
 *   force flag and no default: an unresolved question blocks activation.
 * - Option keys are matched case-insensitively — real runs returned `a,b,c`
 *   on one call and `A,B,C` on another. Position is never used: rehearsal
 *   proved position-based inference unsound.
 * - Validity is stamped HERE, by the system, from the caller-supplied clock
 *   value. The model never emits it (invariant 6), and this module never
 *   reads a clock (invariant 5).
 */
import type { ClauseResolutions, Warrant } from '../engine/types.ts';
import type { ClausePath, ClausePathValues, CompiledDraft } from './schema.ts';

/** Warrant validity: 7 days from issuance; the limit window is aligned to it (invariant 8). */
export const WARRANT_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Fail-closed baseline for any clause path no chosen option sets. Matches the
 * canonical demo resolutions: refuse unknown suppliers, the cap is absolute,
 * cite the amount.
 */
export const BASELINE_RESOLUTIONS: ClauseResolutions = {
  onUnapprovedSupplier: 'deny',
  onCapBreachDespiteApproval: 'deny',
  whenNewSupplierAboveThreshold: 'cite_C3',
};

type ConfirmationErrorKind =
  | 'unanswered'
  | 'unknown-flag'
  | 'unknown-option'
  | 'conflicting-resolutions'
  | 'unresolved-draft'
  | 'invalid-time';

export class ConfirmationError extends Error {
  readonly kind: ConfirmationErrorKind;

  constructor(kind: ConfirmationErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = 'ConfirmationError';
  }
}

/** Flag id → chosen option key (matched case-insensitively). */
export type FlagAnswers = Readonly<Record<string, string>>;

const RESOLUTION_FIELD: { readonly [P in ClausePath]: keyof ClauseResolutions } = {
  'C1.onUnapprovedSupplier': 'onUnapprovedSupplier',
  'C2.onCapBreachDespiteApproval': 'onCapBreachDespiteApproval',
  'C4.whenNewSupplierAboveThreshold': 'whenNewSupplierAboveThreshold',
};

/**
 * Confirm a compiled draft, producing an enforceable warrant.
 *
 * @param issuedAt epoch ms of the confirmation event, supplied by the caller —
 *                 the system's clock, read exactly once at the call site.
 */
export function confirm(draft: CompiledDraft, answers: FlagAnswers, issuedAt: number): Warrant {
  if (!Number.isFinite(issuedAt)) {
    throw new ConfirmationError('invalid-time', `issuedAt must be a finite epoch-ms number, got ${issuedAt}`);
  }

  const unanswered = draft.flags.filter((flag) => !(flag.id in answers));
  if (unanswered.length > 0) {
    throw new ConfirmationError(
      'unanswered',
      `cannot confirm: unanswered ambiguity flag(s): ${unanswered.map((f) => f.id).join(', ')} — ` +
        'every flag must be resolved by the human before the draft becomes enforceable',
    );
  }

  const flagIds = new Set(draft.flags.map((f) => f.id));
  const strayAnswers = Object.keys(answers).filter((id) => !flagIds.has(id));
  if (strayAnswers.length > 0) {
    throw new ConfirmationError(
      'unknown-flag',
      `answers reference flag(s) the draft does not contain: ${strayAnswers.join(', ')}`,
    );
  }

  // Apply each chosen option's machine-readable effects. Identical repeated
  // values are fine; a genuine conflict between two chosen options is not.
  const applied: Partial<Record<ClausePath, { value: string; flagId: string }>> = {};
  for (const flag of draft.flags) {
    const answerKey = answers[flag.id]!;
    const option = flag.options.find((o) => o.key.toLowerCase() === answerKey.toLowerCase());
    if (!option) {
      const keys = flag.options.map((o) => o.key).join(', ');
      throw new ConfirmationError(
        'unknown-option',
        `flag ${flag.id}: answer "${answerKey}" matches none of its options (${keys})`,
      );
    }
    for (const [path, value] of Object.entries(option.sets) as [ClausePath, string][]) {
      const prior = applied[path];
      if (prior && prior.value !== value) {
        throw new ConfirmationError(
          'conflicting-resolutions',
          `flags ${prior.flagId} and ${flag.id} resolve ${path} differently (${prior.value} vs ${value})`,
        );
      }
      applied[path] = { value, flagId: flag.id };
    }
  }

  const resolutions = { ...BASELINE_RESOLUTIONS };
  for (const [path, entry] of Object.entries(applied) as [ClausePath, { value: string }][]) {
    (resolutions as Record<string, string>)[RESOLUTION_FIELD[path]] =
      entry.value as ClausePathValues[ClausePath];
  }

  // A draft with unresolved values cannot be confirmed — flagging ambiguity
  // is the compiler's job; resolving it silently here would undo that.
  const missing: string[] = [];
  if (draft.currency === null) missing.push('currency');
  if (draft.cumulativeLimit === null) missing.push('cumulativeLimit');
  if (draft.perOrderThreshold === null) missing.push('perOrderThreshold');
  if (missing.length > 0) {
    throw new ConfirmationError(
      'unresolved-draft',
      `cannot confirm a draft with unresolved value(s): ${missing.join(', ')}`,
    );
  }

  return {
    policy: {
      approvedSuppliers: [...draft.approvedSuppliers],
      cumulativeCap: draft.cumulativeLimit!,
      approvalThreshold: draft.perOrderThreshold!,
      currency: draft.currency!,
      resolutions,
    },
    clauses: [...draft.clauses],
    issuedAt,
    expiresAt: issuedAt + WARRANT_VALIDITY_MS,
  };
}
