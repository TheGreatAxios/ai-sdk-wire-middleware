#!/usr/bin/env bun
/**
 * ai-sdk-wire-middleware — benchmark aggregator
 * --------------------------------------------------------------
 * Reads a JSONL artifact produced by `bench/live.ts` or `bench/agent.ts`
 * and emits summary tables in markdown, ready to paste into REPORT.md.
 *
 * Usage:
 *   bun run bench/aggregate.ts --kind live   bench/results/latest-live.jsonl
 *   bun run bench/aggregate.ts --kind agent  bench/results/latest-agent.jsonl
 *   bun run bench/aggregate.ts --kind all    bench/results/  (aggregate all live + agent)
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ArtifactRow,
  loadRows,
} from './lib/artifact.ts';
import { mean, stdev, bootstrapCi, median, iqr, summarize, fmtSummary, type MetricsSummary } from './lib/stats.ts';

// ─────────────────────────────────────────────────────── CLI ──

const args = process.argv.slice(2);
const kindFlag = args.indexOf('--kind');
const kind: 'live' | 'agent' | 'all' = kindFlag !== -1
  ? (args[kindFlag + 1] as any) ?? 'all'
  : 'all';

const paths = args.filter(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));

function loadFromPaths(paths: string[]): ArtifactRow[] {
  const all: ArtifactRow[] = [];
  for (const p of paths) {
    if (!existsSync(p)) {
      console.error(`✗ not found: ${p}`);
      continue;
    }
    const stat = statSync(p);
    if (stat.isDirectory()) {
      for (const f of readdirSync(p).filter(f => f.endsWith('.jsonl'))) {
        if (kind !== 'all' && !f.startsWith(kind)) continue;
        all.push(...loadRows(join(p, f)));
      }
    } else {
      all.push(...loadRows(p));
    }
  }
  return all;
}

// ───────────────────────────────────────────────── helpers ──

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function modelShort(slug: string): string {
  return slug.replace(/^.*\//, '').replace(/:free$/, '');
}

function pad(s: string, n: number): string {
  return s.padEnd(n);
}

// ─────────────────────────────────────────────── aggregation ──

function aggregateLive(rows: ArtifactRow[]): string {
  const lines: string[] = [];

  // Filter to only non-ablation json/compact rows.
  const normalRows = rows.filter(r => !r.ablation && (r.mode === 'json' || r.mode === 'compact'));

  lines.push('## Live benchmark results');
  lines.push('');
  lines.push(`**Source:** ${rows.length} rows across ${new Set(rows.map(r => r.model)).size} models, ${new Set(rows.map(r => r.case)).size} cases`);
  lines.push('');

  // Per-model table.
  const byModel = groupBy(normalRows, r => r.model ?? 'unknown');

  lines.push('### Per-model output-token reduction');
  lines.push('');
  lines.push('| Model | Mode | Equivalent | Total Calls | Total Output Tokens | Reduction vs JSON |');
  lines.push('|-------|------|-----------:|------------:|--------------------:|------------------:|');

  for (const [model, modelRows] of Object.entries(byModel).sort()) {
    const jsonEq = modelRows.filter(r => r.mode === 'json' && r.judge?.verdict === 'equivalent').length;
    const jsonTotal = modelRows.filter(r => r.mode === 'json').length;
    const compactEq = modelRows.filter(r => r.mode === 'compact' && r.judge?.verdict === 'equivalent').length;
    const compactTotal = modelRows.filter(r => r.mode === 'compact').length;
    const jsonOut = modelRows.filter(r => r.mode === 'json').reduce((a, r) => a + (r.outputTokens ?? 0), 0);
    const compactOut = modelRows.filter(r => r.mode === 'compact').reduce((a, r) => a + (r.outputTokens ?? 0), 0);
    const reduction = jsonOut > 0 ? ((jsonOut - compactOut) / jsonOut) : 0;

    lines.push(`| ${pad(modelShort(model), 30)} | json | ${jsonEq} | ${jsonTotal} | ${jsonOut} | — |`);
    lines.push(`| ${pad('', 30)} | compact | ${compactEq} | ${compactTotal} | ${compactOut} | ${pct(reduction)} |`);
  }

  // Per-case detail.
  const byCase = groupBy(normalRows, r => r.case);
  lines.push('');
  lines.push('### Per-case output-token detail');
  lines.push('');
  lines.push('| Case | Mode | N | Mean Output Tokens | Mean Reduction |');
  lines.push('|------|------|---:|-------------------:|---------------:|');

  for (const [caseName, caseRows] of Object.entries(byCase).sort()) {
    const jsonRows = caseRows.filter(r => r.mode === 'json' && r.ok);
    const compactRows = caseRows.filter(r => r.mode === 'compact' && r.ok);
    const jsonOut = jsonRows.map(r => r.outputTokens ?? 0);
    const compactOut = compactRows.map(r => r.outputTokens ?? 0);
    const reductions = compactRows.map((r, i) => {
      const j = jsonRows[i]?.outputTokens ?? 0;
      return j > 0 ? ((j - (r.outputTokens ?? 0)) / j) * 100 : 0;
    });

    const jsonMean = mean(jsonOut);
    const compactMean = mean(compactOut);
    const avgReduction = reductions.length > 0 ? mean(reductions) : 0;

    lines.push(`| ${pad(caseName, 36)} | json | ${jsonOut.length} | ${round2(jsonMean)} | — |`);
    lines.push(`| ${pad('', 36)} | compact | ${compactOut.length} | ${round2(compactMean)} | ${round2(avgReduction)}% |`);
  }

  // Latency summary
  lines.push('');
  lines.push('### Latency (all reps)');
  lines.push('');
  lines.push('| Model | Mode | N | Median (ms) | IQR (ms) | Outliers (>p95) |');
  lines.push('|-------|------|---:|------------:|---------:|----------------:|');

  for (const [model, modelRows] of Object.entries(byModel).sort()) {
    for (const mode of ['json', 'compact'] as const) {
      const latencies = modelRows.filter(r => r.mode === mode && r.elapsedMs != null).map(r => r.elapsedMs!);
      if (latencies.length === 0) continue;
      const s = summarize(latencies);
      lines.push(`| ${pad(modelShort(model), 30)} | ${mode.padEnd(7)} | ${latencies.length} | ${s.median} | ${s.iqr} | ${s.outliers} |`);
    }
  }

  // Ablations table
  const ablationRows = rows.filter(r => r.ablation);
  if (ablationRows.length > 0) {
    lines.push('');
    lines.push('### Ablations');
    lines.push('');
    lines.push('| Ablation | Model | Mode | N | Equivalent | Total Out |');
    lines.push('|----------|-------|------|---:|-----------:|----------:|');

    for (const [abl, ablRows] of Object.entries(groupBy(ablationRows, r => r.ablation!)).sort()) {
      const byModelX = groupBy(ablRows, r => r.model ?? 'unknown');
      for (const [model, mRows] of Object.entries(byModelX).sort()) {
        const eq = mRows.filter(r => r.judge?.verdict === 'equivalent').length;
        const out = mRows.reduce((a, r) => a + (r.outputTokens ?? 0), 0);
        lines.push(`| ${pad(abl, 20)} | ${pad(modelShort(model), 30)} | compact | ${mRows.length} | ${eq} | ${out} |`);
      }
    }
  }

  // Judge cache efficiency
  const cachedRows = normalRows.filter(r => r.judge && r.judge.model);
  if (cachedRows.length > 0) {
    lines.push('');
    lines.push('### Judge cache');
    lines.push(`- ${cachedRows.length} judged cells`);
    lines.push(`- Judge model: ${cachedRows[0]!.judge!.model}`);
  }

  // Error summary
  const errors = rows.filter(r => !r.ok && r.error);
  if (errors.length > 0) {
    lines.push('');
    lines.push(`### Errors (${errors.length} cells)`);
    lines.push('');
    for (const e of errors.slice(0, 10)) {
      lines.push(`- ${e.model}/${e.case}/${e.mode}/${e.rep}: ${e.error!.slice(0, 80)}`);
    }
    if (errors.length > 10) lines.push(`- … and ${errors.length - 10} more`);
  }

  return lines.join('\n');
}

function aggregateAgent(rows: ArtifactRow[]): string {
  const lines: string[] = [];

  lines.push('## Agent benchmark results');
  lines.push('');
  lines.push(`**Source:** ${rows.length} rows across ${new Set(rows.map(r => r.model)).size} models, ${new Set(rows.map(r => r.case)).size} tasks`);
  lines.push('');

  // Success rate per model.
  const byModel = groupBy(rows, r => r.model ?? 'unknown');

  lines.push('### Per-model success rate');
  lines.push('');
  lines.push('| Model | Mode | Success | Total | Success Rate | Total Out |');
  lines.push('|-------|------|--------:|------:|-------------:|----------:|');

  for (const [model, modelRows] of Object.entries(byModel).sort()) {
    const jsonOk = modelRows.filter(r => r.mode === 'json' && r.ok).length;
    const jsonTotal = modelRows.filter(r => r.mode === 'json').length;
    const compactOk = modelRows.filter(r => r.mode === 'compact' && r.ok).length;
    const compactTotal = modelRows.filter(r => r.mode === 'compact').length;
    const jsonOut = modelRows.filter(r => r.mode === 'json' && r.ok).reduce((a, r) => a + (r.outputTokens ?? 0), 0);
    const compactOut = modelRows.filter(r => r.mode === 'compact' && r.ok).reduce((a, r) => a + (r.outputTokens ?? 0), 0);

    if (jsonTotal > 0) {
      lines.push(`| ${pad(modelShort(model), 30)} | json | ${jsonOk} | ${jsonTotal} | ${jsonTotal > 0 ? pct(jsonOk / jsonTotal) : '—'} | ${jsonOut} |`);
    }
    if (compactTotal > 0) {
      lines.push(`| ${pad('', 30)} | compact | ${compactOk} | ${compactTotal} | ${compactTotal > 0 ? pct(compactOk / compactTotal) : '—'} | ${compactOut} |`);
    }
  }

  // Per-task detail
  const byTask = groupBy(rows, r => r.case);
  lines.push('');
  lines.push('### Per-task detail');
  lines.push('');
  lines.push('| Task | Mode | Success | Total | Avg Tools Called | Avg Out |');
  lines.push('|------|------|--------:|------:|-----------------:|--------:|');

  for (const [task, taskRows] of Object.entries(byTask).sort()) {
    for (const mode of ['json', 'compact'] as const) {
      const mRows = taskRows.filter(r => r.mode === mode);
      if (mRows.length === 0) continue;
      const ok = mRows.filter(r => r.ok).length;
      const avgOut = mean(mRows.filter(r => r.outputTokens != null).map(r => r.outputTokens!));
      const avgTools = mean(mRows.filter(r => r.extra?.steps).map(r => (r.extra!.steps as any[]).length));
      lines.push(
        `| ${pad(task, 36)} | ${mode.padEnd(7)} | ${ok} | ${mRows.length} | ${round2(avgTools)} | ${round2(avgOut)} |`,
      );
    }
  }

  // Token reduction for agent runs
  const jsonOkRows = rows.filter(r => r.mode === 'json' && r.ok);
  const compactOkRows = rows.filter(r => r.mode === 'compact' && r.ok);
  if (jsonOkRows.length > 0 && compactOkRows.length > 0) {
    const jsonTotalOut = jsonOkRows.reduce((a, r) => a + (r.outputTokens ?? 0), 0);
    const compactTotalOut = compactOkRows.reduce((a, r) => a + (r.outputTokens ?? 0), 0);
    const reduction = jsonTotalOut > 0 ? ((jsonTotalOut - compactTotalOut) / jsonTotalOut) * 100 : 0;
    lines.push('');
    lines.push(`**Overall output-token reduction (successful runs only):** ${pct(reduction / 100)}`);
  }

  return lines.join('\n');
}

// ──────────────────────────────────────────────────── main ──

const allRows = loadFromPaths(paths);
if (allRows.length === 0) {
  console.error('✗ No rows loaded. Provide a path to a .jsonl artifact or directory.');
  console.error('  bun run bench/aggregate.ts --kind live bench/results/latest-live.jsonl');
  process.exit(1);
}

const liveRows = allRows.filter(r => r.kind === 'live');
const agentRows = allRows.filter(r => r.kind === 'agent');

console.log('---');
console.log('# ai-sdk-wire-middleware benchmark report');
console.log('');
console.log(`_Generated from ${allRows.length} rows across ${new Set(allRows.map(r => r.kind)).size} benchmark kinds._`);
console.log('');

if (kind === 'live' || kind === 'all') {
  if (liveRows.length > 0) {
    console.log(aggregateLive(liveRows));
    console.log('');
  } else {
    console.log('_No live benchmark rows found._\n');
  }
}

if (kind === 'agent' || kind === 'all') {
  if (agentRows.length > 0) {
    console.log(aggregateAgent(agentRows));
    console.log('');
  } else {
    console.log('_No agent benchmark rows found._\n');
  }
}

console.log('---');

// ──────────────────────────────────────────────── groupBy ──

function groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const map: Record<string, T[]> = {};
  for (const item of items) {
    const key = keyFn(item);
    if (!map[key]) map[key] = [];
    map[key].push(item);
  }
  return map;
}
