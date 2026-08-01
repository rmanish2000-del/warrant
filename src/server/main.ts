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
import { stateView } from './view.ts';

const PORT = Number(process.env['PORT'] ?? 3000);
const PUBLIC_DIR = join(process.cwd(), 'public');

/**
 * Payment leg attachment — the ONLY place the secret key is read, and it goes
 * nowhere but the provider's Authorization header. `--nopay` (npm run
 * demo:nopay) is the on-camera fallback: same console, payment leg off, DENY
 * and the whole record path unaffected.
 */
const noPay = process.argv.includes('--nopay');
const secretKey = process.env['PRAVA_SK'];
let provider = null as import('../console/flow.ts').ProviderPort | null;
let paymentLeg = 'not configured';
if (noPay) {
  paymentLeg = 'off (--nopay)';
  process.stdout.write('payment leg: OFF (--nopay) — refusals, approvals, and the record run without it\n');
} else if (secretKey) {
  let prava = new PravaSandboxProvider({ secretKey, cardId: process.env['PRAVA_CARD_ID'] ?? null });
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

const flow = new ConsoleFlow({ provider, clock: () => Date.now() });

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
