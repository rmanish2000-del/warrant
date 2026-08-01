/**
 * Compiled-draft schema: the shape the model is constrained to produce and
 * the runtime validation that refuses anything else (invariant 10: schema
 * invalid → refuse; invariant 11: no fabrication — unresolved values are
 * null + flagged, never invented).
 *
 * Required fields follow the pack's Prompt 1 spec (03_PROMPT_SPECIFICATIONS.md):
 * policy summary, currency, approved suppliers, cumulative limit, per-order
 * threshold, new-supplier rule, clauses, ambiguity flags, confirmation
 * checklist. Validity is deliberately absent — see validityGuard.ts.
 */
import type { ClauseId, ClauseText } from '../engine/types.ts';
import { CompilerRejection } from './validityGuard.ts';

/**
 * The closed enum of machine-readable effects an ambiguity option may carry.
 * Each path is a field the evaluator actually reads (ClauseResolutions in
 * src/engine/types.ts) — a flag whose answer changes nothing is unexpressible.
 */
export interface ClausePathValues {
  readonly 'C1.onUnapprovedSupplier': 'deny' | 'escalate';
  readonly 'C2.onCapBreachDespiteApproval': 'deny' | 'escalate';
  readonly 'C4.whenNewSupplierAboveThreshold': 'cite_C3' | 'cite_C4';
}

export type ClausePath = keyof ClausePathValues;

export const CLAUSE_PATH_VALUES: { readonly [P in ClausePath]: readonly ClausePathValues[P][] } = {
  'C1.onUnapprovedSupplier': ['deny', 'escalate'],
  'C2.onCapBreachDespiteApproval': ['deny', 'escalate'],
  'C4.whenNewSupplierAboveThreshold': ['cite_C3', 'cite_C4'],
};

export const CLAUSE_PATHS = Object.keys(CLAUSE_PATH_VALUES) as readonly ClausePath[];

/** What choosing an option does — at least one path, validated at runtime. */
export type OptionSets = Partial<ClausePathValues>;

export interface FlagOption {
  /** Matched case-insensitively at confirmation — real runs returned `a,b,c` and `A,B,C`. */
  readonly key: string;
  readonly label: string;
  readonly sets: OptionSets;
}

/** An ambiguity as the model emits it. `detectedBy` is deliberately absent — the system stamps it. */
export interface ModelFlag {
  readonly id: string;
  readonly question: string;
  readonly clauses: readonly ClauseId[];
  readonly options: readonly FlagOption[];
}

export interface AmbiguityFlag extends ModelFlag {
  /** Who actually raised it. The model cannot claim 'system' and the system cannot quietly take 'model'. */
  readonly detectedBy: 'model' | 'system';
}

/** The draft exactly as the model emits it (post-validation, pre-stamping). */
export interface ModelDraft {
  readonly policySummary: string;
  /** Currency stated by the user, or null if unresolved (PC-03) — never invented. */
  readonly currency: string | null;
  readonly approvedSuppliers: readonly string[];
  /** Integer ₹, or null if the user stated no number — never invented. */
  readonly cumulativeLimit: number | null;
  readonly perOrderThreshold: number | null;
  readonly newSupplierRequiresApproval: boolean;
  readonly clauses: readonly ClauseText[];
  readonly flags: readonly ModelFlag[];
  readonly confirmationChecklist: readonly string[];
}

/** The draft after the system stamps flag provenance and backstops uncovered overlaps. */
export interface CompiledDraft extends Omit<ModelDraft, 'flags'> {
  readonly flags: readonly AmbiguityFlag[];
}

const CLAUSE_IDS = ['C1', 'C2', 'C3', 'C4'] as const;

const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] });

/**
 * JSON Schema sent to the API via `output_config.format`.
 * `additionalProperties: false` on every object level; no validity anywhere.
 */
export const DRAFT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'policySummary',
    'currency',
    'approvedSuppliers',
    'cumulativeLimit',
    'perOrderThreshold',
    'newSupplierRequiresApproval',
    'clauses',
    'flags',
    'confirmationChecklist',
  ],
  properties: {
    policySummary: { type: 'string', description: 'One-sentence restatement of the policy. No authorization language — the draft is not active until a human confirms it.' },
    currency: {
      ...nullable({ type: 'string' }),
      description: 'Currency stated or unambiguously implied by the user (e.g. "INR" for ₹). null if unresolved — never guess.',
    },
    approvedSuppliers: {
      type: 'array',
      items: { type: 'string' },
      description: 'Exactly the suppliers the user named. Empty if none were named. Never invent one.',
    },
    cumulativeLimit: {
      ...nullable({ type: 'integer' }),
      description: 'Cumulative cap for the limit window, integer, exactly as stated. null if not stated.',
    },
    perOrderThreshold: {
      ...nullable({ type: 'integer' }),
      description: 'Per-order approval threshold, integer, exactly as stated. null if not stated.',
    },
    newSupplierRequiresApproval: { type: 'boolean' },
    clauses: {
      type: 'array',
      description: 'One numbered clause per requirement, quoting the user\'s meaning faithfully.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'text'],
        properties: {
          id: { type: 'string', enum: [...CLAUSE_IDS] },
          text: { type: 'string' },
        },
      },
    },
    flags: {
      type: 'array',
      description: 'Clause overlaps and ambiguities for the human to resolve. Offer options; never pick a default yourself.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'question', 'clauses', 'options'],
        properties: {
          id: { type: 'string' },
          question: { type: 'string' },
          clauses: { type: 'array', items: { type: 'string', enum: [...CLAUSE_IDS] } },
          options: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['key', 'label', 'sets'],
              properties: {
                key: { type: 'string' },
                label: { type: 'string' },
                sets: {
                  type: 'object',
                  additionalProperties: false,
                  description: 'Machine-readable effect of choosing this option. At least one path.',
                  properties: {
                    'C1.onUnapprovedSupplier': { type: 'string', enum: ['deny', 'escalate'] },
                    'C2.onCapBreachDespiteApproval': { type: 'string', enum: ['deny', 'escalate'] },
                    'C4.whenNewSupplierAboveThreshold': { type: 'string', enum: ['cite_C3', 'cite_C4'] },
                  },
                },
              },
            },
          },
        },
      },
    },
    confirmationChecklist: {
      type: 'array',
      items: { type: 'string' },
      description: 'What the human is being asked to confirm, in plain language.',
    },
  },
} as const;

const fail = (path: string, message: string): never => {
  throw new CompilerRejection('schema', `${path}: ${message}`);
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const str = (v: unknown, path: string): string =>
  typeof v === 'string' && v.length > 0 ? v : fail(path, 'expected a non-empty string');

const strOrNull = (v: unknown, path: string): string | null =>
  v === null ? null : typeof v === 'string' && v.length > 0 ? v : fail(path, 'expected a non-empty string or null');

const intOrNull = (v: unknown, path: string): number | null =>
  v === null ? null : Number.isSafeInteger(v) ? (v as number) : fail(path, 'expected an integer or null');

const strArray = (v: unknown, path: string): string[] =>
  Array.isArray(v) ? v.map((s, i) => str(s, `${path}[${i}]`)) : fail(path, 'expected an array');

const clauseId = (v: unknown, path: string): ClauseId =>
  (CLAUSE_IDS as readonly string[]).includes(v as string) ? (v as ClauseId) : fail(path, `expected one of ${CLAUSE_IDS.join(', ')}`);

const noExtraKeys = (v: Record<string, unknown>, allowed: readonly string[], path: string): void => {
  const extras = Object.keys(v).filter((k) => !allowed.includes(k));
  if (extras.length > 0) fail(path, `unexpected key(s): ${extras.join(', ')} (additionalProperties: false)`);
};

const validateSets = (v: unknown, path: string): OptionSets => {
  if (!isRecord(v)) return fail(path, 'expected an object');
  const entries = Object.entries(v);
  if (entries.length === 0) {
    return fail(path, 'an option must set at least one clause path — a choice that changes nothing is not a choice');
  }
  const sets: Record<string, string> = {};
  for (const [key, value] of entries) {
    const allowed = (CLAUSE_PATH_VALUES as Record<string, readonly string[]>)[key];
    if (!allowed) return fail(`${path}.${key}`, `not a clause path the evaluator reads (allowed: ${CLAUSE_PATHS.join(', ')})`);
    if (!allowed.includes(value as string)) return fail(`${path}.${key}`, `expected one of ${allowed.join(', ')}`);
    sets[key] = value as string;
  }
  return sets as OptionSets;
};

const validateFlag = (v: unknown, path: string): ModelFlag => {
  if (!isRecord(v)) return fail(path, 'expected an object');
  noExtraKeys(v, ['id', 'question', 'clauses', 'options'], path);
  const options = Array.isArray(v['options'])
    ? v['options'].map((o, i) => {
        const oPath = `${path}.options[${i}]`;
        if (!isRecord(o)) return fail(oPath, 'expected an object');
        noExtraKeys(o, ['key', 'label', 'sets'], oPath);
        return {
          key: str(o['key'], `${oPath}.key`),
          label: str(o['label'], `${oPath}.label`),
          sets: validateSets(o['sets'], `${oPath}.sets`),
        };
      })
    : fail(`${path}.options`, 'expected an array');
  if (options.length < 2) fail(`${path}.options`, 'a flag needs at least two options to be a question');
  const lowered = options.map((o) => o.key.toLowerCase());
  if (new Set(lowered).size !== lowered.length) {
    fail(`${path}.options`, 'option keys must be unique case-insensitively (keys are matched case-insensitively)');
  }
  return {
    id: str(v['id'], `${path}.id`),
    question: str(v['question'], `${path}.question`),
    clauses: Array.isArray(v['clauses'])
      ? v['clauses'].map((c, i) => clauseId(c, `${path}.clauses[${i}]`))
      : fail(`${path}.clauses`, 'expected an array'),
    options,
  };
};

/**
 * Strict runtime validation of the model's parsed output. The API's schema
 * enforcement should make this a formality; it exists because "should" is not
 * an invariant, and because some rules (non-empty sets, unique keys) are not
 * expressible in the structured-output schema subset.
 */
export function validateModelDraft(value: unknown): ModelDraft {
  if (!isRecord(value)) return fail('$', 'expected a JSON object');
  noExtraKeys(value, [...DRAFT_JSON_SCHEMA.required], '$');
  for (const key of DRAFT_JSON_SCHEMA.required) {
    if (!(key in value)) fail(`$.${key}`, 'missing required field');
  }
  const clauses = Array.isArray(value['clauses'])
    ? value['clauses'].map((c, i) => {
        const cPath = `$.clauses[${i}]`;
        if (!isRecord(c)) return fail(cPath, 'expected an object');
        noExtraKeys(c, ['id', 'text'], cPath);
        return { id: clauseId(c['id'], `${cPath}.id`), text: str(c['text'], `${cPath}.text`) };
      })
    : fail('$.clauses', 'expected an array');
  if (clauses.length === 0) fail('$.clauses', 'a policy with no clauses compiles to nothing');
  const ids = clauses.map((c) => c.id);
  if (new Set(ids).size !== ids.length) fail('$.clauses', 'clause ids must be unique');

  const flags = Array.isArray(value['flags'])
    ? value['flags'].map((f, i) => validateFlag(f, `$.flags[${i}]`))
    : fail('$.flags', 'expected an array');
  const flagIds = flags.map((f) => f.id);
  if (new Set(flagIds).size !== flagIds.length) fail('$.flags', 'flag ids must be unique');

  const newSupplierRequiresApproval = value['newSupplierRequiresApproval'];
  if (typeof newSupplierRequiresApproval !== 'boolean') {
    return fail('$.newSupplierRequiresApproval', 'expected a boolean');
  }

  return {
    policySummary: str(value['policySummary'], '$.policySummary'),
    currency: strOrNull(value['currency'], '$.currency'),
    approvedSuppliers: strArray(value['approvedSuppliers'], '$.approvedSuppliers'),
    cumulativeLimit: intOrNull(value['cumulativeLimit'], '$.cumulativeLimit'),
    perOrderThreshold: intOrNull(value['perOrderThreshold'], '$.perOrderThreshold'),
    newSupplierRequiresApproval,
    clauses,
    flags,
    confirmationChecklist: strArray(value['confirmationChecklist'], '$.confirmationChecklist'),
  };
}
