# tool-reduce — research-grade benchmark plan

**Authors:** Anthony Holley, Sawyer Cutler
**Status:** in progress · 2026‑05‑01
**Goal:** turn `REPORT.md` from an engineering writeup into something defensible
as research, by closing the eight gaps below. Each gap has acceptance criteria
and a checklist. After all gaps close we regenerate `REPORT.md` from artifacts.

> **Resumability rule:** every benchmark cell `(model, case, mode, rep, ablation)`
> must be persisted to a JSON artifact under `bench/results/`. Reruns must skip
> cells already present. No headline number may be reported without citing the
> artifact filename.

---

## Open methodological question (flag in REPORT.md)

- [ ] **Canonical tokenizer for cross-model fairness.**
  Defaulting to `o200k_base` (GPT‑4o / GPT‑5 family) via `js-tiktoken` is a
  defensible choice but is *not* the tokenizer Anthropic / Gemini / Qwen / DS use.
  We use it only as a *common ruler* for relative comparison; we explicitly do
  NOT claim per-model billed-token accuracy. Report must call this out.
  Live benchmarks already report provider-reported `usage.outputTokens` per
  model; the offline tokenizer is only used for the "static cost of an
  encoding" comparison.

---

## 0. Foundations (unblocks everything)

### 0.1 Result-artifact format + resumable harness skeleton
- [x] Define `bench/lib/artifact.ts` with:
  - `ArtifactRow` type (cell-level): `{ schemaVersion, runId, ts, kind, model, case, mode, rep, ablation?, ok, toolName?, args?, expectedArgs?, inputTokens?, outputTokens?, elapsedMs, judge?, error? }`
  - `appendRow(path, row)` — atomic append (fsync) of one JSONL line.
  - `loadRows(path)` — parse JSONL, tolerant of partial last line.
  - `cellKey(row)` — stable string key for resumability.
  - `existingKeys(path)` — set of keys for skip-if-present.
- [x] Artifact path convention: `bench/results/<runId>.jsonl` where
  `runId = <kind>-<YYYYMMDD-HHMMSS>` (e.g. `live-20260501-153012`).
  A symlink-style `latest-<kind>.jsonl` is updated for convenience.
- [x] `bench/lib/cli.ts`: tiny argv parser supporting
  `--models a,b --cases x,y --reps 3 --judge-model m --kind live --resume <file> --dry`.
- [x] Tests: `tests/artifact.test.ts` covers append, reload, skip, partial-line.

### 0.2 Real tokenizer
- [x] `bun add js-tiktoken`.
- [x] `bench/lib/tokenizer.ts` exporting `countTokens(s, encoding='o200k_base')`
  and a `TOKENIZER_NAME` constant pinned in artifacts.
- [x] Replace the `chars/4` heuristic in `bench/eval.ts` with `countTokens`.
- [x] Re-derive the offline ~45% number; record artifact under
  `bench/results/offline-<ts>.json`.
- [x] Tests: `tests/tokenizer.test.ts` covers known string token counts (sanity),
  plus parity check that two equivalent calls count consistently.

### 0.3 LLM-judge with on-disk cache
- [x] `bench/lib/judge.ts`:
  - Input: `{ toolName, description, expectedArgs, gotArgs }`.
  - Output: `{ verdict: 'equivalent' | 'not-equivalent', reason: string, model: string, latencyMs: number }`.
  - Default judge model: `anthropic/claude-haiku-4.5` (configurable via `--judge-model`,
    fallback `openai/gpt-5-mini`, then `minimax/minimax-m2.5:free`).
  - Strict-deterministic JSON-only response prompt; uses
    `generateText` with the AI SDK `jsonSchema` constrained output if available.
  - **Disk cache:** `bench/cache/judge.jsonl`, key =
    `sha256(judgeModel | toolName | canonicalJson(expected) | canonicalJson(got))`.
  - Returns cached result without an API call when key is present.
- [x] Tests: `tests/judge-cache.test.ts` covers key stability,
  read-through-write, and corrupted-line tolerance. (Network-dependent path is
  isolated behind an injectable `callJudge` for testability.)

---

## 1. Multi-model sweep
- [x] Add `bench/lib/models.ts` with the default list:
  - `anthropic/claude-sonnet-4.5`
  - `openai/gpt-4.1` (best available on OpenRouter as of 2026-05)
  - `google/gemini-2.5-pro`
  - `qwen/qwen3-235b-a22b` (strong open)
  - `deepseek/deepseek-v3.1`
  - `minimax/minimax-m2.5:free` (cheap baseline)
- [x] `bench/live.ts` accepts `--models` CSV; defaults to the list above; skips
  cells already in `bench/results/<runId>.jsonl`.
- [x] On model error (rate limit, 4xx), record `{ ok: false, error }` row and
  continue to next cell. Never crash the run.
- [ ] Acceptance: run completes for at least 3 of the 5 models on the existing
  10-case suite; missing cells visibly marked.

## 2. Statistical treatment
- [x] `--reps N` (default 3) — run each `(model, case, mode)` cell N times.
- [x] `bench/lib/stats.ts`: `mean`, `stdev`, bootstrap 95% CI on the headline
  reduction `(json_out - compact_out) / json_out`.
- [x] Latency: report median + IQR + count of outliers (> p95 of all calls).
  Annotate but never silently drop.
- [x] Aggregator script `bench/aggregate.ts`: read JSONL, emit per-model and
  overall summary tables in markdown with mean ± stdev, 95% CI, and N.
- [ ] Acceptance: aggregator produces a markdown table snippet ready to paste
  into REPORT.md, with no headline that lacks N and CI.

## 3. Real tokenizer in offline bench (also tracked under §0.2)
- [x] `bench/eval.ts` writes its results as a JSON artifact alongside printing.
- [ ] Acceptance: offline ~45% number replaced by tokenizer-real number with the
  artifact filename cited.

## 4. Baseline encodings beyond JSON
- [x] `bench/encoders/` (internal — not exported from `index.ts`):
  - `xml-anthropic.ts` — encode a tool call as
    `<tool_use><tool_name>x</tool_name><parameters><parameter name="k">v</parameter>…</parameters></tool_use>`.
  - `python-dsl.ts` — `tool_name(arg="value", n=42)` style.
  - Both expose `encodeCall(name, args, plan)` and `encodeManual(plans)`.
- [x] Extend offline `bench/eval.ts` to compute tokens for {json, compact, xml,
  python-dsl} per case and per-manual.
- [x] Tests: `tests/baselines.test.ts` covers each encoder on every case in
  `cases` and asserts deterministic output.
- [x] Parsers for baselines are NOT required (the report only needs token cost).

## 5. LLM-judge correctness scoring (replaces softMatchArgs in headline)
- [x] `bench/live.ts` calls `judgeArgs(toolName, description, expected, got)`
  for every cell where `tc?.toolName === expected.name`. Tool-name mismatch is
  always not-equivalent.
- [x] Persist judge verdict + reason on every artifact row.
- [x] `softMatchArgs` stays in the file but is demoted to a debug column;
  judge verdict is the headline correctness metric.
- [ ] Acceptance: judge cache hit rate ≥ 90% on a rerun of the same artifact.

## 6. Multi-step agent benchmark
- [x] `bench/agent-tasks.ts`: 6 task definitions, each with:
  - `name`, `prompt`, `expectedToolSequence` (loose: ordered set),
    `successCheck(steps): { ok: boolean; reason: string }`.
  - Tools available are reused from `bench/tools.ts` (with `execute` returning
    deterministic mocked outputs so success can be checked offline of providers).
- [x] Tasks:
  1. `tx-cities-weather-email` — `getWeather × 3` (Houston, Dallas, Austin) → `sendEmail`.
  2. `search-then-fetch` — `searchProducts` → `webFetch` (top result) → `calculate` (price math).
  3. `db-then-email` — `askDb` (active users) → `sendEmail` summary.
  4. `time-around-world` — `getTime × 4` then summarize via prose.
  5. `reminder-cascade` — `setReminder × 3` at offset times.
  6. `files-then-fetch` — `listFiles` → pick a doc → `webFetch`.
- [x] `bench/agent.ts` driver:
  - Wraps tools so each `execute` returns deterministic stub data and records
    the call sequence.
  - Uses AI SDK `generateText({ stopWhen: ({ steps }) => steps.length >= 8 })`.
  - For each `(model, task, mode, rep)` records cumulative output tokens, total
    input tokens, total elapsed, tool-call sequence, and success verdict.
- [x] Success verdict checks tool-sequence overlap and argument correctness.
- [ ] Acceptance: agent driver produces a JSONL artifact and an aggregated
  table of `tokens_saved%` and `success_delta` per model.

## 7. Quality-tax measurement
- [x] `bench/aggregate.ts` emits:
  - Per-model row: `(json_success, compact_success, json_out, compact_out, reduction%)`.
  - Pareto plot data: x = success, y = output tokens; one point per `(model, mode)` cell aggregate.
  - ASCII Pareto sketch in REPORT.md (no images required).
- [ ] Acceptance: report shows whether compact is dominated, dominates, or is on the Pareto frontier per model.

## 8. Ablations
- [x] **8a Manual on/off:** `--ablation no-manual` runs compact mode with the
  manual stripped (only the catalogue listing remains). Measures whether the
  manual is the input-side win or merely overhead.
- [x] **8b Encoding sweep:** `--ablation syntax=shell|csv|json` runs each on
  the same case set. Same `(model, case, rep)` cell repeated under each syntax.
- [x] **8c Placement:** `--ablation placement=first|last`.
- [x] All ablations record `ablation` field in the artifact row so aggregator
  can group by it.
- [x] Aggregator emits ablations table per axis with reduction% deltas vs canonical.
- [ ] Acceptance: aggregator emits a small ablations table per axis with
  reduction% deltas vs the canonical compact configuration.

---

## Reproducibility & artifact layout

```
bench/
  lib/
    artifact.ts       # JSONL append/load, cell keys, run IDs
    cli.ts            # tiny argv parser
    tokenizer.ts      # js-tiktoken wrapper (o200k_base default)
    judge.ts          # LLM judge + on-disk cache
    stats.ts          # mean/stdev/bootstrap CI
    models.ts         # default model list + helpers
  encoders/           # baseline encoders (offline only)
  cache/
    judge.jsonl       # judge-cache (gitignored)
  results/
    offline-<ts>.json
    live-<ts>.jsonl
    agent-<ts>.jsonl
    latest-offline.json
    latest-live.jsonl
    latest-agent.jsonl
  eval.ts             # offline (now writes artifact)
  live.ts             # multi-model + reps + judge
  agent.ts            # multi-step agent driver
  aggregate.ts        # artifact → markdown
  agent-tasks.ts      # task definitions
```

- `bench/results/` and `bench/cache/` are gitignored; the report cites the
  filenames it uses (committed as `bench/results/published/<name>.jsonl` if we
  want to preserve a specific run).

---

## Final step: rewrite REPORT.md from artifacts

- [ ] Section 3 (offline) sourced from `bench/results/published/offline.json`.
- [ ] Section 4 (live) sourced from `bench/results/published/live.jsonl` via
  `bench/aggregate.ts --kind live`.
- [ ] New Section 4.x (agent) sourced from `agent.jsonl`.
- [ ] New Section 5 (ablations).
- [ ] §6 reproducibility lists exact commands + artifact filenames.
- [ ] Authors stay Anthony Holley and Sawyer Cutler. No fabricated numbers;
  any failed model cell is shown as `—` with a footnote.

---

## Test gates (run after each meaningful change)

- [x] `bun test` — must stay green; current baseline = 182.
- [ ] `bunx tsc --noEmit` — must stay green.
- [ ] New code paths must add tests:
  - artifact: append/reload/skip/partial-line
  - tokenizer: known counts + invariant under whitespace
  - judge cache: key stability, hit-on-rerun, corrupted-line tolerance
  - baseline encoders: deterministic on each case
  - agent harness: deterministic stub-mode runs cell artifact correctly
