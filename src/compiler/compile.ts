/**
 * Streaming policy compile against the Anthropic API.
 *
 * Model configuration (recorded in CLAUDE.md): claude-opus-5, adaptive
 * thinking with summarized display (the 24–30s wait streams visible
 * reasoning, not a dead pause), structured output. Effort stays high —
 * lowering it saves seconds but risks missing the overlap flags, and the
 * flags are a demo beat.
 *
 * NO server-side refusal fallback, deliberately. The console's LIVE COMPILE
 * badge must mean exactly one thing — this model, this prompt. A silent
 * server-side substitution keeps the badge green while the provenance
 * underneath changes, which the operator cannot detect on camera. A refusal
 * therefore fails loudly into the labelled stub instead.
 *
 * Failure semantics, deliberately asymmetric:
 * - API unavailable (network, auth, rate limit, server error) or the model
 *   declined → BUILT-IN FALLBACK stub, `source: 'stub'`, loudly labelled.
 *   Never a silent substitute for a real compile.
 * - Model responded but the output fails the validity guard or schema →
 *   CompilerRejection propagates. That is a refusal, not an availability
 *   problem; papering over it with a stub would hide the exact failure the
 *   guard exists to catch.
 */
import Anthropic from '@anthropic-ai/sdk';
import { parseCompiledDraft, stubDraft } from './draft.ts';
import type { CompiledDraft } from './schema.ts';
import { DRAFT_JSON_SCHEMA } from './schema.ts';
import { COMPILER_PROMPT_VERSION, COMPILER_SYSTEM_PROMPT } from './prompt.ts';
import { CompilerRejection } from './validityGuard.ts';

export const COMPILER_MODEL = 'claude-opus-5';

export interface CompileSuccess {
  readonly source: 'model';
  readonly draft: CompiledDraft;
  /** The model that actually served the response (fallback-aware). */
  readonly model: string;
  /** The exact JSON text the model produced. */
  readonly raw: string;
  readonly promptVersion: string;
}

export interface CompileFallback {
  readonly source: 'stub';
  readonly draft: CompiledDraft;
  /** Why the live compile was unavailable — always shown to the operator. */
  readonly reason: string;
}

export type CompileResult = CompileSuccess | CompileFallback;

export interface CompileOptions {
  /** Injectable for tests; defaults to a client resolving ANTHROPIC_API_KEY from the environment. */
  readonly client?: Anthropic;
  /** Summarized reasoning, character by character, while the model works. */
  readonly onThinking?: (chunk: string) => void;
  /** The structured draft's own text, character by character. */
  readonly onText?: (chunk: string) => void;
}

export async function compilePolicy(
  policyText: string,
  options: CompileOptions = {},
): Promise<CompileResult> {
  const client = options.client ?? new Anthropic();

  let raw = '';
  let model: string;
  let stopReason: string | null;
  try {
    const stream = client.messages.stream({
      model: COMPILER_MODEL,
      max_tokens: 16_000,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: {
        effort: 'high',
        format: { type: 'json_schema', schema: DRAFT_JSON_SCHEMA },
      },
      system: COMPILER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: policyText }],
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'thinking_delta') options.onThinking?.(event.delta.thinking);
        else if (event.delta.type === 'text_delta') options.onText?.(event.delta.text);
      }
    }

    const finalMessage = await stream.finalMessage();
    model = finalMessage.model;
    stopReason = finalMessage.stop_reason;
    raw = finalMessage.content
      .filter((block): block is { type: 'text'; text: string } & typeof block => block.type === 'text')
      .map((block) => block.text)
      .join('');
  } catch (cause) {
    return {
      source: 'stub',
      draft: stubDraft(),
      reason: `API unavailable: ${(cause as Error).message}`,
    };
  }

  if (stopReason === 'refusal' || raw.length === 0) {
    return {
      source: 'stub',
      draft: stubDraft(),
      reason:
        stopReason === 'refusal'
          ? 'model declined the request (safety classifier) — no silent substitution; replay the cache'
          : `model returned no structured output (stop_reason: ${stopReason})`,
    };
  }

  // Fail closed from here: a model response that violates the validity guard
  // or the schema is refused, visibly. Never swallowed into a stub.
  try {
    const draft = parseCompiledDraft(raw);
    return { source: 'model', draft, model, raw, promptVersion: COMPILER_PROMPT_VERSION };
  } catch (cause) {
    if (cause instanceof CompilerRejection) throw cause;
    throw new CompilerRejection('schema', `unexpected validation failure: ${(cause as Error).message}`);
  }
}
