export function createScrollGate(): {
  shouldScroll(sessionRef: string | null, status: string): boolean;
};
