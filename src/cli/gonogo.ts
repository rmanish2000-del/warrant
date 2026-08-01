/**
 * Hour-32 Go/No-Go probe — one self-contained data point for the Prava
 * decision. Boots no server. Creates exactly ONE INR sandbox session through
 * the REAL escalation path (evaluate → ESCALATE C3 → recorded approval →
 * enforcement gate → createSession), waits at most 10 seconds, prints a
 * one-line verdict, exits. Never attempts the passkey step.
 *
 * Never touches the compile cache: the warrant comes from the built-in stub
 * draft (identical canonical constraints), so a gonogo run can never desync
 * the filmed compile.
 *
 * Verdicts (exit codes): GO 0 · DEGRADED 2 · NO-GO 1.
 */
import process from 'node:process';
import { stubDraft } from '../compiler/draft.ts';
import { canonicalAnswersFor, ConsoleFlow } from '../console/flow.ts';
import type { ProviderPort } from '../console/flow.ts';
import { PravaSandboxProvider } from '../provider/prava.ts';

const out = (text: string) => process.stdout.write(`${text}\n`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const finish = (verdict: 'GO' | 'DEGRADED' | 'NO-GO', detail: string): never => {
  out(`VERDICT: ${verdict} — ${detail}`);
  process.exit(verdict === 'GO' ? 0 : verdict === 'DEGRADED' ? 2 : 1);
};

const secretKey = process.env['PRAVA_SK'];
const userEmail = process.env['PRAVA_USER_EMAIL'];
if (!secretKey || !userEmail) {
  out(`attach: FAILED — ${!secretKey ? 'PRAVA_SK' : 'PRAVA_USER_EMAIL'} not set (values never printed)`);
  finish('NO-GO', 'payment leg cannot attach: missing environment variable');
}

/** Every provider error is recorded verbatim; one error does not end the probe. */
const providerErrors: string[] = [];
const record = (cause: unknown): never => {
  providerErrors.push((cause as Error).message);
  throw cause;
};

let prava = new PravaSandboxProvider({ secretKey: secretKey!, userEmail: userEmail! });
let cardId: string | null = process.env['PRAVA_CARD_ID'] ?? null;
if (!cardId) {
  try {
    cardId = await prava.discoverDefaultCardId();
  } catch (cause) {
    providerErrors.push(`card discovery: ${(cause as Error).message}`);
  }
}
if (cardId) {
  prava = prava.withCard(cardId);
  out(`attach: OK — saved card pre-selected (${cardId})`);
} else {
  out('attach: PARTIAL — no saved card (enrollment ~193s would happen on camera)');
}

const recordingPort: ProviderPort = {
  createSession: (args) => prava.createSession(args).catch(record),
  pollResult: (ref) => prava.pollResult(ref).catch(record),
  reportApproved: (ref, txn) => prava.reportApproved(ref, txn).catch(record),
};

// pollIntervalMs far beyond the probe's lifetime: the background watcher
// never fires inside the 10s window — session creation is the only call.
const flow = new ConsoleFlow({ provider: recordingPort, clock: () => Date.now(), pollIntervalMs: 60_000 });
flow.adoptDraft({ source: 'stub', draft: stubDraft(), reason: 'gonogo probe — cache untouched' }, 'stub');
flow.confirmWarrant(canonicalAnswersFor(stubDraft()));

const decision = flow.propose('PackRight Supplies', 6_200);
if (decision.verdict.decision !== 'ESCALATE') {
  finish('NO-GO', `expected ESCALATE C3, evaluator said ${decision.verdict.decision} — do not touch the sandbox until that is understood`);
}
flow.approve(decision.id, 'approved');

const deadline = Date.now() + 10_000;
let stateReached = 'requested';
let sessionRef: string | null = null;
while (Date.now() < deadline) {
  await sleep(250);
  const payment = flow.paymentFor(decision.id);
  if (payment) {
    stateReached = payment.status;
    sessionRef = payment.sessionRef;
    if (payment.status !== 'requested') break;
  }
}

out(`state reached: ${stateReached}${sessionRef ? ` · session ${sessionRef}` : ''}`);
if (providerErrors.length > 0) out(`provider errors seen: ${providerErrors.join(' | ')}`);

if (stateReached === 'awaiting_verification' && providerErrors.length === 0) {
  finish('GO', `session ${sessionRef} created cleanly; left unopened (no passkey), lapses on the provider's clock`);
} else if (stateReached === 'awaiting_verification') {
  finish('DEGRADED', `session created but provider errors were seen — run the full T-time rehearsal before recording`);
} else {
  finish('NO-GO', `session did not reach awaiting_verification (state: ${stateReached}) — record with demo:nopay`);
}
