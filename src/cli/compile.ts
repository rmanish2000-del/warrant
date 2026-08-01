/**
 * Demo compile CLI.
 *
 *   npm run demo:fresh — the ONE live compile per recording session. Calls
 *     the API, streams the model's actual output, writes the cache.
 *   npm run demo:reset — restores the exact cached compile for every retake.
 *     Never calls the API: a silent recompile would change the clause text
 *     and the remaining takes would no longer match.
 *
 * This file is the system boundary: the only place a clock or the process
 * environment is read. The key stays in the environment — never printed,
 * never logged.
 */
import process from 'node:process';
import { compilePolicy, COMPILER_MODEL } from '../compiler/compile.ts';
import type { CompileResult } from '../compiler/compile.ts';
import { CACHE_PATH, readCompileCache, writeCompileCache } from '../compiler/cache.ts';
import { CompilerRejection } from '../compiler/validityGuard.ts';

/** The demo policy, as given for this build (four sentences — spec §5 family). */
const DEMO_POLICY =
  "Buy only from approved suppliers. Don't exceed ₹15,000 per week. " +
  'Any order above ₹5,000 requires my approval. Never buy from a new supplier without approval.';

const out = (text: string) => process.stdout.write(text);

const banner = (lines: string[]) => {
  const width = Math.max(...lines.map((l) => l.length)) + 4;
  out(`\n${'='.repeat(width)}\n`);
  for (const line of lines) out(`  ${line}\n`);
  out(`${'='.repeat(width)}\n\n`);
};

const describeResult = (result: CompileResult, policyText: string, compiledAt: string) => {
  if (result.source === 'stub') {
    banner(['BUILT-IN FALLBACK — NOT A LIVE COMPILE', `reason: ${result.reason}`]);
  } else {
    out(`\nLive compile — served by ${result.model} (prompt v${result.promptVersion})\n`);
  }
  out(`compiled at: ${compiledAt}\n`);
  out(`policy: ${policyText}\n\n`);
  out('clauses:\n');
  for (const clause of result.draft.clauses) out(`  ${clause.id}  ${clause.text}\n`);
  out('\nambiguity flags (all must be resolved by the human before confirmation):\n');
  for (const flag of result.draft.flags) {
    out(`  [${flag.detectedBy}] ${flag.id} — ${flag.question}\n`);
    for (const option of flag.options) {
      out(`      (${option.key}) ${option.label}  → ${JSON.stringify(option.sets)}\n`);
    }
  }
  out('\n');
};

async function fresh(): Promise<number> {
  out(`Compiling via ${COMPILER_MODEL} — measured 24–30s at full effort; streaming live.\n\n`);
  let inDraft = false;
  let result: CompileResult;
  try {
    result = await compilePolicy(DEMO_POLICY, {
      onThinking: (chunk) => out(chunk),
      onText: (chunk) => {
        if (!inDraft) {
          inDraft = true;
          out('\n\n--- structured draft, streaming ---\n');
        }
        out(chunk);
      },
    });
  } catch (cause) {
    if (cause instanceof CompilerRejection) {
      banner([
        'COMPILE REFUSED — FAIL CLOSED',
        `stage: ${cause.stage}`,
        cause.message,
        'Nothing was cached. Fix and re-run demo:fresh.',
      ]);
      return 1;
    }
    throw cause;
  }
  out('\n');

  if (result.source === 'stub') {
    const existing = readCompileCache();
    if (existing && existing.result.source === 'model') {
      banner([
        'BUILT-IN FALLBACK — NOT A LIVE COMPILE',
        `reason: ${result.reason}`,
        `Kept the existing LIVE compile in ${CACHE_PATH} (not overwritten).`,
        'demo:reset still replays the live one.',
      ]);
      return 1;
    }
  }

  const compiledAt = new Date().toISOString();
  writeCompileCache({ policyText: DEMO_POLICY, result, compiledAt });
  describeResult(result, DEMO_POLICY, compiledAt);
  out(`cached to ${CACHE_PATH} — every retake now uses demo:reset.\n`);
  return result.source === 'stub' ? 1 : 0;
}

function reset(): number {
  const cached = readCompileCache();
  if (!cached) {
    out(
      `No cached compile at ${CACHE_PATH}.\n` +
        'Run "npm run demo:fresh" once (that is the take that films the compile);\n' +
        'every retake after it uses demo:reset.\n',
    );
    return 1;
  }
  out('Restored the exact cached compile — no API call was made.\n');
  describeResult(cached.result, cached.policyText, cached.compiledAt);
  return 0;
}

const mode = process.argv[2];
if (mode !== 'fresh' && mode !== 'reset') {
  out('usage: compile.ts <fresh|reset>\n');
  process.exit(2);
}
process.exit(mode === 'fresh' ? await fresh() : reset());
