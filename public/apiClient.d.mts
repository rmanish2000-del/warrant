export const SERVER_UNAVAILABLE_SENTENCE: string;

export function parseApiResponse(input: {
  ok: boolean;
  contentType: string | null;
  bodyText: string;
}): { kind: 'ok'; data: unknown } | { kind: 'error'; message: string };
