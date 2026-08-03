/**
 * Minimal HTTP server — plumbing, not the product. Node's built-in `http`,
 * zero dependencies. All state lives in ConsoleFlow instances.
 *
 * Two modes, one binary:
 *
 * LOCAL (default) — binds 127.0.0.1, one process-global flow, live compile
 * allowed. This is the recording surface; its behavior is unchanged.
 *
 * PUBLIC DEMO (`--public-demo` or WARRANT_PUBLIC_DEMO=1) — binds 0.0.0.0 for
 * platform routing, and:
 *   · per-visitor isolation: each visitor (random 128-bit HttpOnly cookie)
 *     gets their own ConsoleFlow — warrant, ledger, records, payment state.
 *     Ids carry no data, so no signature is needed; possession is the session.
 *   · payment rate limiting: session creation capped per visitor per hour and
 *     site-wide per UTC day (the sandbox card is the founder's, 30 txns/day).
 *     A blocked approval still records normally; only the sandbox leg is
 *     withheld, with one plain sentence in the payment slot.
 *   · live compile disabled: cached replay only. No visitor spends Anthropic
 *     credits, and the cache file is never writable from the network.
 *   · the compile cache may come from the WARRANT_COMPILE_CACHE_JSON env var
 *     (platforms deploy from git; the cache file is deliberately gitignored).
 *   · a visitor may reset THEIR run (fresh flow, same cookie — limiter budget
 *     survives). Public-only: the recording console keeps no reset control.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { compilePolicy } from '../compiler/compile.ts';
import { readCompileCache, writeCompileCache, CACHE_PATH } from '../compiler/cache.ts';
import type { CachedCompile } from '../compiler/cache.ts';
import { ConfirmationError } from '../compiler/confirm.ts';
import { CompilerRejection } from '../compiler/validityGuard.ts';
import { ConsoleFlow, seedHistory } from '../console/flow.ts';
import { PravaSandboxProvider } from '../provider/prava.ts';
import { EnforcementError } from '../records/append.ts';
import { exportView, stateView } from './view.ts';
import { isVisitorId, newVisitorId, SessionRateLimiter, VisitorStore } from './tenancy.ts';

const portArg = process.argv.find((a) => a.startsWith('--port='));
const PORT = Number(portArg?.slice('--port='.length) ?? process.env['PORT'] ?? 3000);
const PUBLIC_DIR = join(process.cwd(), 'public');

const publicDemo = process.argv.includes('--public-demo') || process.env['WARRANT_PUBLIC_DEMO'] === '1';

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
if (publicDemo && freezeClock) {
  process.stderr.write('refusing to start: --freeze-clock is a recording tool and cannot combine with --public-demo\n');
  process.exit(1);
}
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
    // Public deploys set this to the console's own HTTPS URL so the
    // provider's page returns the visitor to Warrant after completion.
    callbackUrl: process.env['WARRANT_CALLBACK_URL'] ?? null,
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

/**
 * Compile cache lookup: the local file first, then the env var used by the
 * public deployment (the file is gitignored and platforms deploy from git).
 * The env cache is parsed once and never written back anywhere.
 */
const envCacheRaw = process.env['WARRANT_COMPILE_CACHE_JSON'] ?? null;
let envCache: CachedCompile | null = null;
if (envCacheRaw) {
  const parsed = JSON.parse(envCacheRaw) as CachedCompile;
  if (!parsed?.result?.draft || !parsed.result.source) {
    process.stderr.write('refusing to start: WARRANT_COMPILE_CACHE_JSON is set but is not a compile cache\n');
    process.exit(1);
  }
  envCache = parsed;
}
const loadCache = (): CachedCompile | null => readCompileCache() ?? envCache;

const RATE_LIMIT_SENTENCE = 'demo payment limit reached for today — see the video for the full flow';
const limiter = new SessionRateLimiter({ perVisitorPerHour: 3, siteWidePerDay: 20 });

/** Everything one visitor owns. Local mode has exactly one, cookie-less. */
interface Visitor {
  flow: ConsoleFlow;
  /** decisionId → rate-limit sentence for approvals whose payment leg was withheld. */
  notices: Map<string, string>;
}
const newVisitor = (): Visitor => ({ flow: new ConsoleFlow({ provider, clock }), notices: new Map() });

const visitors = new VisitorStore<Visitor>({ maxVisitors: 300, idleTtlMs: 2 * 3_600_000 });
const localVisitor: Visitor = newVisitor();
if (publicDemo) {
  const sweeper = setInterval(() => visitors.sweep(clock()), 5 * 60_000);
  sweeper.unref();
}

const COOKIE_NAME = 'warrant_sid';
const readCookie = (req: IncomingMessage): string | null => {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) {
      const value = part.slice(eq + 1).trim();
      return isVisitorId(value) ? value : null;
    }
  }
  return null;
};

/** Resolve (or mint) the visitor for this request. Local mode: the singleton. */
const resolveVisitor = (req: IncomingMessage, res: ServerResponse): { id: string; visitor: Visitor } => {
  if (!publicDemo) return { id: 'local', visitor: localVisitor };
  const now = clock();
  const fromCookie = readCookie(req);
  if (fromCookie) {
    const existing = visitors.get(fromCookie, now);
    if (existing) return { id: fromCookie, visitor: existing };
  }
  const id = fromCookie ?? newVisitorId();
  const visitor = newVisitor();
  visitors.set(id, visitor, now);
  // HttpOnly: the id never reaches page JS. SameSite=Lax: no cross-site POSTs.
  res.setHeader('set-cookie', `${COOKIE_NAME}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${2 * 3600}`);
  return { id, visitor };
};

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const state = (v: Visitor) =>
  stateView(v.flow, loadCache() !== null, paymentLeg, {
    publicDemo,
    noticeFor: (decisionId) => v.notices.get(decisionId) ?? null,
  });

const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length === 0) return {};
  return JSON.parse(text) as Record<string, unknown>;
};

const handleCompile = async (req: IncomingMessage, res: ServerResponse, v: Visitor) => {
  const body = await readBody(req);
  const mode = body['mode'];

  if (mode === 'cache') {
    const cached = loadCache();
    if (!cached) return json(res, 404, { error: `no cached compile at ${CACHE_PATH} — run a live compile once` });
    v.flow.adoptDraft(cached.result, cached.result.source === 'stub' ? 'stub' : 'cache', cached.compiledAt);
    return json(res, 200, state(v));
  }

  if (publicDemo) {
    // No visitor spends Anthropic credits, and the cache is never overwritten
    // from the network. The cached replay above is the only compile path.
    return json(res, 403, { error: 'live compile is disabled on the public demo — use the cached compile' });
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
    v.flow.adoptDraft(result, result.source === 'model' ? 'live' : 'stub', compiledAt);
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

type Route = (req: IncomingMessage, res: ServerResponse, id: string, v: Visitor) => Promise<unknown> | unknown;

const routes: Record<string, Route> = {
  'GET /api/state': (_req, res, _id, v) => json(res, 200, state(v)),

  // The authorization record as a self-contained JSON document (AR-05).
  // Pretty-printed so a browser tab is a readable view of the export.
  'GET /api/export': (_req, res, _id, v) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    // The flow clock, so frozen-clock runs export byte-identically too.
    res.end(JSON.stringify(exportView(v.flow, new Date(clock()).toISOString()), null, 2));
  },

  'POST /api/compile': (req, res, _id, v) => handleCompile(req, res, v),

  'POST /api/confirm': async (req, res, _id, v) => {
    const body = await readBody(req);
    const answers = (body['answers'] ?? {}) as Record<string, string>;
    v.flow.confirmWarrant(answers);
    json(res, 200, state(v));
  },

  'POST /api/seed': (_req, res, _id, v) => {
    if (v.flow.log.records.length > 0) return json(res, 409, { error: 'history already seeded' });
    seedHistory(v.flow);
    json(res, 200, state(v));
  },

  'POST /api/propose': async (req, res, _id, v) => {
    const body = await readBody(req);
    const supplier = body['supplier'];
    const amount = body['amount'];
    if (typeof supplier !== 'string' || typeof amount !== 'number') {
      return json(res, 400, { error: 'supplier (string) and amount (number) are required' });
    }
    const record = v.flow.propose(supplier, amount);
    json(res, 200, { decisionId: record.id, state: state(v) });
  },

  'POST /api/approve': async (req, res, id, v) => {
    const body = await readBody(req);
    const decisionId = body['decisionId'];
    const outcome = body['outcome'];
    if (typeof decisionId !== 'string' || (outcome !== 'approved' && outcome !== 'rejected')) {
      return json(res, 400, { error: 'decisionId and outcome (approved|rejected) are required' });
    }
    // The rate limiter guards SESSION CREATION only. The approval itself —
    // the human authority event — always records normally; a blocked leg
    // changes what executes, never what was decided.
    if (publicDemo && outcome === 'approved' && provider) {
      const decision = limiter.tryAcquire(id, clock());
      if (!decision.allowed) {
        v.flow.approve(decisionId, outcome, { startPayment: false });
        v.notices.set(decisionId, RATE_LIMIT_SENTENCE);
        return json(res, 200, state(v));
      }
    }
    v.flow.approve(decisionId, outcome);
    json(res, 200, state(v));
  },

  // Public-only: a visitor restarts THEIR demo run. Fresh flow, same cookie —
  // the rate limiter's budget deliberately survives. The recording console
  // has no reset control (decided; misclick risk on camera), and this route
  // does not exist there.
  'POST /api/reset-demo': (_req, res, id, v) => {
    if (!publicDemo) return json(res, 404, { error: 'no route POST /api/reset-demo' });
    const fresh = newVisitor();
    visitors.set(id, fresh, clock());
    void v; // the old flow drops out of the store; any live watcher self-terminates on session expiry
    json(res, 200, state(fresh));
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
      const { id, visitor } = resolveVisitor(req, res);
      await route(req, res, id, visitor);
    } else if (req.method === 'GET') {
      if (url.pathname === '/' ) resolveVisitor(req, res); // set the cookie with the page
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

const host = publicDemo ? '0.0.0.0' : '127.0.0.1';
server.listen(PORT, host, () => {
  process.stdout.write(
    publicDemo
      ? `Warrant public demo: listening on ${host}:${PORT} · per-visitor isolation on · payment sessions rate limited (3/visitor/hour, 20/site/day) · live compile OFF\n`
      : `Warrant console: http://127.0.0.1:${PORT}\n`,
  );
});
