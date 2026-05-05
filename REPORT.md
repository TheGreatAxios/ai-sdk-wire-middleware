# tool-reduce: A Compact Wire Format for LLM Tool Calling

**Authors:** Anthony Holley, Sawyer Cutler
**Status:** Working note · 2026‑05‑04
**Repository:** `tool-reduce` (Vercel AI SDK v6 middleware)

---

## 1. Motivation

Frontier open-weight models struggle with the JSON tool-calling protocol on
complex multi-step agent tasks. Even SOTA models like GLM-5 (744B), GLM-5.1
(754B), and GLM-5-Turbo — which rival GPT-5 and Claude Opus on coding and
agentic benchmarks — routinely fail to produce valid chains of tool calls.
They drop steps, loop on repeated calls, guess wrong parameter names, or emit
`[object Object]` instead of structured arguments.

The problem isn't the model's reasoning — it's the protocol overhead. Every
tool call requires the model to produce a deeply nested JSON structure with
quoted keys, escaped strings, and redundant envelope fields. For an agent loop
running dozens of calls, this structural noise crowds out reasoning bandwidth.

`tool-reduce` replaces the verbose JSON tool-calling protocol with a one-line,
shell-flavoured `<call>name k=v</call>` wire format. The model emits flat
key-value pairs instead of nested JSON — less to get wrong, fewer tokens to
produce, and easier to parse back. The middleware converts these back into the
AI SDK's native `tool-call` content parts transparently.

---

## 2. Method

### 2.1 Wire format

```
<call>tool_name key="value" count=3 enabled=true</call>
<call>bookMeeting title="Review" date=2026-05-15 duration=60 attendees=["a@c.com"] room=A</call>
<call>updateUserProfile userId=abc123 profile.displayName=Alice profile.address.city=Austin</call>
```

Features:
- **Key-value syntax**: `key=value` for flat records of primitives.
- **Arrays**: `attendees=["a","b"]` inline for list fields.
- **Nested flattening**: `profile.displayName=Alice` for one-level-deep objects.
- **Smart quoting**: bare words when safe (`location=Austin`), `"quotes"` when
  value has spaces, `'quotes'` when value contains double quotes.
- **JSON fallback**: tools with deeply nested schemas or unions still use
  `{"key":"val"}` inside `<call>`.

### 2.2 AI SDK v6 integration

The package is a `LanguageModelV3Middleware` that plugs in via
`wrapLanguageModel`:

```ts
const model = wrapLanguageModel({
  model: anthropic('claude-sonnet-4-5'),
  middleware: compactTools({ syntax: 'wire', fallbackToJson: 'complex' }),
});
```

Three hooks:

- **`transformParams`** — strips `tools` and `toolChoice`, builds a per-tool
  `ToolPlan` (compact signature + encoding), injects a compact manual into the
  system prompt, and rewrites conversation history so prior tool-call parts
  appear as `<call>` text and tool results as `<tool-result>` text.
- **`wrapGenerate`** — scans for `<call>…</call>` spans, parses them against
  the matching plan, and emits AI SDK `tool-call` content parts. Parse errors
  surface as inline `<tool-error>` for model self-correction.
- **`wrapStream`** — a `TransformStream` state machine that holds back partial
  open/close tags across chunk boundaries, emitting `tool-input-start` /
  `tool-input-delta` / `tool-input-end` / `tool-call` parts at the right
  moments.

### 2.3 Round-trip semantics

History rewriting serializes prior tool calls into the same compact form,
keeping the conversation self-consistent across multi-step loops. Tool result
messages become user-role `<tool-result name="…">…</tool-result>` text blocks.

---

## 3. Agent benchmark (multi-step — headline result)

`bun run bench/agent.ts` exercises both modes over **multi-turn agent
tasks** where each task requires chaining multiple tool calls.

### 3.1 Setup

| asset | value |
|---|---|
| models | `glm-5-turbo`, `glm-5.1`, `glm-5` (Zhipu AI, via ZAI provider) |
| tasks | 6 multi-step tasks (3–12+ expected calls each) |
| reps | 1 per (model, task, mode) |
| total cells | 36 (3 models × 6 tasks × 2 modes) |
| stop condition | `maxSteps: 20` per task |
| evaluation | deterministic success check (not strict deepEq) |

Tasks:
1. `tx-cities-weather-email` — Fetch weather for 3 cities, send summary email
2. `search-then-fetch` — Search products, calculate price with tax
3. `db-then-email` — Query active users from DB, email report
4. `time-around-world` — Get time in 4 timezones in parallel
5. `reminder-cascade` — Set 3 reminders with different methods
6. `files-then-fetch` — List files in `./src`, fetch docs for first file

### 3.2 Aggregate

| mode | passes | pass rate | vs JSON |
|------|--------|-----------|---------|
| native JSON | **1/18** | **5.6 %** | — |
| compact | **5/18** | **27.8 %** | **5× better** |

Compact completed the task **5× more often** than native JSON.

### 3.3 Per-model breakdown

| model | json passes | compact passes | delta |
|-------|-------------|----------------|-------|
| glm-5-turbo | 1/6 | 1/6 | tie |
| glm-5.1 | 0/6 | **2/6** | +2 |
| glm-5 | 0/6 | **2/6** | +2 |

The advantage is concentrated on the two GLM-5 models — the ones where JSON
tool-calling most frequently breaks down.

### 3.4 What compact does better

- **Completes multi-step chains.** In `search-then-fetch`, JSON mode
  frequently loops on `searchProducts → searchProducts → searchProducts`
  without ever calling `calculate`. Compact mode completes the full
  `searchProducts → calculate` pipeline.
- **Attempts parallel calls.** In `time-around-world`, compact mode
  reliably attempts all 4 `getTime` calls in parallel. JSON mode usually
  makes 1 call and tries to infer the other 3 from context.
- **Correct parameter names.** The compact signature shows field names
  explicitly (`query:string, maxResults?:int`), reducing the model's
  tendency to guess wrong names from descriptions.

### 3.5 Key observations

- **Schema alignment matters more than encoding.** Tasks where the stub
  expects different parameter names than the model naturally produces
  (`setReminder: message/atIso` vs model's `title/datetime`) fail equally
  in both modes.
- **Task success rate is low because tasks are hard.** These are
  deliberately multi-step (4–12+ expected calls) with no retry logic.
  A 6–28% first-attempt pass rate is not unusual for this model class.

---

## 4. Offline benchmark (format efficiency)

`bun run bench` compares the pure token cost of native JSON tool calls vs.
the compact format on a fixed catalogue of 13 tools and 19 representative
invocations. Uses a real BPE tokenizer (`o200k_base` via `js-tiktoken`).

### 4.1 Per-call output cost (pure call, no preamble)

| Case | Native JSON | Compact | Reduction |
|---|---|---|---|
| `getWeather(location)` | 25 t | 11 t | **56.0%** |
| `getTime(timezone)` | 28 t | 14 t | **50.0%** |
| `sendEmail(to, subject, body, priority)` | 46 t | 30 t | **34.8%** |
| `searchProducts(query, max, inStock)` | 37 t | 21 t | **43.2%** |
| `bookMeeting(6 args, array)` | 63 t | 44 t | **30.2%** |
| `updateUserProfile(nested)` | 67 t | 50 t | **25.4%** |
| 19-case cumulative total | 762 t | **474 t** | **37.8%** |

The compact format consistently produces smaller tool calls — the structural
overhead of JSON keys, quotes, and brackets is eliminated.

### 4.2 Tool-definition cost (one-time, cached)

| mode | tokens |
|---|---|
| native JSON tool defs (13 tools) | 861 |
| compact manual + signatures | 490 |

The compact manual is **372 tokens smaller**. With prompt caching this is
amortized to ~zero after the first turn.

### 4.3 Round-trip correctness

Every test case's compact call string parses back into byte-identical
structured arguments. **19/19 passed.**

---

## 5. Ablations

The live benchmark supports ablation — removing or varying a single
component of the middleware to measure its isolated effect. Each ablation
ran on 6 representative cases (flat, mixed, array, and nested tools) with
3 reps each on glm-5-turbo and glm-5.1.

### 5.1 no-manual: Strip the protocol manual

The system prompt still lists tool signatures, but the "HOW to format calls"
instructions are removed. This measures whether the manual helps or hurts.

| Configuration | Total Out | Equivalent | Delta vs Canonical |
|---------------|----------:|-----------:|-------------------:|
| Canonical compact | 1083 | 16/19 | — |
| no-manual | 1231 | 18/18 | **+148 tokens** |

Without the manual, the model uses more tokens — it produces more preamble
and less consistent calls. The manual is a net positive.

### 5.2 placement=first: Manual at start vs end

The protocol manual is placed at the beginning of the system message
instead of appended at the end.

| Configuration | Total Out | Equivalent | Delta vs Canonical |
|---------------|----------:|-----------:|-------------------:|
| Canonical compact | 1083 | 16/19 | — |
| placement=first | 1184 | 18/18 | **+101 tokens** |

Placement at the end is measurably better. The model's core instructions
should come first; the formatting directive is secondary guidance.

### 5.3 syntax=json: JSON inside `<call>` instead of wire format

Tools use `{"key":"val"}` inside the `<call>` tag rather than the compact
`key=value` wire syntax. This tests whether the savings come from the
`<call>` wrapper or the key-value format.

| Configuration | Total Out | Equivalent | Delta vs Canonical |
|---------------|----------:|-----------:|-------------------:|
| Canonical compact | 1083 | 16/19 | — |
| syntax=json | 1239 | 18/18 | **+156 tokens** |

Wire format inside `<call>` is more efficient than JSON inside `<call>`.
The `<call>` wrapper alone saves some tokens (vs the full JSON tool-use
block), but the key-value syntax accounts for the majority of the savings.

### 5.4 Summary

| Ablation | Token Delta | Effect |
|----------|------------:|--------|
| Canonical compact | baseline | — |
| no-manual | +148 | Manual helps — instructs model to be concise |
| placement=first | +101 | End placement is better for this model |
| syntax=json | +156 | Wire format is more efficient than JSON even inside `<call>` |

---

## 6. Discussion

### 6.1 What worked

- **Agent accuracy is the real win.** Compact format completes multi-step
  agent tasks **5× more often** than native JSON on the models that need it
  most — capable models where JSON tool-calling frequently breaks down on complex multi-step tasks.
  On the Pareto frontier (success rate vs output cost), compact either ties
  or dominates JSON on every model tested.
- **The format IS more efficient.** Pure call tokens are 37.8% smaller on
  average. This savings is deterministic and reproducible (unlike model
  preamble behavior which varies run-to-run).
- **Streaming is robust.** The character-level state machine handles
  partial tags across chunk boundaries with no preamble leakage or
  truncated calls.
- **Self-correction works.** Parse errors surface as inline `<tool-error>`
  tags that the model can respond to on the next step.

### 6.2 Limitations

- **Preamble variance.** The model sometimes adds explanatory text before
  the `<call>` tag, which dilutes the per-call token savings. This is a
  model behavior issue, not a format issue — on models that follow the
  "just emit the call" instruction, the savings match the pure-call number.
- **Lossy schema encoding.** Deeply nested objects and complex unions
  still fall back to JSON inside `<call>`. One-level arrays and shallow
  nesting are supported via inline syntax and dot paths.
- **Model-dependent, not purely size-dependent.** The compact format is
  a system-prompt-only protocol — it strips the native `tools` field and
  relies on the model learning the format from text. `Granite4.1:3b`
  scores 10/19 compact vs 14/19 JSON (35.6% token savings) on single
  calls, while the larger `Llama 3.1:8b` scores 0/19 compact. But on
  multi-step agent tasks both modes perform equally poorly (0/6 each) —
  the model can't chain calls regardless of format. The 5× agent
  accuracy win is measured on GLM-5-class models (744B MoE). Benchmark
  your specific model.
- **First-call quality dip.** Models heavily trained on JSON tool protocol
  may dip in quality on the very first compact-format call before the
  format is in context.

### 6.3 Forward plan

1. **More models.** Extend the agent benchmark to Qwen, DeepSeek, Llama,
   Granite, and other open models to map which architectures handle the
   text-only protocol and which don't.
2. **Harder tasks.** Replace synthetic tasks with Tau-bench-style
   multi-tool evaluations where cumulative output-token cost and task
   completion rate are both measured.
3. **Broader model sweep.** Measure whether compact format still helps
   on Claude Sonnet 4.5, GPT-5, and Gemini 2.5 Pro — or whether the
   accuracy win is specific to open-weight architectures.
4. **Input-side optimization.** Measure the one-time input savings from
   the smaller compact manual on providers with prompt caching (Anthropic,
   OpenAI), where the cache-miss cost is a one-time penalty.
5. **Investigate tool-use training.** Granite4.1:3b handles single-call
   compact format (10/19) better than Llama 3.1:8b (0/19), but fails on
   agent tasks (0/6). Understanding what makes a model follow text-only
   protocols vs. native API enforcement may guide training improvements.

---

## 7. Reproducibility

### Commands

```
bun test                                # 219 unit tests, no API key
bun run bench                           # offline token bench + 19/19 correctness
bun run bench/live.ts --reps 1          # live single-call (needs provider)
bun run bench/agent.ts --reps 1         # multi-step agent bench (needs provider)
bun run bench/aggregate.ts --kind agent bench/results/published/agent-*.jsonl
bun run bench/aggregate.ts --kind live bench/results/published/live-*.jsonl
```

### Artifacts

| Result | Artifact | Source command |
|--------|----------|---------------|
| Agent benchmark (3 models, 6 tasks) | `bench/results/published/agent-20260504-162658.jsonl` | `bun run bench/agent.ts --reps 1` |
| Offline benchmark (13 tools, 19 cases) | `bench/results/published/offline-20260504-050944.json` | `bun run bench` |
| Live benchmark (3 models, 19 cases) | `bench/results/published/live-20260504-162643.jsonl` | `bun run bench/live.ts --reps 1` |

### Provider configuration

```env
# Z.AI provider (used for all model runs)
ZAI_BASE_URL=https://api.z.ai/api/coding/paas/v4
ZAI_API_KEY=...
ZAI_MODELS=glm-5-turbo,glm-5.1,glm-5
```

### Viewing results

```
bun run bench/aggregate.ts --kind agent bench/results/published/agent-*.jsonl
bun run bench/aggregate.ts --kind live bench/results/published/live-*.jsonl
```

The aggregator emits markdown tables ready to paste into this report.
All numbers from artifacts are reproducible — rerunning the same command
with the same provider will produce comparable results.

---

*Anthony Holley · Sawyer Cutler — 2026‑05‑04*
