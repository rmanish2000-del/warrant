import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PravaSandboxProvider, ProviderError, PRAVA_SANDBOX_BASE_URL } from './prava.ts';

/** Captures every request; replies from a scripted queue. */
const fakeFetch = (replies: { status: number; body: unknown }[]) => {
  const requests: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const reply = replies.shift() ?? { status: 500, body: { error: { message: 'queue empty' } } };
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  return { impl, requests };
};

const provider = (fetchImpl: typeof fetch, cardId: string | null = 'card_test_ref') =>
  new PravaSandboxProvider({ secretKey: 'unit-test-secret', userEmail: 'unit-test-user', cardId, fetchImpl });

const CREATED = {
  session_id: 'ses_01TEST',
  session_token: 'should-never-survive',
  iframe_url: 'https://sandbox.collect.prava.space?session=opaque',
  order_id: 'ord_01TEST',
  expires_at: '2026-08-01T12:00:00.000Z',
};

describe('createSession', () => {
  it('targets the sandbox host, sends verified field names, and returns only the allowlisted trio', async () => {
    const { impl, requests } = fakeFetch([{ status: 201, body: CREATED }]);
    const session = await provider(impl).createSession({
      supplier: 'PackRight Supplies',
      amount: 6_200,
      currency: 'INR',
      description: 'packaging reorder',
    });

    const req = requests[0]!;
    assert.equal(req.url, `${PRAVA_SANDBOX_BASE_URL}/v1/sessions`);
    assert.ok(!req.url.includes('//api.prava.space'), 'must never target production');
    assert.equal(req.method, 'POST');

    const body = req.body as Record<string, unknown>;
    assert.equal(body['total_amount'], '6200.00'); // string, not number; total_amount, not amount
    assert.equal(body['currency'], 'INR');
    assert.deepEqual(body['card'], { card_id: 'card_test_ref' });
    const context = (body['purchase_context'] as Record<string, unknown>[])[0]!;
    const merchant = context['merchant_details'] as Record<string, unknown>;
    // The DESTINATION merchant — the supplier, never this app's name.
    assert.equal(merchant['name'], 'PackRight Supplies');
    assert.equal(merchant['country_code_iso2'], 'IN');
    const product = (context['product_details'] as Record<string, unknown>[])[0]!;
    assert.equal(product['unit_price'], '6200.00'); // unit_price, not amount

    assert.deepEqual(session, {
      sessionRef: 'ses_01TEST', // from session_id — there is no `id` field
      iframeUrl: CREATED.iframe_url,
      expiresAtIso: CREATED.expires_at, // the server's expiry, not a computed 15 minutes
    });
    assert.ok(!JSON.stringify(session).includes('should-never-survive'), 'session_token must be dropped');
  });

  it('omits the card block when no card is configured', async () => {
    const { impl, requests } = fakeFetch([{ status: 201, body: CREATED }]);
    await provider(impl, null).createSession({ supplier: 'X', amount: 10, currency: 'INR', description: 'd' });
    assert.ok(!('card' in (requests[0]!.body as Record<string, unknown>)));
  });

  it('sends callback_url only when configured, so the provider page can return to Warrant', async () => {
    const { impl, requests } = fakeFetch([{ status: 201, body: CREATED }]);
    const withCallback = new PravaSandboxProvider({
      secretKey: 'unit-test-secret',
      userEmail: 'unit-test-user',
      cardId: null,
      callbackUrl: 'https://demo.example/warrant/console',
      fetchImpl: impl,
    });
    await withCallback.createSession({ supplier: 'X', amount: 10, currency: 'INR', description: 'd' });
    assert.equal((requests[0]!.body as Record<string, unknown>)['callback_url'], 'https://demo.example/warrant/console');

    const { impl: impl2, requests: requests2 } = fakeFetch([{ status: 201, body: CREATED }]);
    await provider(impl2, null).createSession({ supplier: 'X', amount: 10, currency: 'INR', description: 'd' });
    assert.ok(!('callback_url' in (requests2[0]!.body as Record<string, unknown>)));
  });

  it('surfaces the provider error message and code on non-2xx, never the key', async () => {
    const { impl } = fakeFetch([
      { status: 400, body: { error: { code: 'VAL_2001', message: 'Invalid request body' } } },
    ]);
    await assert.rejects(
      provider(impl).createSession({ supplier: 'X', amount: 10, currency: 'INR', description: 'd' }),
      (err: unknown) =>
        err instanceof ProviderError &&
        err.status === 400 &&
        err.code === 'VAL_2001' &&
        !err.message.includes('unit-test-secret'),
    );
  });
});

describe('pollResult — readiness is token EXISTENCE, never status === "completed"', () => {
  const pollUrl = (requests: { url: string }[]) => requests[0]!.url;

  it('pre-passkey shape: status pending with EMPTY transactions array → pending', async () => {
    const { impl, requests } = fakeFetch([
      { status: 200, body: { session_id: 'ses_01TEST', status: 'pending', transactions: [] } },
    ]);
    assert.deepEqual(await provider(impl).pollResult('ses_01TEST'), { kind: 'pending' });
    assert.equal(pollUrl(requests), `${PRAVA_SANDBOX_BASE_URL}/v1/sessions/ses_01TEST/payment-result`);
  });

  it('THE TRAP: credential present while status is still "awaiting_result" → ready', async () => {
    const { impl } = fakeFetch([
      {
        status: 200,
        body: {
          status: 'awaiting_result', // never becomes "completed" — do not wait for it
          transactions: [
            {
              status: 'awaiting_result',
              line_items: [
                {
                  txn_ref_id: 'tli_01TEST',
                  status: 'credentials_generated',
                  token: 'synthetic-token-value-not-a-pan',
                  dynamic_cvv: '000',
                  expiry_month: '12',
                  expiry_year: '2027',
                },
              ],
            },
          ],
        },
      },
    ]);
    const outcome = await provider(impl).pollResult('ses_01TEST');
    assert.deepEqual(outcome, { kind: 'ready', txnRefId: 'tli_01TEST' });
    // The credential values must not cross the port — not even as extra fields.
    const serialized = JSON.stringify(outcome);
    assert.ok(!serialized.includes('synthetic-token-value-not-a-pan'));
    assert.ok(!serialized.includes('dynamic_cvv'));
  });

  it('line item without a token yet → pending, regardless of any status words', async () => {
    const { impl } = fakeFetch([
      {
        status: 200,
        body: {
          status: 'awaiting_result',
          transactions: [{ status: 'awaiting_result', line_items: [{ txn_ref_id: 'tli_x', token: null }] }],
        },
      },
    ]);
    assert.deepEqual(await provider(impl).pollResult('s'), { kind: 'pending' });
  });

  it('failed status maps to a failed outcome with the provider message', async () => {
    const { impl } = fakeFetch([
      {
        status: 200,
        body: {
          status: 'failed',
          transactions: [{ status: 'failed', error: { code: 'X', message: 'card verification unsuccessful' }, line_items: [] }],
        },
      },
    ]);
    assert.deepEqual(await provider(impl).pollResult('s'), {
      kind: 'failed',
      message: 'card verification unsuccessful',
    });
  });
});

describe('reportApproved — mandatory confirmation call', () => {
  it('posts txn_ref_id + APPROVED and returns visa_confirmation verbatim', async () => {
    const { impl, requests } = fakeFetch([
      {
        status: 200,
        body: { status: 'confirmed', txn_ref_id: 'tli_01TEST', txn_status: 'APPROVED', visa_confirmation: 'SUCCESS' },
      },
    ]);
    const result = await provider(impl).reportApproved('ses_01TEST', 'tli_01TEST');
    assert.deepEqual(result, { visaConfirmation: 'SUCCESS' });
    const req = requests[0]!;
    assert.equal(req.url, `${PRAVA_SANDBOX_BASE_URL}/v1/sessions/ses_01TEST/report-status`);
    assert.deepEqual(req.body, { txn_ref_id: 'tli_01TEST', txn_status: 'APPROVED' });
  });
});

describe('discoverDefaultCardId', () => {
  it('prefers the default card', async () => {
    const { impl } = fakeFetch([
      {
        status: 200,
        body: {
          cards: [
            { card_id: 'card_a', status: 'active', is_default: false },
            { card_id: 'card_b', status: 'active', is_default: true },
          ],
          count: 2,
        },
      },
    ]);
    assert.equal(await provider(impl).discoverDefaultCardId(), 'card_b');
  });
});
