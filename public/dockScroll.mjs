/**
 * Scroll gate for the payment dock. The page auto-scrolls to the provider's
 * iframe when a session first needs the human's passkey — and NEVER again for
 * that session. The refusal beat renders while an earlier session may still
 * be in flight; a repeat scroll there would yank the camera mid-refusal.
 *
 * Plain browser ESM, imported unchanged by the Node test suite so the
 * once-per-session rule is pinned by a test, not by hope.
 */
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
