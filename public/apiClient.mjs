/**
 * Response guard for every console fetch. The platform's proxy can answer for
 * a briefly-unavailable server with a text page ("Not Found", a spin-up
 * interstitial, …); parsing that as JSON surfaces a raw parser message — a
 * judge must never see one, on camera or on the live site. Every response
 * goes through here: non-JSON, malformed JSON, and JSON errors all come out
 * as one plain sentence or the server's own error string. No exceptions
 * escape with parser wording.
 */
export const SERVER_UNAVAILABLE_SENTENCE =
  'The demo server is briefly unavailable — try again in a moment.';

/**
 * Classify a response body. Pure — takes fields, not a Response — so it is
 * unit-testable in Node without a browser.
 * Returns { kind: "ok", data } or { kind: "error", message }.
 */
export function parseApiResponse({ ok, contentType, bodyText }) {
  const isJson = (contentType || '').includes('application/json');
  if (!isJson) return { kind: 'error', message: SERVER_UNAVAILABLE_SENTENCE };
  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    return { kind: 'error', message: SERVER_UNAVAILABLE_SENTENCE };
  }
  if (!ok) {
    const message =
      data && typeof data === 'object' && typeof data.error === 'string'
        ? data.error
        : SERVER_UNAVAILABLE_SENTENCE;
    return { kind: 'error', message };
  }
  return { kind: 'ok', data };
}
