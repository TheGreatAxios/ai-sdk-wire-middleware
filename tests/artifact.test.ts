import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendRow,
  loadRows,
  cellKey,
  existingKeys,
  newRunId,
  artifactPath,
  ARTIFACT_SCHEMA_VERSION,
  type ArtifactRow,
} from '../bench/lib/artifact.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tool-reduce-artifact-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function row(over: Partial<ArtifactRow>): ArtifactRow {
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    runId: 'live-test',
    ts: new Date().toISOString(),
    kind: 'live',
    case: 'getWeather (1 required)',
    mode: 'compact',
    rep: 0,
    ok: true,
    ...over,
  };
}

describe('artifact: append + load', () => {
  test('appendRow then loadRows round-trips', () => {
    const path = join(dir, 'live.jsonl');
    const r1 = row({ rep: 0 });
    const r2 = row({ rep: 1, mode: 'json' });
    appendRow(path, r1);
    appendRow(path, r2);
    const loaded = loadRows(path);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]!.rep).toBe(0);
    expect(loaded[1]!.mode).toBe('json');
  });

  test('loadRows on missing file returns empty', () => {
    expect(loadRows(join(dir, 'nope.jsonl'))).toEqual([]);
  });

  test('loadRows tolerates a torn last line', () => {
    const path = join(dir, 'partial.jsonl');
    appendRow(path, row({ rep: 0 }));
    appendRow(path, row({ rep: 1 }));
    // Truncate mid-line.
    const text = readFileSync(path, 'utf8');
    const cut = text.slice(0, text.length - 5);
    writeFileSync(path, cut + '{"oops"');
    const loaded = loadRows(path);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.rep).toBe(0);
  });

  test('loadRows throws on a corrupt non-trailing line', () => {
    const path = join(dir, 'bad.jsonl');
    writeFileSync(path, 'not-json\n' + JSON.stringify(row({})) + '\n');
    expect(() => loadRows(path)).toThrow(/corrupt line 1/);
  });
});

describe('artifact: cell keys + resume', () => {
  test('cellKey is stable and discriminates fields', () => {
    const a = cellKey({ kind: 'live', model: 'm1', case: 'c', mode: 'json', rep: 0 });
    const b = cellKey({ kind: 'live', model: 'm1', case: 'c', mode: 'json', rep: 0 });
    expect(a).toBe(b);
    const diff = cellKey({ kind: 'live', model: 'm1', case: 'c', mode: 'compact', rep: 0 });
    expect(a).not.toBe(diff);
  });

  test('existingKeys returns the set of all written cell keys', () => {
    const path = join(dir, 'r.jsonl');
    appendRow(path, row({ model: 'm1', mode: 'json', rep: 0 }));
    appendRow(path, row({ model: 'm1', mode: 'compact', rep: 0 }));
    const keys = existingKeys(path);
    expect(keys.has(cellKey({ kind: 'live', model: 'm1', case: 'getWeather (1 required)', mode: 'json', rep: 0 }))).toBe(true);
    expect(keys.has(cellKey({ kind: 'live', model: 'm1', case: 'getWeather (1 required)', mode: 'compact', rep: 0 }))).toBe(true);
    expect(keys.size).toBe(2);
  });

  test('newRunId starts with the kind', () => {
    expect(newRunId('live')).toMatch(/^live-\d{8}-\d{6}$/);
    expect(newRunId('offline')).toMatch(/^offline-/);
  });

  test('artifactPath defaults to bench/results', () => {
    expect(artifactPath('live-x')).toBe('bench/results/live-x.jsonl');
  });
});
