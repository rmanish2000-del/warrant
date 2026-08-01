/**
 * Validity guard — invariant 6: the compiler must not emit a validity period.
 *
 * The system stamps `issuedAt`/`expiresAt` at human confirmation. A model that
 * sets the lifetime of its own mandate has no mandate, so any key in the
 * model's output that even *looks* like validity is rejected before schema
 * validation or anything else touches the object. Schema alone is not enough:
 * `additionalProperties: false` catches unknown top-level keys, but a validity
 * field smuggled into a nested object the schema marks permissive — or into a
 * future schema revision — must still die here.
 */

/** Key pattern that triggers rejection, at any depth. Matches keys, never values. */
export const VALIDITY_KEY_PATTERN = /valid|expir|until|effective|ttl|duration|period|renew/i;

/** Thrown for every compiler-output rejection; `stage` says which check refused. */
export class CompilerRejection extends Error {
  readonly stage: 'validity-guard' | 'json' | 'schema';

  constructor(stage: 'validity-guard' | 'json' | 'schema', message: string) {
    super(message);
    this.stage = stage;
    this.name = 'CompilerRejection';
  }
}

/**
 * Walk every key of a parsed object (recursing through objects and arrays)
 * and return the paths of all keys matching the validity pattern. Values are
 * never inspected — policy text may legitimately *talk about* durations.
 */
export function findValidityKeys(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => findValidityKeys(item, `${path}[${i}]`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => {
      const childPath = `${path}.${key}`;
      const own = VALIDITY_KEY_PATTERN.test(key) ? [childPath] : [];
      return [...own, ...findValidityKeys(child, childPath)];
    });
  }
  return [];
}

/** Reject a compiled object that carries any validity-shaped key, before anything else is checked. */
export function assertNoValidityKeys(value: unknown): void {
  const hits = findValidityKeys(value);
  if (hits.length > 0) {
    throw new CompilerRejection(
      'validity-guard',
      `compiler output emitted validity-shaped key(s): ${hits.join(', ')} — ` +
        'the system stamps validity at confirmation; rejected (invariant 6)',
    );
  }
}
