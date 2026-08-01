/**
 * Prava sandbox provider — the ProviderPort implementation.
 *
 * SANDBOX ONLY. The base URL is pinned to sandbox.api.prava.space;
 * api.prava.space is production and must never be called from this build.
 *
 * Shape facts (verified against the live sandbox, 1 Aug — see the probe):
 * - POST /v1/sessions returns 201 with `session_id` (prefix `ses_`, not the
 *   reference's `sess_`), `session_token`, `iframe_url`, `expires_at`.
 * - `total_amount` and `product_details[].unit_price` are strings matching
 *   ^\d+(\.\d{1,2})?$; a wrong field name errors two levels up as
 *   `purchase_context: ["Required"]`.
 * - Pre-passkey, payment-result returns status "pending" with
 *   `transactions: []` — transactions[0] may simply not exist.
 * - THE TRAP: never wait for status === "completed" — it never arrives. The
 *   credential appears while status is still "awaiting_result"; readiness is
 *   `transactions[0].line_items[0].token` existing. This module checks token
 *   EXISTENCE and forwards only `txn_ref_id` — the token, dynamic_cvv, and
 *   expiry values never leave this function, are never stored, logged, or
 *   returned.
 * - `merchant_details` is the DESTINATION merchant (vendor-confirmed),
 *   forwarded to Visa to scope the credential. Never this app's name.
 * - report-status is mandatory; its `visa_confirmation` field is surfaced.
 * - The secret key is used solely in the Authorization header and never
 *   appears in errors, logs, or return values.
 */
import type { CreatedSession, PollOutcome, ProviderPort } from '../console/flow.ts';

export const PRAVA_SANDBOX_BASE_URL = 'https://sandbox.api.prava.space';

export class ProviderError extends Error {
  readonly status: number | null;
  readonly code: string | null;

  constructor(message: string, status: number | null = null, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'ProviderError';
  }
}

export interface PravaConfig {
  readonly secretKey: string;
  /** Pre-selects the saved card so no on-camera enrollment (~193s). Discover via listCards. */
  readonly cardId?: string | null;
  readonly userId?: string;
  readonly userEmail?: string;
  readonly countryCodeIso2?: string;
  /** Injectable for tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly baseUrl?: string;
}

/** Demo suppliers have no real storefront; a stable synthetic URL satisfies the required field. */
const merchantUrl = (supplier: string): string =>
  `https://${supplier.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}.example.com`;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

export class PravaSandboxProvider implements ProviderPort {
  readonly #config: Required<Pick<PravaConfig, 'secretKey' | 'userId' | 'userEmail' | 'countryCodeIso2' | 'baseUrl'>> & {
    cardId: string | null;
    fetchImpl: typeof fetch;
  };

  constructor(config: PravaConfig) {
    if (!config.secretKey) throw new ProviderError('PRAVA_SK is not set — payment leg cannot attach');
    this.#config = {
      secretKey: config.secretKey,
      cardId: config.cardId ?? null,
      userId: config.userId ?? 'test_user_1',
      userEmail: config.userEmail ?? 'founder@aiworkspacehq.com',
      countryCodeIso2: config.countryCodeIso2 ?? 'IN',
      fetchImpl: config.fetchImpl ?? fetch,
      baseUrl: config.baseUrl ?? PRAVA_SANDBOX_BASE_URL,
    };
  }

  async #request(path: string, init?: { method?: string; body?: unknown }): Promise<Record<string, unknown>> {
    const response = await this.#config.fetchImpl(`${this.#config.baseUrl}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.#config.secretKey}`,
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = isRecord(body) && isRecord(body['error']) ? body['error'] : null;
      throw new ProviderError(
        typeof error?.['message'] === 'string' ? error['message'] : `provider returned HTTP ${response.status}`,
        response.status,
        typeof error?.['code'] === 'string' ? error['code'] : null,
      );
    }
    if (!isRecord(body)) throw new ProviderError('provider returned a non-object body');
    return body;
  }

  async createSession(args: {
    supplier: string;
    amount: number;
    currency: string;
    description: string;
  }): Promise<CreatedSession> {
    const amount = args.amount.toFixed(2); // "6200.00" — string, ^\d+(\.\d{1,2})?$
    const body = await this.#request('/v1/sessions', {
      method: 'POST', // returns 201
      body: {
        user_id: this.#config.userId,
        user_email: this.#config.userEmail,
        total_amount: amount,
        currency: args.currency,
        description: args.description,
        ...(this.#config.cardId ? { card: { card_id: this.#config.cardId } } : {}),
        purchase_context: [
          {
            merchant_details: {
              // The DESTINATION merchant — forwarded to Visa to scope the credential.
              name: args.supplier,
              url: merchantUrl(args.supplier),
              country_code_iso2: this.#config.countryCodeIso2,
            },
            product_details: [{ description: args.description, unit_price: amount, quantity: 1 }],
          },
        ],
      },
    });
    const sessionId = body['session_id']; // there is no `id` field
    const iframeUrl = body['iframe_url'];
    const expiresAt = body['expires_at']; // the server's clock — never compute 15 minutes locally
    if (typeof sessionId !== 'string' || typeof iframeUrl !== 'string' || typeof expiresAt !== 'string') {
      throw new ProviderError('create-session response missing session_id / iframe_url / expires_at');
    }
    // session_token is deliberately dropped here and never stored.
    return { sessionRef: sessionId, iframeUrl, expiresAtIso: expiresAt };
  }

  async pollResult(sessionRef: string): Promise<PollOutcome> {
    const body = await this.#request(`/v1/sessions/${sessionRef}/payment-result`);
    const transactions = Array.isArray(body['transactions']) ? body['transactions'] : [];
    const transaction = isRecord(transactions[0]) ? transactions[0] : null;
    const lineItems = transaction && Array.isArray(transaction['line_items']) ? transaction['line_items'] : [];
    const lineItem = isRecord(lineItems[0]) ? lineItems[0] : null;

    // Readiness = the credential EXISTS. Status stays "awaiting_result" even
    // then, so branching on status === "completed" would poll forever.
    if (lineItem && typeof lineItem['token'] === 'string' && lineItem['token'].length > 0) {
      const txnRefId = lineItem['txn_ref_id'];
      if (typeof txnRefId !== 'string') {
        throw new ProviderError('credential present but txn_ref_id missing — cannot report status');
      }
      return { kind: 'ready', txnRefId }; // token/dynamic_cvv/expiry never leave this function
    }
    const failed =
      body['status'] === 'failed' || (transaction !== null && transaction['status'] === 'failed');
    if (failed) {
      const error = transaction && isRecord(transaction['error']) ? transaction['error'] : null;
      return {
        kind: 'failed',
        message: typeof error?.['message'] === 'string' ? error['message'] : 'provider reported a failure',
      };
    }
    return { kind: 'pending' };
  }

  async reportApproved(sessionRef: string, txnRefId: string): Promise<{ visaConfirmation: string }> {
    const body = await this.#request(`/v1/sessions/${sessionRef}/report-status`, {
      method: 'POST',
      body: { txn_ref_id: txnRefId, txn_status: 'APPROVED' },
    });
    const confirmation = body['visa_confirmation'];
    if (typeof confirmation !== 'string') {
      throw new ProviderError('report-status response missing visa_confirmation');
    }
    return { visaConfirmation: confirmation };
  }

  /** Boot-time helper: pick the default (or first active) saved card so PRAVA_CARD_ID is optional. */
  async discoverDefaultCardId(): Promise<string | null> {
    const body = await this.#request(`/v1/listCards?customer_id=${encodeURIComponent(this.#config.userId)}`);
    const cards = Array.isArray(body['cards']) ? body['cards'].filter(isRecord) : [];
    const chosen = cards.find((c) => c['is_default'] === true) ?? cards.find((c) => c['status'] === 'active');
    return chosen && typeof chosen['card_id'] === 'string' ? chosen['card_id'] : null;
  }

  /** A provider with the discovered card baked in. */
  withCard(cardId: string): PravaSandboxProvider {
    return new PravaSandboxProvider({
      secretKey: this.#config.secretKey,
      cardId,
      userId: this.#config.userId,
      userEmail: this.#config.userEmail,
      countryCodeIso2: this.#config.countryCodeIso2,
      fetchImpl: this.#config.fetchImpl,
      baseUrl: this.#config.baseUrl,
    });
  }
}
