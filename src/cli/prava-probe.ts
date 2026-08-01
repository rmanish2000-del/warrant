/**
 * Prava sandbox shape probe — run BEFORE trusting any parser change.
 * Creates one throwaway session (it lapses unused in ~15 min), prints the
 * raw response STRUCTURE with sensitive values redacted, then polls the
 * payment result once to show the pre-passkey shape, and lists saved cards.
 *
 * Redaction is structural: every key matching the sensitive pattern has its
 * VALUE replaced by a length marker. Keys stay visible — the point is shape.
 * The secret key itself is read by Node's --env-file, passed only as a
 * header, and never printed.
 */
import process from 'node:process';

const BASE = 'https://sandbox.api.prava.space'; // api.prava.space is production — never call it
const SENSITIVE_KEY = /token|cvv|secret|key|iframe_url|card_number|masked/i;

const redact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) =>
        SENSITIVE_KEY.test(k) && typeof v === 'string'
          ? [k, `<redacted:${v.length} chars>`]
          : [k, redact(v)],
      ),
    );
  }
  return value;
};

const out = (text: string) => process.stdout.write(`${text}\n`);

const secretKey = process.env['PRAVA_SK'];
if (!secretKey) {
  out('PRAVA_SK is not set (checked env only — value never printed). Put it in .env and retry.');
  process.exit(1);
}
const headers = {
  'content-type': 'application/json',
  authorization: `Bearer ${secretKey}`,
};

const show = async (label: string, res: Response) => {
  const body: unknown = await res.json().catch(() => ({ unparseable: true }));
  out(`\n=== ${label} — HTTP ${res.status} ===`);
  out(JSON.stringify(redact(body), null, 2));
  return body as Record<string, unknown>;
};

const health = await fetch(`${BASE}/health`);
out(`health: HTTP ${health.status}`);

const cardsRes = await fetch(`${BASE}/v1/listCards?customer_id=test_user_1`, { headers });
await show('listCards (card_id values are references, safe)', cardsRes);

const createRes = await fetch(`${BASE}/v1/sessions`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    user_id: 'test_user_1',
    user_email: 'founder@aiworkspacehq.com',
    total_amount: '10.00',
    currency: 'INR',
    description: 'shape probe — will lapse unused',
    purchase_context: [
      {
        merchant_details: {
          name: 'PackRight Supplies',
          url: 'https://packright.example.com',
          country_code_iso2: 'IN',
        },
        product_details: [{ description: 'shape probe', unit_price: '10.00', quantity: 1 }],
      },
    ],
  }),
});
const created = await show('create session', createRes);

const sessionId = created['session_id'];
if (typeof sessionId === 'string') {
  const pollRes = await fetch(`${BASE}/v1/sessions/${sessionId}/payment-result`, { headers });
  await show('payment-result BEFORE any passkey (expect no token yet)', pollRes);
} else {
  out('\nno session_id in create response — see structure above');
}
