/**
 * Compile cache — one file, gitignored via the existing `demo-policy*.json`
 * rule. The demo films exactly one live compile; every retake replays this
 * cache (`demo:reset`) so clause text and flags stay identical across takes.
 * Only `demo:fresh` may call the API.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { CompileResult } from './compile.ts';

export const CACHE_PATH = 'demo-policy-compiled.json';

export interface CachedCompile {
  readonly policyText: string;
  readonly result: CompileResult;
  /** ISO timestamp stamped by the CLI at write time — the cache's only clock read. */
  readonly compiledAt: string;
}

export function writeCompileCache(cache: CachedCompile, path: string = CACHE_PATH): void {
  writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}

export function readCompileCache(path: string = CACHE_PATH): CachedCompile | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as CachedCompile;
  if (!parsed?.result?.draft || !parsed.result.source) {
    throw new Error(`${path} exists but is not a compile cache — delete it and run demo:fresh`);
  }
  return parsed;
}
