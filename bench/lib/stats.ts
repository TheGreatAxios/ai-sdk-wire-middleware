/**
 * Lightweight statistical helpers for benchmark aggregation.
 *
 * Exports mean, stdev (sample), bootstrap 95% CI, and median/IQR/outlier
 * helpers. No external dependencies — just Math.
 */

/**
 * Arithmetic mean.
 */
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, v) => a + v, 0) / values.length;
}

/**
 * Sample standard deviation (Bessel's correction: divide by n-1).
 * Returns 0 if fewer than 2 values.
 */
export function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const sqDiffs = values.map(v => (v - m) ** 2);
  return Math.sqrt(sqDiffs.reduce((a, s) => a + s, 0) / (values.length - 1));
}

/**
 * Median (50th percentile).
 */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

/**
 * Interquartile range (Q3 - Q1).
 */
export function iqr(values: number[]): number {
  if (values.length < 4) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = percentile(sorted, 25);
  const q3 = percentile(sorted, 75);
  return q3 - q1;
}

/**
 * Linear-interpolated percentile.
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const k = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(k);
  const hi = Math.ceil(k);
  if (lo === hi) return sorted[lo]!;
  const frac = k - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

/**
 * Bootstrap 95% confidence interval. Resamples `iterations` times (default 1000)
 * and returns the 2.5th and 97.5th percentile of resampled means.
 */
export function bootstrapCi(
  values: number[],
  iterations: number = 1_000,
): [lower: number, upper: number] {
  if (values.length === 0) return [0, 0];
  if (values.length < 3) return [mean(values), mean(values)];

  const bootMeans: number[] = [];
  const n = values.length;
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      sum += values[Math.floor(Math.random() * n)]!;
    }
    bootMeans.push(sum / n);
  }
  bootMeans.sort((a, b) => a - b);
  const lower = percentile(bootMeans, 2.5);
  const upper = percentile(bootMeans, 97.5);
  return [lower, upper];
}

/**
 * Count of values above the p95 threshold (non-exclusive — values > p95).
 */
export function outlierCount(values: number[], thresholdPct = 95): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const thresh = percentile(sorted, thresholdPct);
  return values.filter(v => v > thresh).length;
}

/**
 * Summary statistics for a single metric.
 */
export interface MetricsSummary {
  n: number;
  mean: number;
  stdev: number;
  median: number;
  iqr: number;
  ci95: [lower: number, upper: number];
  outliers: number;
  min: number;
  max: number;
}

export function summarize(values: number[]): MetricsSummary {
  return {
    n: values.length,
    mean: round(mean(values), 2),
    stdev: round(stdev(values), 2),
    median: round(median(values), 2),
    iqr: round(iqr(values), 2),
    ci95: bootstrapCi(values).map(x => round(x, 2)) as [number, number],
    outliers: outlierCount(values),
    min: values.length > 0 ? round(Math.min(...values), 2) : 0,
    max: values.length > 0 ? round(Math.max(...values), 2) : 0,
  };
}

function round(n: number, d = 4): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/**
 * Return a markdown-friendly string: "mean ± stdev (CI: lower–upper) [N=n]"
 */
export function fmtSummary(s: MetricsSummary): string {
  return `${s.mean.toFixed(2)} ± ${s.stdev.toFixed(2)} (95% CI: ${s.ci95[0].toFixed(2)}–${s.ci95[1].toFixed(2)}) [N=${s.n}]`;
}
