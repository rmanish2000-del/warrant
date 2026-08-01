import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createScrollGate } from '../../public/dockScroll.mjs';

describe('payment dock scroll gate — once per session, never during the refusal beat', () => {
  it('scrolls exactly once when a session first awaits its passkey', () => {
    const gate = createScrollGate();
    assert.equal(gate.shouldScroll('ses_1', 'awaiting_verification'), true);
  });

  it('THE PIN: a second poll on the same session must not scroll', () => {
    const gate = createScrollGate();
    gate.shouldScroll('ses_1', 'awaiting_verification');
    // Every subsequent poll while B's session is in flight — including the
    // ones that arrive while scenario C's refusal is on screen — is a no.
    for (let poll = 0; poll < 50; poll += 1) {
      assert.equal(gate.shouldScroll('ses_1', 'awaiting_verification'), false);
    }
  });

  it('never scrolls for non-awaiting states, even for an unseen session', () => {
    const gate = createScrollGate();
    for (const status of ['requested', 'confirmed', 'declined', 'unavailable', 'lapsed']) {
      assert.equal(gate.shouldScroll('ses_new', status), false);
    }
    assert.equal(gate.shouldScroll(null, 'awaiting_verification'), false);
  });

  it('a session already scrolled stays consumed even across status flaps', () => {
    const gate = createScrollGate();
    gate.shouldScroll('ses_1', 'awaiting_verification');
    gate.shouldScroll('ses_1', 'confirmed');
    assert.equal(gate.shouldScroll('ses_1', 'awaiting_verification'), false);
  });

  it('a genuinely new session scrolls again — that is a new passkey to perform', () => {
    const gate = createScrollGate();
    gate.shouldScroll('ses_1', 'awaiting_verification');
    assert.equal(gate.shouldScroll('ses_2', 'awaiting_verification'), true);
  });
});
