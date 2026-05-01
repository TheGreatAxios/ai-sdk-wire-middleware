import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  judgeKey,
  canonicalJson,
  judgeArgs,
  loadJudgeCache,
  appendJudgeCache,
  parseJudgeReply,
  type JudgeCaller,
} from '../bench/lib/judge.ts';

let dir: string;
let cachePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tool-reduce-judge-'));
  cachePath = join(dir, 'judge.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('canonicalJson', () => {
  test('sorts object keys recursively', () => {
    const a = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
    const b = canonicalJson({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
  });

  test('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });
});

describe('judgeKey', () => {
  test('stable across input key reorderings', () => {
    const k1 = judgeKey('m', {
      toolName: 'x',
      expectedArgs: { a: 1, b: 2 },
      gotArgs: { c: 3 },
    });
    const k2 = judgeKey('m', {
      toolName: 'x',
      expectedArgs: { b: 2, a: 1 },
      gotArgs: { c: 3 },
    });
    expect(k1).toBe(k2);
  });

  test('changes when judge model changes', () => {
    const k1 = judgeKey('m1', { toolName: 'x', expectedArgs: {}, gotArgs: {} });
    const k2 = judgeKey('m2', { toolName: 'x', expectedArgs: {}, gotArgs: {} });
    expect(k1).not.toBe(k2);
  });

  test('changes when got args change', () => {
    const k1 = judgeKey('m', { toolName: 'x', expectedArgs: { a: 1 }, gotArgs: { a: 1 } });
    const k2 = judgeKey('m', { toolName: 'x', expectedArgs: { a: 1 }, gotArgs: { a: 2 } });
    expect(k1).not.toBe(k2);
  });
});

describe('judgeArgs cache', () => {
  test('first call invokes caller, second hits cache', async () => {
    let invocations = 0;
    const caller: JudgeCaller = async () => {
      invocations++;
      return { verdict: 'equivalent', reason: 'identical', latencyMs: 1 };
    };
    const input = { toolName: 'getWeather', expectedArgs: { location: 'A' }, gotArgs: { location: 'A' } };
    const r1 = await judgeArgs(input, caller, { judgeModel: 'm', cachePath });
    const r2 = await judgeArgs(input, caller, { judgeModel: 'm', cachePath });
    expect(invocations).toBe(1);
    expect(r1.cached).toBe(false);
    expect(r2.cached).toBe(true);
    expect(r2.verdict).toBe('equivalent');
  });

  test('cache survives reload', async () => {
    const caller: JudgeCaller = async () => ({
      verdict: 'not-equivalent',
      reason: 'different cities',
      latencyMs: 1,
    });
    const input = { toolName: 'x', expectedArgs: { a: 1 }, gotArgs: { a: 2 } };
    await judgeArgs(input, caller, { judgeModel: 'm', cachePath });
    const fresh = loadJudgeCache(cachePath);
    expect(fresh.size).toBe(1);
    const k = judgeKey('m', input);
    expect(fresh.get(k)?.verdict).toBe('not-equivalent');
  });

  test('tolerates a corrupt cache line', async () => {
    appendJudgeCache(cachePath, {
      key: 'good',
      ts: '2026-01-01',
      result: { verdict: 'equivalent', reason: '', model: 'm' },
    });
    // Corrupt a line in the middle.
    const fs = await import('node:fs');
    fs.appendFileSync(cachePath, 'not-json\n');
    appendJudgeCache(cachePath, {
      key: 'good2',
      ts: '2026-01-02',
      result: { verdict: 'not-equivalent', reason: '', model: 'm' },
    });
    const cache = loadJudgeCache(cachePath);
    expect(cache.size).toBe(2);
    expect(cache.has('good')).toBe(true);
    expect(cache.has('good2')).toBe(true);
  });
});

describe('parseJudgeReply', () => {
  test('parses bare JSON', () => {
    const r = parseJudgeReply('{"verdict":"equivalent","reason":"same"}');
    expect(r.verdict).toBe('equivalent');
    expect(r.reason).toBe('same');
  });

  test('parses JSON with surrounding prose', () => {
    const r = parseJudgeReply('Here is my verdict: {"verdict":"not-equivalent","reason":"different city"} done.');
    expect(r.verdict).toBe('not-equivalent');
  });

  test('falls back to not-equivalent on garbage', () => {
    expect(parseJudgeReply('lol').verdict).toBe('not-equivalent');
  });

  test('rejects unknown verdict strings safely', () => {
    expect(parseJudgeReply('{"verdict":"maybe","reason":"x"}').verdict).toBe('not-equivalent');
  });

  test('does not load malformed (we keep test file out of test mode tolerant of partial)', () => {
    // Confirms that a literal trailing-comma JSON does NOT parse to equivalent.
    const r = parseJudgeReply('{"verdict":"equivalent",}');
    expect(r.verdict).toBe('not-equivalent');
  });

  test('writeFileSync helper exists for sanity', () => {
    writeFileSync(join(dir, 'sanity'), 'x');
    expect(true).toBe(true);
  });
});
