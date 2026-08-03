import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseApiResponse, SERVER_UNAVAILABLE_SENTENCE } from '../../public/apiClient.mjs';

describe('api response guard — a judge never sees a parser message', () => {
  it("turns the platform's text 404 into the plain sentence, never parser wording", () => {
    const result = parseApiResponse({ ok: false, contentType: 'text/plain', bodyText: 'Not Found' });
    assert.equal(result.kind, 'error');
    assert.equal(result.kind === 'error' && result.message, SERVER_UNAVAILABLE_SENTENCE);
    // pin the failure that shipped: raw body text and JSON.parse wording must not leak
    assert.ok(!String(result.kind === 'error' ? result.message : '').includes('Not Found'));
    assert.ok(!String(result.kind === 'error' ? result.message : '').includes('Unexpected token'));
  });

  it('passes healthy JSON through', () => {
    const result = parseApiResponse({
      ok: true,
      contentType: 'application/json; charset=utf-8',
      bodyText: '{"publicDemo":true}',
    });
    assert.equal(result.kind, 'ok');
    assert.deepEqual(result.kind === 'ok' && result.data, { publicDemo: true });
  });

  it("surfaces the server's own JSON error string", () => {
    const result = parseApiResponse({
      ok: false,
      contentType: 'application/json; charset=utf-8',
      bodyText: '{"error":"history already seeded"}',
    });
    assert.equal(result.kind === 'error' && result.message, 'history already seeded');
  });

  it('treats an HTML interstitial as unavailable even with HTTP 200', () => {
    const result = parseApiResponse({ ok: true, contentType: 'text/html', bodyText: '<html>spinning up…</html>' });
    assert.equal(result.kind === 'error' && result.message, SERVER_UNAVAILABLE_SENTENCE);
  });

  it('treats malformed JSON with a JSON content-type as unavailable', () => {
    const result = parseApiResponse({ ok: true, contentType: 'application/json', bodyText: '{"trunc' });
    assert.equal(result.kind === 'error' && result.message, SERVER_UNAVAILABLE_SENTENCE);
  });

  it('falls back to the sentence when a JSON error carries no error string', () => {
    const result = parseApiResponse({ ok: false, contentType: 'application/json', bodyText: '{}' });
    assert.equal(result.kind === 'error' && result.message, SERVER_UNAVAILABLE_SENTENCE);
  });
});
