import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { compilePolicy } from './compile.ts';
import { CompilerRejection } from './validityGuard.ts';

const POLICY = 'Buy only from approved suppliers.';

/** Minimal fake of the SDK's message stream: async-iterable events + finalMessage(). */
const fakeStreamClient = (text: string, stopReason = 'end_turn'): Anthropic => {
  const stream = {
    async *[Symbol.asyncIterator]() {
      // Emit the text in two chunks so streaming callbacks are exercised.
      const mid = Math.ceil(text.length / 2);
      yield { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'weighing clause overlaps' } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: text.slice(0, mid) } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: text.slice(mid) } };
    },
    finalMessage: async () => ({
      model: 'fake-model-1',
      stop_reason: stopReason,
      content: text.length > 0 ? [{ type: 'text', text }] : [],
    }),
  };
  return { messages: { stream: () => stream } } as unknown as Anthropic;
};

const throwingClient = (message: string): Anthropic =>
  ({
    messages: {
      stream: () => {
        throw new Error(message);
      },
    },
  }) as unknown as Anthropic;

const validOutput = JSON.stringify({
  policySummary: 'Approved suppliers only.',
  currency: null,
  approvedSuppliers: ['PackRight Supplies'],
  cumulativeLimit: null,
  perOrderThreshold: null,
  newSupplierRequiresApproval: false,
  clauses: [{ id: 'C1', text: 'Buy only from approved suppliers.' }],
  flags: [],
  confirmationChecklist: ['Suppliers: PackRight Supplies only'],
});

describe('compilePolicy', () => {
  it('parses a model response, streams its characters, and reports the serving model', async () => {
    const seen: string[] = [];
    const thinking: string[] = [];
    const result = await compilePolicy(POLICY, {
      client: fakeStreamClient(validOutput),
      onText: (chunk) => seen.push(chunk),
      onThinking: (chunk) => thinking.push(chunk),
    });
    assert.equal(result.source, 'model');
    assert.ok(result.source === 'model' && result.model === 'fake-model-1');
    assert.equal(seen.join(''), validOutput);
    assert.ok(thinking.length > 0);
  });

  it('falls back to the BUILT-IN stub when the API is unreachable — loudly, never silently', async () => {
    const result = await compilePolicy(POLICY, { client: throwingClient('ECONNREFUSED 127.0.0.1') });
    assert.equal(result.source, 'stub');
    assert.ok(result.source === 'stub' && result.reason.includes('ECONNREFUSED'));
    assert.match(result.draft.policySummary, /BUILT-IN FALLBACK/);
  });

  it('falls back with an explicit reason when the whole model chain refused', async () => {
    const result = await compilePolicy(POLICY, { client: fakeStreamClient('', 'refusal') });
    assert.equal(result.source, 'stub');
    assert.ok(result.source === 'stub' && result.reason.includes('declined'));
  });

  it('REFUSES (does not stub) a model response that emits validity — the guard is not an availability problem', async () => {
    const smuggled = JSON.stringify({ constraints: { expires_at: '2026-08-08' } });
    await assert.rejects(
      compilePolicy(POLICY, { client: fakeStreamClient(smuggled) }),
      (err: unknown) => err instanceof CompilerRejection && err.stage === 'validity-guard',
    );
  });

  it('REFUSES (does not stub) a schema-invalid model response', async () => {
    await assert.rejects(
      compilePolicy(POLICY, { client: fakeStreamClient('{"nonsense": true}') }),
      (err: unknown) => err instanceof CompilerRejection && err.stage === 'schema',
    );
  });
});
