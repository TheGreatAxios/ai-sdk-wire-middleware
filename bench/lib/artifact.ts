/**
 * Append-only JSONL artifact format for resumable benchmark runs.
 *
 * Every benchmark cell — `(kind, model, case, mode, rep, ablation?)` — is one
 * line. Reruns load existing rows, build a `Set` of cell keys, and skip cells
 * already present. If a process is interrupted partway through a line, that
 * partial line is tolerated on reload.
 *
 * Schema versioning is explicit so we can evolve fields without breaking
 * older artifacts.
 */
import { appendFileSync, existsSync, readFileSync, mkdirSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';

export const ARTIFACT_SCHEMA_VERSION = 1;

export interface ArtifactRow {
  schemaVersion: number;
  runId: string;
  ts: string;
  kind: 'offline' | 'live' | 'agent';
  model?: string;
  case: string;
  mode: 'json' | 'compact' | 'xml' | 'python-dsl';
  rep: number;
  ablation?: string;
  ok: boolean;
  toolName?: string | null;
  args?: unknown;
  expectedArgs?: unknown;
  inputTokens?: number;
  outputTokens?: number;
  elapsedMs?: number;
  judge?: { verdict: 'equivalent' | 'not-equivalent'; reason: string; model: string };
  error?: string;
  /** Free-form per-row payload (e.g. agent step trace). */
  extra?: Record<string, unknown>;
}

/**
 * Stable cell key for resume / dedupe. We DO include `rep` so reps are
 * independently skippable; we do NOT include `ts` or `judge` because those are
 * results-of-running.
 */
export function cellKey(row: Pick<ArtifactRow, 'kind' | 'model' | 'case' | 'mode' | 'rep' | 'ablation'>): string {
  const parts = [
    row.kind,
    row.model ?? '_',
    row.case,
    row.mode,
    String(row.rep),
    row.ablation ?? '_',
  ];
  return parts.join('|');
}

export function newRunId(kind: ArtifactRow['kind'], at: Date = new Date()): string {
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
  const stamp =
    `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `-${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`;
  return `${kind}-${stamp}`;
}

/** Default location: bench/results/<runId>.jsonl */
export function artifactPath(runId: string, root = 'bench/results'): string {
  return join(root, `${runId}.jsonl`);
}

export function appendRow(path: string, row: ArtifactRow): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(path, JSON.stringify(row) + '\n', { encoding: 'utf8' });
}

/**
 * Load all rows from a JSONL artifact. Tolerant of:
 * - missing file (returns []),
 * - blank trailing lines,
 * - a single corrupt last line (truncated write).
 *
 * Throws on a corrupt non-last line so we don't silently lose data mid-file.
 */
export function loadRows(path: string): ArtifactRow[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const rows: ArtifactRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!line) continue;
    try {
      rows.push(JSON.parse(line) as ArtifactRow);
    } catch (err) {
      if (i === lines.length - 1 || lines.slice(i + 1).every(l => !l)) {
        // Tolerate a single torn last line.
        break;
      }
      throw new Error(`artifact ${path}: corrupt line ${i + 1}: ${(err as Error).message}`);
    }
  }
  return rows;
}

export function existingKeys(path: string): Set<string> {
  const out = new Set<string>();
  for (const r of loadRows(path)) out.add(cellKey(r));
  return out;
}

/**
 * Update bench/results/latest-<kind>.jsonl to point at the freshest run for
 * that kind. Uses a symlink where possible, falls back to a copy on failure
 * (Windows / restricted filesystems).
 */
export function updateLatestPointer(runId: string, root = 'bench/results'): void {
  const kind = runId.split('-')[0]!;
  const target = `${runId}.jsonl`;
  const link = join(root, `latest-${kind}.jsonl`);
  if (!existsSync(join(root, target))) return;
  try {
    if (existsSync(link)) unlinkSync(link);
    symlinkSync(target, link);
  } catch {
    try {
      writeFileSync(link, readFileSync(join(root, target)));
    } catch {
      /* best-effort */
    }
  }
}

/** Helper used by the CLI: resolve `--resume <file>` to an existing-keys set. */
export function loadResumeKeys(resumePath: string | undefined): Set<string> {
  if (!resumePath) return new Set();
  return existingKeys(resumePath);
}

export function summarizeArtifact(rows: ArtifactRow[]): {
  total: number;
  byKind: Record<string, number>;
  byMode: Record<string, number>;
  byModel: Record<string, number>;
  ok: number;
  failed: number;
} {
  const byKind: Record<string, number> = {};
  const byMode: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  let ok = 0;
  let failed = 0;
  for (const r of rows) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    byMode[r.mode] = (byMode[r.mode] ?? 0) + 1;
    if (r.model) byModel[r.model] = (byModel[r.model] ?? 0) + 1;
    if (r.ok) ok++;
    else failed++;
  }
  return { total: rows.length, byKind, byMode, byModel, ok, failed };
}

/** Convenience: derive the artifact basename from a path. */
export function artifactName(path: string): string {
  return basename(path);
}
