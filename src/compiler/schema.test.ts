import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCompiledDraft, stubDraft } from './draft.ts';
import { validateModelDraft } from './schema.ts';
import { CompilerRejection } from './validityGuard.ts';

type LooseFlag = {
  id: string;
  question: string;
  clauses: string[];
  options: { key: string; label: string; sets: Record<string, string> }[];
};

/** A minimal valid model output for the canonical demo policy. */
const validModelOutput = () => ({
  policySummary: 'Approved suppliers only; ₹15,000 weekly cap; approval above ₹5,000 and for new suppliers.',
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
  flags: [
    {
      id: 'f1',
      question: 'Unknown supplier: refuse or escalate?',
      clauses: ['C1', 'C4'],
      options: [
        { key: 'A', label: 'Refuse', sets: { 'C1.onUnapprovedSupplier': 'deny' } },
        { key: 'B', label: 'Escalate', sets: { 'C1.onUnapprovedSupplier': 'escalate' } },
      ],
    },
  ] as LooseFlag[],
  confirmationChecklist: ['Suppliers: PackRight only'],
});

const expectSchemaRejection = (value: unknown, fragment: string) => {
  assert.throws(
    () => validateModelDraft(value),
    (err: unknown) =>
      err instanceof CompilerRejection && err.stage === 'schema' && err.message.includes(fragment),
  );
};

describe('validateModelDraft — strict, additionalProperties: false semantics', () => {
  it('accepts a valid draft', () => {
    const draft = validateModelDraft(validModelOutput());
    assert.equal(draft.cumulativeLimit, 15_000);
    assert.equal(draft.flags.length, 1);
  });

  it('rejects an unknown top-level key', () => {
    expectSchemaRejection({ ...validModelOutput(), vibe: 'good' }, 'unexpected key(s): vibe');
  });

  it('rejects an unknown key nested in a clause', () => {
    const output = validModelOutput();
    (output.clauses[0] as Record<string, unknown>)['note'] = 'extra';
    expectSchemaRejection(output, 'unexpected key(s): note');
  });

  it('rejects an option whose sets is empty — a flag must be load-bearing', () => {
    const output = validModelOutput();
    (output.flags[0]!.options[0] as { sets: object }).sets = {};
    expectSchemaRejection(output, 'at least one clause path');
  });

  it('rejects a sets key outside the closed enum of clause paths', () => {
    const output = validModelOutput();
    (output.flags[0]!.options[0] as { sets: object }).sets = { 'C1.mood': 'deny' };
    expectSchemaRejection(output, 'not a clause path the evaluator reads');
  });

  it('rejects a sets value outside the per-path enum', () => {
    const output = validModelOutput();
    (output.flags[0]!.options[0] as { sets: object }).sets = { 'C1.onUnapprovedSupplier': 'maybe' };
    expectSchemaRejection(output, 'expected one of deny, escalate');
  });

  it('rejects option keys that collide case-insensitively', () => {
    const output = validModelOutput();
    (output.flags[0]!.options[1] as { key: string }).key = 'a';
    expectSchemaRejection(output, 'unique case-insensitively');
  });

  it('rejects a fabricated non-integer amount and accepts null', () => {
    expectSchemaRejection({ ...validModelOutput(), cumulativeLimit: 15_000.5 }, 'integer or null');
    assert.equal(validateModelDraft({ ...validModelOutput(), cumulativeLimit: null }).cumulativeLimit, null);
  });
});

describe('parseCompiledDraft — pipeline order and provenance', () => {
  it('rejects non-JSON at the json stage', () => {
    assert.throws(
      () => parseCompiledDraft('Here is your policy: {...}'),
      (err: unknown) => err instanceof CompilerRejection && err.stage === 'json',
    );
  });

  it('runs the validity guard BEFORE schema validation', () => {
    // This object is schema-invalid in several ways, but it also smuggles a
    // nested expiry — the guard must be the stage that rejects it.
    const raw = JSON.stringify({ nonsense: true, nested: { expires_at: 'tomorrow' } });
    assert.throws(
      () => parseCompiledDraft(raw),
      (err: unknown) => err instanceof CompilerRejection && err.stage === 'validity-guard',
    );
  });

  it("stamps model-raised flags detectedBy: 'model'", () => {
    const draft = parseCompiledDraft(JSON.stringify(validModelOutput()));
    assert.equal(draft.flags[0]?.detectedBy, 'model');
  });

  it('backstops uncovered clause paths with system flags — never taking model credit', () => {
    const draft = parseCompiledDraft(JSON.stringify(validModelOutput()));
    // The model covered C1 only; the system must add the other two overlaps.
    assert.equal(draft.flags.length, 3);
    const system = draft.flags.filter((f) => f.detectedBy === 'system');
    assert.deepEqual(
      system.flatMap((f) => f.options.flatMap((o) => Object.keys(o.sets))).sort(),
      [
        'C2.onCapBreachDespiteApproval',
        'C2.onCapBreachDespiteApproval',
        'C4.whenNewSupplierAboveThreshold',
        'C4.whenNewSupplierAboveThreshold',
      ],
    );
  });

  it('adds no system flags when the model covered all three overlaps', () => {
    const output = validModelOutput();
    output.flags.push(
      {
        id: 'f2',
        question: 'Approval vs cap?',
        clauses: ['C2', 'C3'],
        options: [
          { key: 'A', label: 'Cap absolute', sets: { 'C2.onCapBreachDespiteApproval': 'deny' } },
          { key: 'B', label: 'Approval wins', sets: { 'C2.onCapBreachDespiteApproval': 'escalate' } },
        ],
      },
      {
        id: 'f3',
        question: 'Cite which clause?',
        clauses: ['C3', 'C4'],
        options: [
          { key: 'A', label: 'C3', sets: { 'C4.whenNewSupplierAboveThreshold': 'cite_C3' } },
          { key: 'B', label: 'C4', sets: { 'C4.whenNewSupplierAboveThreshold': 'cite_C4' } },
        ],
      },
    );
    const draft = parseCompiledDraft(JSON.stringify(output));
    assert.equal(draft.flags.length, 3);
    assert.ok(draft.flags.every((f) => f.detectedBy === 'model'));
  });
});

describe('stubDraft — the built-in fallback', () => {
  it('says loudly what it is and raises all three overlaps as system flags', () => {
    const stub = stubDraft();
    assert.match(stub.policySummary, /BUILT-IN FALLBACK/);
    assert.equal(stub.flags.length, 3);
    assert.ok(stub.flags.every((f) => f.detectedBy === 'system'));
  });
});
