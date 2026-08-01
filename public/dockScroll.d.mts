export function createScrollGate(): {
  shouldScroll(sessionRef: string | null, status: string): boolean;
};

export function createOpenGate(): {
  hasOpened(sessionRef: string): boolean;
  tryOpen(sessionRef: string, opener: () => unknown): 'opened' | 'already' | 'refused';
};
