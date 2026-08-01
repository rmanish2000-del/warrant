/**
 * Minimal local HTTP server — plumbing, not the product. Node's built-in
 * `http`, zero dependencies, binds 127.0.0.1 only. Serves the console page
 * and the few endpoints it calls; all state lives in the ConsoleFlow.
 *
 * `npm start` once before recording; everything after that is clicks and
 * typing in one browser window.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { compilePolicy } from '../compiler/compile.ts';
import { readCompileCache, writeCompileCache, CACHE_PATH } from '../compiler/cache.ts';
import { ConfirmationError } from '../compiler/confirm.ts';
import { CompilerRejection } from '../compiler/validityGuard.ts';
import { ConsoleFlow, seedHistory } from '../console/flow.ts';
import { PravaSandboxProvider } from '../provider/prava.ts';
import { EnforcementError } from '../records/append.ts';
import { exportView, stateView } from './view.ts';

const PORT = Number(process.env['PORT'] ?? 3000);
const PUBLIC_DIR = join(process.cwd(), 'public');

/**
 * Payment leg attachment — the ONLY place the secret key is read, and it goes
 * nowhere but the provider's Authorization header. `--skip-payment` (npm run
 * demo:nopay) is the on-camera fallback: same console, payment leg off, DENY
 * and the whole record path unaffected. The flag is deliberately NOT named
 * `--no-payment`: npm eats any `--no-*` argument as its own config negation,
 * so it would never reach this script and would look like a broken flag.
 *
 * `--freeze-clock` makes the run deterministic: a fixed epoch advanced 1s per
 * read, so identical click sequences produce byte-identical state and export
 * between runs (used by demo:nopay). With real payments everything matches
 * except session ids, which necessarily differ — honest, not fixable.
 */
const noPay = process.argv.includes('--skip-payment');
const freezeClock = process.argv.includes('--freeze-clock');
const FROZEN_EPOCH = Date.UTC(2026, 7, 2, 9, 0, 0); // 2 Aug 2026 09:00Z — plausible on camera
let frozenTick = 0;
const clock = freezeClock ? () => FROZEN_EPOCH + ++frozenTick * 1000 : () => Date.now();
const secretKey = process.env['PRAVA_SK'];
const sandboxUserEmail = process.env['PRAVA_USER_EMAIL'];
let provider = null as import('../console/flow.ts').ProviderPort | null;
let paymentLeg = 'not configured';
if (noPay) {
  paymentLeg = 'off (payment skipped)';
  process.stdout.write(
    `payment leg: OFF (--skip-payment) — refusals, approvals, and the record run without it${freezeClock ? ' · clock frozen for byte-identical runs' : ''}\n`,
  );
} else if (secretKey && !sandboxUserEmail) {
  process.stdout.write(
    'payment leg: NOT attached — PRAVA_USER_EMAIL missing (set it in .env to the email your sandbox account uses)\n',
  );
} else if (secretKey && sandboxUserEmail) {
  let prava = new PravaSandboxProvider({
    secretKey,
    userEmail: sandboxUserEmail,
    cardId: process.env['PRAVA_CARD_ID'] ?? null,
  });
  try {
    const cardId = process.env['PRAVA_CARD_ID'] ?? (await prava.discoverDefaultCardId());
    if (cardId) {
      prava = prava.withCard(cardId);
      process.stdout.write(`payment leg: Prava sandbox attached · saved card pre-selected (${cardId})\n`);
    } else {
      process.stdout.write(
        'payment leg: Prava sandbox attached · NO saved card — enrollment (~193s) would happen on camera\n',
      );
    }
    provider = prava;
    paymentLeg = 'attached (Prava sandbox)';
  } catch (cause) {
    process.stdout.write(`payment leg: NOT attached — ${(cause as Error).message}\n`);
    paymentLeg = 'not configured';
  }
} else {
  process.stdout.write('payment leg: not configured (PRAVA_SK missing) — refusals and records unaffected\n');
}

const flow = new ConsoleFlow({ provider, clock });

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const state = () => stateView(flow, readCompileCache() !== null, paymentLeg);

const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length === 0) return {};
  return JSON.parse(text) as Record<string, unknown>;
};

const handleCompile = async (req: IncomingMessage, res: ServerResponse) => {
  const body = await readBody(req);
  const mode = body['mode'];

  if (mode === 'cache') {
    const cached = readCompileCache();
    if (!cached) return json(res, 404, { error: `no cached compile at ${CACHE_PATH} — run a live compile once` });
    flow.adoptDraft(cached.result, cached.result.source === 'stub' ? 'stub' : 'cache', cached.compiledAt);
    return json(res, 200, state());
  }

  const policyText = typeof body['policy'] === 'string' && body['policy'].trim().length > 0
    ? body['policy']
    : null;
  if (!policyText) return json(res, 400, { error: 'policy text is required' });

  // NDJSON stream: the browser renders the model's actual output as it arrives.
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
  const line = (payload: unknown) => res.write(`${JSON.stringify(payload)}\n`);
  try {
    const result = await compilePolicy(policyText, {
      onThinking: (chunk) => line({ kind: 'thinking', chunk }),
      onText: (chunk) => line({ kind: 'text', chunk }),
    });
    const compiledAt = new Date().toISOString();
    flow.adoptDraft(result, result.source === 'model' ? 'live' : 'stub', compiledAt);
    const existing = readCompileCache();
    if (result.source === 'stub' && existing?.result.source === 'model') {
      line({ kind: 'result', source: 'stub', keptExistingCache: true });
    } else {
      writeCompileCache({ policyText, result, compiledAt });
      line({ kind: 'result', source: result.source, keptExistingCache: false });
    }
  } catch (cause) {
    if (cause instanceof CompilerRejection) {
      line({ kind: 'error', stage: cause.stage, message: cause.message });
    } else {
      line({ kind: 'error', stage: 'unknown', message: (cause as Error).message });
    }
  }
  res.end();
};

const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<unknown> | unknown> = {
  'GET /api/state': (_req, res) => json(res, 200, state()),

  // The authorization record as a self-contained JSON document (AR-05).
  // Pretty-printed so a browser tab is a readable view of the export.
  'GET /api/export': (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    // The flow clock, so frozen-clock runs export byte-identically too.
    res.end(JSON.stringify(exportView(flow, new Date(clock()).toISOString()), null, 2));
  },

  'POST /api/compile': handleCompile,

  'POST /api/confirm': async (req, res) => {
    const body = await readBody(req);
    const answers = (body['answers'] ?? {}) as Record<string, string>;
    flow.confirmWarrant(answers);
    json(res, 200, state());
  },

  'POST /api/seed': (_req, res) => {
    if (flow.log.records.length > 0) return json(res, 409, { error: 'history already seeded' });
    seedHistory(flow);
    json(res, 200, state());
  },

  'POST /api/propose': async (req, res) => {
    const body = await readBody(req);
    const supplier = body['supplier'];
    const amount = body['amount'];
    if (typeof supplier !== 'string' || typeof amount !== 'number') {
      return json(res, 400, { error: 'supplier (string) and amount (number) are required' });
    }
    const record = flow.propose(supplier, amount);
    json(res, 200, { decisionId: record.id, state: state() });
  },

  'POST /api/approve': async (req, res) => {
    const body = await readBody(req);
    const decisionId = body['decisionId'];
    const outcome = body['outcome'];
    if (typeof decisionId !== 'string' || (outcome !== 'approved' && outcome !== 'rejected')) {
      return json(res, 400, { error: 'decisionId and outcome (approved|rejected) are required' });
    }
    flow.approve(decisionId, outcome);
    json(res, 200, state());
  },
};

const serveStatic = async (res: ServerResponse, requestPath: string) => {
  const relative = requestPath === '/' ? 'index.html' : requestPath.replaceAll('..', '').replace(/^\/+/, '');
  try {
    const content = await readFile(join(PUBLIC_DIR, relative));
    const type = relative.endsWith('.html')
      ? 'text/html; charset=utf-8'
      : relative.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : relative.endsWith('.js') || relative.endsWith('.mjs')
          ? 'text/javascript; charset=utf-8'
          : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const key = `${req.method} ${url.pathname}`;
  try {
    const route = routes[key];
    if (route) {
      await route(req, res);
    } else if (req.method === 'GET') {
      await serveStatic(res, url.pathname);
    } else {
      json(res, 404, { error: `no route ${key}` });
    }
  } catch (cause) {
    if (cause instanceof ConfirmationError) return json(res, 400, { error: cause.message, kind: cause.kind });
    if (cause instanceof EnforcementError) return json(res, 409, { error: cause.message, kind: cause.kind });
    json(res, 500, { error: (cause as Error).message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`Warrant console: http://127.0.0.1:${PORT}\n`);
});
