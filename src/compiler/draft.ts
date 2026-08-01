/**
 * Draft pipeline: raw model text → CompiledDraft, failing closed at every
 * step, in this order:
 *
 *   1. JSON.parse            — malformed output is refused, not repaired
 *   2. validity guard        — BEFORE anything else is checked (invariant 6)
 *   3. strict schema         — see schema.ts
 *   4. provenance stamp      — every model flag gets detectedBy: 'model'
 *   5. overlap backstop      — any clause path no flag covers gets a
 *                              system-raised flag, detectedBy: 'system'.
 *                              The system never quietly takes the model's
 *                              credit, and confirmation still blocks on it.
 */
import type { AmbiguityFlag, ClausePath, CompiledDraft, ModelFlag } from './schema.ts';
import { CLAUSE_PATHS, validateModelDraft } from './schema.ts';
import { assertNoValidityKeys, CompilerRejection } from './validityGuard.ts';

/** The overlap questions the demo policy admits; used only when the model missed one. */
const SYSTEM_BACKSTOP_FLAGS: { readonly [P in ClausePath]: ModelFlag } = {
  'C1.onUnapprovedSupplier': {
    id: 'sys-c1-c4-unknown-supplier',
    question:
      'C1 allows approved suppliers only; C4 says a new supplier needs approval. Which applies to a supplier that is not on the list at all — refused outright, or escalated for your approval?',
    clauses: ['C1', 'C4'],
    options: [
      { key: 'A', label: 'Refuse outright', sets: { 'C1.onUnapprovedSupplier': 'deny' } },
      { key: 'B', label: 'Escalate for my approval', sets: { 'C1.onUnapprovedSupplier': 'escalate' } },
    ],
  },
  'C2.onCapBreachDespiteApproval': {
    id: 'sys-c2-c3-approval-vs-cap',
    question:
      'Orders above the per-order threshold escalate for your approval (C3). If an order you approve would push cumulative spend over the cap (C2), does your approval authorise breaching the cap?',
    clauses: ['C2', 'C3'],
    options: [
      { key: 'A', label: 'No — the cap is absolute; refuse', sets: { 'C2.onCapBreachDespiteApproval': 'deny' } },
      { key: 'B', label: 'Yes — escalate and let me decide', sets: { 'C2.onCapBreachDespiteApproval': 'escalate' } },
    ],
  },
  'C4.whenNewSupplierAboveThreshold': {
    id: 'sys-c3-c4-citation',
    question:
      'A new supplier above the threshold triggers both C3 (amount) and C4 (new supplier); either way it escalates. Which clause should the decision cite?',
    clauses: ['C3', 'C4'],
    options: [
      { key: 'A', label: 'Cite C3 — the amount', sets: { 'C4.whenNewSupplierAboveThreshold': 'cite_C3' } },
      { key: 'B', label: 'Cite C4 — the new supplier', sets: { 'C4.whenNewSupplierAboveThreshold': 'cite_C4' } },
    ],
  },
};

const coveredPaths = (flags: readonly ModelFlag[]): Set<ClausePath> => {
  const covered = new Set<ClausePath>();
  for (const flag of flags) {
    for (const option of flag.options) {
      for (const path of Object.keys(option.sets)) covered.add(path as ClausePath);
    }
  }
  return covered;
};

/** Parse and validate raw model output into a CompiledDraft. Throws CompilerRejection. */
export function parseCompiledDraft(raw: string): CompiledDraft {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new CompilerRejection('json', `compiler output is not valid JSON: ${(cause as Error).message}`);
  }

  assertNoValidityKeys(parsed);
  const draft = validateModelDraft(parsed);

  const modelFlags: AmbiguityFlag[] = draft.flags.map((flag) => ({ ...flag, detectedBy: 'model' }));
  const covered = coveredPaths(draft.flags);
  const systemFlags: AmbiguityFlag[] = CLAUSE_PATHS.filter((path) => !covered.has(path)).map(
    (path) => ({ ...SYSTEM_BACKSTOP_FLAGS[path], detectedBy: 'system' }),
  );

  return { ...draft, flags: [...modelFlags, ...systemFlags] };
}

/**
 * BUILT-IN FALLBACK draft, used only when the API is unavailable. Every
 * consumer must display it as a fallback — a stub that looks like a real
 * compile puts a false claim in the demo. Constraint values are the
 * canonical warrant's (spec §6); flags are system-raised by definition.
 */
export function stubDraft(): CompiledDraft {
  return {
    policySummary:
      'BUILT-IN FALLBACK (not a live compile): approved suppliers only; ₹15,000 weekly cap; orders above ₹5,000 and new suppliers need approval.',
    currency: 'INR',
    approvedSuppliers: ['PackRight Supplies'],
    cumulativeLimit: 15_000,
    perOrderThreshold: 5_000,
    newSupplierRequiresApproval: true,
    clauses: [
      { id: 'C1', text: 'Buy only from approved suppliers.' },
      { id: 'C2', text: 'Do not exceed ₹15,000 per week.' },
      { id: 'C3', text: 'Any order above ₹5,000 requires approval.' },
      { id: 'C4', text: 'Never buy from a new supplier without approval.' },
    ],
    flags: CLAUSE_PATHS.map((path) => ({ ...SYSTEM_BACKSTOP_FLAGS[path], detectedBy: 'system' as const })),
    confirmationChecklist: [
      'Suppliers: PackRight Supplies only',
      'Cumulative cap: ₹15,000 per warrant period',
      'Approval needed above ₹5,000 and for any new supplier',
      'Nothing is enforceable until you confirm',
    ],
  };
}
