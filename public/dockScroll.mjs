/**
 * Scroll gate for the payment dock. The page auto-scrolls to the provider's
 * iframe when a session first needs the human's passkey — and NEVER again for
 * that session. The refusal beat renders while an earlier session may still
 * be in flight; a repeat scroll there would yank the camera mid-refusal.
 *
 * Plain browser ESM, imported unchanged by the Node test suite so the
 * once-per-session rule is pinned by a test, not by hope.
 */
/**
 * Open gate for the provider's approval tab. `window.open` inside a genuine
 * click has user activation, and — unlike an anchor's default action — gives
 * a verifiable result. The session is marked opened ONLY when a tab really
 * opened, so the "open in another tab" note can never be shown falsely, and
 * a refused attempt leaves the button in place for another click (nothing
 * was loaded, nothing was consumed).
 */
export function createOpenGate() {
  const opened = new Set();
  return {
    hasOpened(sessionRef) {
      return opened.has(sessionRef);
    },
    /** 'opened' consumes; 'already' never reopens; 'refused' consumes nothing. */
    tryOpen(sessionRef, opener) {
      if (opened.has(sessionRef)) return 'already';
      const tab = opener();
      if (!tab) return 'refused';
      opened.add(sessionRef);
      return 'opened';
    },
  };
}

export function createScrollGate() {
  const scrolled = new Set();
  return {
    /** True exactly once per sessionRef, and only while the passkey is actually awaited. */
    shouldScroll(sessionRef, status) {
      if (status !== 'awaiting_verification' || !sessionRef) return false;
      if (scrolled.has(sessionRef)) return false;
      scrolled.add(sessionRef);
      return true;
    },
  };
}
