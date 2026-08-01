/**
 * Headless demo runner — the recording fallback and the flow's exerciser.
 * Runs the five canonical scenarios end to end without the browser, through
 * the same ConsoleFlow the server uses. Escalations are auto-approved and
 * SAID to be auto-approved by the harness — never displayed as a human act.
 * Exits non-zero if any outcome deviates from the canonical table.
 */
import process from 'node:process';
import { readCompileCache } from '../compiler/cache.ts';
import { stubDraft } from '../compiler/draft.ts';
import { canonicalAnswersFor, CANONICAL_PROPOSALS, ConsoleFlow, seedHistory } from '../console/flow.ts';
import { cumulativeAuthorized } from '../engine/evaluate.ts';

const out = (text: string) => process.stdout.write(`${text}\n`);

const flow = new ConsoleFlow({ provider: null, clock: () => Date.now() });

const cached = readCompileCache();
if (cached) {
  flow.adoptDraft(cached.result, cached.result.source === 'stub' ? 'stub' : 'cache', cached.compiledAt);
  out(`draft: cached compile from ${cached.compiledAt} (source: ${cached.result.source})`);
} else {
  flow.adoptDraft({ source: 'stub', draft: stubDraft(), reason: 'headless run, no cache' }, 'stub');
  out('draft: BUILT-IN FALLBACK (no cache present)');
}

flow.confirmWarrant(canonicalAnswersFor(flow.draft!));
out('warrant confirmed with canonical resolutions (deny / deny / cite C3)');
seedHistory(flow);
out(`seeded prior history through the enforcement boundary: ${cumulativeAuthorized(flow.log.ledger()).toLocaleString('en-IN')} authorized\n`);

let failures = 0;
for (const scenario of CANONICAL_PROPOSALS) {
  const record = flow.propose(scenario.supplier, scenario.amount);
  let approvalNote = '';
  if (record.verdict.decision === 'ESCALATE') {
    flow.approve(record.id, 'approved');
    approvalNote = ' · auto-approved (headless harness, not a human)';
  }
  const match = record.verdict.decision === scenario.expected;
  if (!match) failures += 1;
  const clause = record.verdict.clause ?? record.verdict.reason ?? 'none';
  out(
    `${match ? 'ok  ' : 'FAIL'} ${scenario.label}  ${scenario.supplier} ₹${scenario.amount.toLocaleString('en-IN')}` +
      `  → ${record.verdict.decision} (${clause})  expected ${scenario.expected}` +
      `  · prior ₹${record.evidence.cumulativeAuthorizedBefore.toLocaleString('en-IN')}${approvalNote}`,
  );
}

const total = cumulativeAuthorized(flow.log.ledger());
const chain = flow.log.verify();
out(`\ncumulative authorized: ₹${total.toLocaleString('en-IN')} (expected ₹14,000)`);
out(`record chain: ${chain.ok ? 'verified' : `FAILED at index ${chain.ok ? '' : chain.atIndex}`}`);
if (total !== 14_000) failures += 1;
if (!chain.ok) failures += 1;
process.exit(failures === 0 ? 0 : 1);
