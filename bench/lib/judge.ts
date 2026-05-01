/**
 * LLM-judge for tool-call argument equivalence.
 *
 * Replaces hand-tuned `softMatchArgs` as the headline correctness metric.
 * Same judge runs across every (model, case, mode) cell so the comparison is
 * fair regardless of which model produced the call.
 *
 * Caching:
 *   Disk-backed JSONL cache at `bench/cache/judge.jsonl`. Key =
 *   sha256(judgeModel | toolName | canonicalJson(expected) | canonicalJson(got)).
 *   On cache hit we never make an API call.
 *
 * The actual provider call is injected via `callJudge` so the judge is unit
 * testable without network.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type Verdict = 'equivalent' | 'not-equivalent';

export interface JudgeInput {
  toolName: string;
  description?: string;
  expectedArgs: unknown;
  gotArgs: unknown;
}

export interface JudgeResult {
  verdict: Verdict;
  reason: string;
  model: string;
  /** Whether this row came from cache (not persisted). */
  cached?: boolean;
  latencyMs?: number;
}

export interface CachedJudgeRow {
  key: string;
  ts: string;
  result: JudgeResult;
}

export const DEFAULT_JUDGE_MODEL = 'anthropic/claude-haiku-4.5';
export const DEFAULT_JUDGE_CACHE = join('bench', 'cache', 'judge.jsonl');

/** Stable JSON serialization (sorted keys) for cache-key stability. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(sortKeys);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) {
    out[k] = sortKeys((v as Record<string, unknown>)[k]);
  }
  return out;
}

export function judgeKey(judgeModel: string, input: JudgeInput): string {
  const h = createHash('sha256');
  h.update(judgeModel);
  h.update('|');
  h.update(input.toolName);
  h.update('|');
  h.update(canonicalJson(input.expectedArgs));
  h.update('|');
  h.update(canonicalJson(input.gotArgs));
  return h.digest('hex');
}

/**
 * Load cache as a map keyed by `key`. Tolerates corrupt non-trailing lines by
 * skipping them with a warning so a single bad write doesn't poison the cache.
 */
export function loadJudgeCache(path: string = DEFAULT_JUDGE_CACHE): Map<string, JudgeResult> {
  const map = new Map<string, JudgeResult>();
  if (!existsSync(path)) return map;
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!line) continue;
    try {
      const row = JSON.parse(line) as CachedJudgeRow;
      if (row && row.key && row.result) map.set(row.key, row.result);
    } catch {
      // Tolerate corrupt lines silently — they get rebuilt on the next miss.
      continue;
    }
  }
  return map;
}

export function appendJudgeCache(path: string, row: CachedJudgeRow): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(path, JSON.stringify(row) + '\n', { encoding: 'utf8' });
}

/**
 * Build the prompt sent to the judge model. The judge MUST reply with a
 * single JSON object of the form:
 *   {"verdict":"equivalent"|"not-equivalent","reason":"..."}
 */
export function buildJudgePrompt(input: JudgeInput): { system: string; user: string } {
  const system =
    `You are a strict tool-call equivalence judge. Two tool calls are ` +
    `EQUIVALENT iff they would have the same effect on the system being ` +
    `controlled, ignoring trivial syntactic differences such as whitespace, ` +
    `trailing punctuation, JSON-vs-string-numeric slips, and added qualifying ` +
    `detail (e.g. "Austin" vs. "Austin, TX"). They are NOT equivalent if any ` +
    `argument value would change behavior, e.g. different cities, different ` +
    `numeric magnitudes, different SQL semantics, different recipients. ` +
    `Reply with EXACTLY one JSON object: ` +
    `{"verdict":"equivalent","reason":"..."} or ` +
    `{"verdict":"not-equivalent","reason":"..."}. ` +
    `No other text.`;
  const user =
    `Tool: ${input.toolName}\n` +
    (input.description ? `Description: ${input.description}\n` : '') +
    `Expected args: ${canonicalJson(input.expectedArgs)}\n` +
    `Got args: ${canonicalJson(input.gotArgs)}\n`;
  return { system, user };
}

/** Inject point — production wiring lives in `bench/live.ts`. */
export type JudgeCaller = (
  input: JudgeInput,
  judgeModel: string,
) => Promise<{ verdict: Verdict; reason: string; latencyMs: number }>;

export interface JudgeOptions {
  judgeModel?: string;
  cachePath?: string;
  cache?: Map<string, JudgeResult>;
}

/**
 * Cache-aware judge. Falls through to `caller` only on a miss; persists the
 * miss to disk before returning.
 */
export async function judgeArgs(
  input: JudgeInput,
  caller: JudgeCaller,
  opts: JudgeOptions = {},
): Promise<JudgeResult> {
  const judgeModel = opts.judgeModel ?? DEFAULT_JUDGE_MODEL;
  const cachePath = opts.cachePath ?? DEFAULT_JUDGE_CACHE;
  const cache = opts.cache ?? loadJudgeCache(cachePath);
  const key = judgeKey(judgeModel, input);
  const hit = cache.get(key);
  if (hit) return { ...hit, cached: true };

  const t0 = performance.now();
  const raw = await caller(input, judgeModel);
  const latencyMs = Math.round(raw.latencyMs ?? performance.now() - t0);
  const result: JudgeResult = {
    verdict: raw.verdict,
    reason: raw.reason,
    model: judgeModel,
    latencyMs,
  };
  cache.set(key, result);
  appendJudgeCache(cachePath, { key, ts: new Date().toISOString(), result });
  return { ...result, cached: false };
}

/**
 * Parse the judge's freeform reply back into a strict verdict. Tolerant of
 * trailing prose; we look for the first `{ ... }` JSON object. Returns
 * `not-equivalent` with the raw reply as reason if parsing fails — that way a
 * misbehaving judge cannot silently turn a fail into a pass.
 */
export function parseJudgeReply(text: string): { verdict: Verdict; reason: string } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as {
        verdict?: string;
        reason?: string;
      };
      if (parsed.verdict === 'equivalent' || parsed.verdict === 'not-equivalent') {
        return { verdict: parsed.verdict, reason: String(parsed.reason ?? '').slice(0, 400) };
      }
    } catch {
      /* fall through */
    }
  }
  return { verdict: 'not-equivalent', reason: `unparseable judge reply: ${text.slice(0, 200)}` };
}
