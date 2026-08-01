import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenGate, createScrollGate } from '../../public/dockScroll.mjs';

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

describe('open gate — the tab must really exist before the button is consumed', () => {
  const workingOpener = () => {
    let calls = 0;
    const opener = () => {
      calls += 1;
      return { fake: 'tab' };
    };
    return { opener, callCount: () => calls };
  };

  it('a successful open consumes the session; a second attempt never reopens', () => {
    const gate = createOpenGate();
    const { opener, callCount } = workingOpener();
    assert.equal(gate.tryOpen('ses_1', opener), 'opened');
    assert.equal(gate.hasOpened('ses_1'), true);
    assert.equal(gate.tryOpen('ses_1', opener), 'already');
    assert.equal(callCount(), 1, 'the opener must not run again — the link is single-use');
  });

  it('THE FIX PIN: a refused open consumes NOTHING — the button may be clicked again', () => {
    const gate = createOpenGate();
    assert.equal(gate.tryOpen('ses_1', () => null), 'refused');
    assert.equal(gate.hasOpened('ses_1'), false, 'no tab, no consumption, no false note');
    const { opener } = workingOpener();
    assert.equal(gate.tryOpen('ses_1', opener), 'opened');
  });

  it('sessions are independent', () => {
    const gate = createOpenGate();
    const { opener } = workingOpener();
    gate.tryOpen('ses_1', opener);
    assert.equal(gate.hasOpened('ses_2'), false);
    assert.equal(gate.tryOpen('ses_2', opener), 'opened');
  });
});
