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

/**
 * The demo policy — four sentences. Sentence one NAMES the supplier on
 * purpose: a live compile correctly refused to invent one and produced an
 * empty allowlist, which made scenario A deny on C1. See CLAUDE.md
 * "Canonical demo data". Do not shorten it back.
 */
const DEMO_POLICY =
  "Buy only from approved suppliers — PackRight Supplies. Don't exceed ₹15,000 per week. " +
  'Any order above ₹5,000 requires my approval. Never buy from a new supplier without approval.';

const out = (text: string) => process.stdout.write(text);

/**
 * ANSI colours so live vs cached vs refused is unmissable on the terminal —
 * the same rule as the page badge: no two states may look alike at a glance.
 */
const COLOR = { green: '\x1b[1;32m', cyan: '\x1b[1;36m', red: '\x1b[1;31m', amber: '\x1b[1;33m', off: '\x1b[0m' };

const banner = (color: string, lines: string[]) => {
  const width = Math.max(...lines.map((l) => l.length)) + 4;
  out(`\n${color}${'='.repeat(width)}\n`);
  for (const line of lines) out(`  ${line}\n`);
  out(`${'='.repeat(width)}${COLOR.off}\n\n`);
};

const describeResult = (
  result: CompileResult,
  policyText: string,
  compiledAt: string,
  mode: 'live' | 'replay',
) => {
  if (result.source === 'stub') {
    banner(COLOR.amber, ['BUILT-IN FALLBACK — NOT A LIVE COMPILE', `reason: ${result.reason}`]);
  } else if (mode === 'live') {
    banner(COLOR.green, [`LIVE COMPILE — served by ${result.model} (prompt v${result.promptVersion})`]);
  } else {
    // Replay of a live compile: NO green banner — the cyan banner above is
    // the only one on screen. Green means "streamed just now", nothing else.
    out(`source model: ${result.model} (prompt v${result.promptVersion}) — replayed from cache\n`);
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
      banner(COLOR.red, [
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
      banner(COLOR.amber, [
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
  describeResult(result, DEMO_POLICY, compiledAt, 'live');
  out(`cached to ${CACHE_PATH} — every retake now uses demo:reset.\n`);
  return result.source === 'stub' ? 1 : 0;
}

function reset(): number {
  const cached = readCompileCache();
  if (!cached) {
    // 🔴 REFUSE — never silently recompile. Wording and flag ordering vary
    // between compiles; a silent recompile mid-session desyncs every take
    // shot after it. Exit fast; existing page/state untouched.
    banner(COLOR.red, [
      'REFUSED — NO CACHED COMPILE',
      `${CACHE_PATH} does not exist. demo:reset NEVER compiles.`,
      'Run "npm run demo:fresh" once (that is the take that films the compile);',
      'every retake after it uses demo:reset. Existing page state is untouched.',
    ]);
    return 1;
  }
  if (cached.result.source === 'stub') {
    banner(COLOR.amber, ['CACHED REPLAY OF A FALLBACK — the cache holds a stub, not a live compile']);
  } else {
    banner(COLOR.cyan, [
      `CACHED REPLAY — compiled ${cached.compiledAt}`,
      'No API call was made. The stale timestamp is the tell.',
    ]);
  }
  describeResult(cached.result, cached.policyText, cached.compiledAt, 'replay');
  return 0;
}

const mode = process.argv[2];
if (mode !== 'fresh' && mode !== 'reset') {
  out('usage: compile.ts <fresh|reset>\n');
  process.exit(2);
}
process.exit(mode === 'fresh' ? await fresh() : reset());
