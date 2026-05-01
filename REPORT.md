# tool-reduce: A Compact Wire Format for LLM Tool Calling

**Authors:** Anthony Holley, Sawyer Cutler
**Status:** Working note · 2026‑05‑01
**Repository:** `tool-reduce` (Vercel AI SDK v6 middleware)

---

## 1. Motivation

Tool-calling on modern LLMs is paid for twice. The tool *catalogue* — every
function's name, description, and JSON Schema — is sent on every request as
part of the system block, and although providers like Anthropic and OpenAI
let it ride on prompt cache after the first turn, every *invocation* the
model emits (`{"name":"…","arguments":{…}}`) is generated fresh each step
and billed at output rates. For agent loops that take dozens of steps the
output-side overhead dominates.

The original observation came from a Twitter exchange about how much of
each tool call is structural noise — quoting, brackets, and key repetition
— rather than the small set of actual argument values the model needs to
emit. `tool-reduce` is a small experiment in stripping that noise: replace
the JSON tool-calling protocol with a one-line, shell-flavoured envelope
the model can produce in fewer tokens, parse it back into the AI SDK's
native `tool-call` content parts, and measure the difference.

## 2. Method

### 2.1 Wire format

```
<call>tool_name key="value" count=3 enabled=true</call>
```

Three encodings are supported per tool:

| encoding | example | when used |
| --- | --- | --- |
| `shell` (default) | `<call>getWeather location="Austin" units=metric</call>` | flat record of primitives |
| `csv` | `<call>getWeather "Austin", metric</call>` | positional, smallest for fixed schemas |
| `json` | `<call>createUser {"profile":{"name":"alice"}}</call>` | automatic fallback for nested schemas |

A schema is considered "flat" iff it is `{ type: "object", properties: {…} }`
where every property is a primitive (`string`, `number`, `integer`,
`boolean`) or a string/number/boolean enum. Any tool that fails this check
is automatically encoded as `json` (`fallbackToJson: 'complex'`, default);
`'error'` and `'force'` are also offered.

### 2.2 AI SDK v6 integration

The package is a `LanguageModelV3Middleware` that plugs in via
`wrapLanguageModel`:

```ts
const model = wrapLanguageModel({
  model: anthropic('claude-sonnet-4-5'),
  middleware: compactTools({ syntax: 'shell', fallbackToJson: 'complex' }),
});
```

It implements three hooks:

- **`transformParams`** — strips `tools` and `toolChoice` from the request,
  builds a per-tool `ToolPlan` (signature + encoding), generates a compact
  manual + tool catalogue, injects it into the system prompt, and rewrites
  the conversation history so prior assistant `tool-call` parts and
  `tool-result` messages are presented to the model as `<call>` /
  `<tool-result>` text. The plans are stashed on `providerOptions` for the
  generate / stream hooks.
- **`wrapGenerate`** — finds every `<call>…</call>` span in the model's
  text content, parses it against the matching plan, and emits AI SDK
  `tool-call` content parts. Surrounding text is preserved; parse errors
  are surfaced as inline `<tool-error>` text so the model can self-correct
  on the next step.
- **`wrapStream`** — a small `TransformStream` state machine that holds
  back partial open/close tags (`<ca…`, `</cal…`), emits
  `tool-input-start` / `tool-input-delta` / `tool-input-end` parts as the
  body streams in, and finalizes a `tool-call` part on `</call>`.

### 2.3 Round-trip semantics

Because the model never sees its own JSON tool calls back, history rewriting
serializes any `tool-call` part in the prompt into the same compact form it
would have emitted, and tool-result messages become user-role
`<tool-result name="…">…</tool-result>` text blocks. This keeps the
transcript self-consistent across multi-step loops.

## 3. Offline benchmark

`bun run bench` compares native JSON tool calling against the compact
protocol on a fixed catalogue of 9 tools (single-arg through 4-arg, mixed
primitive types) and 10 representative invocations.

Token counts use a coarse 4‑chars‑per‑token heuristic, which matches
`tiktoken` to within ~10% in our spot checks. Because we only compare two
encodings of the same content, the ratio is stable.

### 3.1 Tool-definition cost (cached, paid on cache miss)

| mode | tokens |
| --- | --- |
| native JSON tool defs | ≈ 396 |
| compact system prompt | ≈ 380 |

The crossover where the compact manual becomes net-cheaper than the JSON
tool block sits around 6 tools for our schemas. Below that, the compact
manual's protocol-explanation header dominates.

### 3.2 Per-call output cost (paid every step, never cached)

Across the 10 cases the compact form averages **~45% fewer output
tokens** than native JSON, with the largest reductions on multi-arg calls
where `{"key":"value"}` overhead compounds.

### 3.3 Round-trip correctness

A scripted mock model returns the expected `<call>` text for each case;
the middleware then parses it back into a `tool-call` content part and we
deep-compare against the expected arguments. Result: **10 / 10** cases
parse to byte-identical structured arguments.

## 4. Live benchmark

`bun run bench/live.ts` runs each case twice through the AI SDK's
`generateText` against a real OpenRouter model — once unwrapped (JSON tool
calling) and once wrapped with `compactTools()`. We capture `usage.inputTokens`,
`usage.outputTokens`, latency, and the emitted tool call.

Configuration:

- model: `minimax/minimax-m2.5:free`
- 10 cases, `temperature: 0`, `stopWhen: ({ steps }) => steps.length >= 1`
- one shot per case, no retries

### 4.1 Aggregate

| mode    | calls | strict matches | total in | total out | mean latency |
| ------- | ----- | -------------- | -------- | --------- | ------------ |
| json    | 10    | 8 / 10         | 10 898   | 803       | 34 183 ms    |
| compact | 10    | 9 / 10         |  4 308   | 654       | 31 438 ms    |

- **Output-token reduction:** 803 → 654 = **−149 tokens (−18.6%)**.
- **Input-token delta:** 10 898 → 4 308 = **−6 590 tokens (−60.5%)**,
  because the JSON `function`-tool block is replaced by the much smaller
  compact manual.
- **Strict match rate:** 8 → 9 (compact wins).

The output-side reduction is materially smaller in the live run than in
the offline projection. Two reasons: (a) live models pad calls with
quoting and whitespace beyond the minimal form; (b) the offline bench
uses the *expected* compact string verbatim, while live models occasionally
choose more verbose phrasings (e.g. quoting numerics).

### 4.2 Strict-match misses are equivalence-class differences

The two strict-match misses are not parsing failures:

| case | expected | got | mode |
| --- | --- | --- | --- |
| `getWeather (1 required)` | `{"location":"Austin"}` | `{"location":"Austin, TX"}` | json |
| `askDb` | `{"sql":"SELECT … active = true","limit":100}` | `{"sql":"SELECT … active = true;","limit":100}` | json |
| `askDb` | `{"sql":"SELECT … active = true","limit":100}` | `{"sql":"SELECT … active = true LIMIT 100"}` | compact |

These are model-judgement variations: city qualification, trailing
punctuation, and folding the `LIMIT` argument into the SQL string instead
of using the dedicated parameter. None of them indicate that the wire
protocol was misparsed — they would be flagged as failures under any
strict `deepEq`, regardless of encoding.

To stop these from dominating headline numbers, we added a soft matcher
to `bench/live.ts` (`softMatchArgs`) that accepts:

- whitespace-normalized, case-insensitive equality with stripped trailing
  punctuation,
- superset/subset string containment ("Austin" ⊆ "Austin, TX"),
- `5` / `"5"` numeric-string slips,
- a numeric expected arg appearing folded into a sibling string field.

Under soft matching, both modes reach **10 / 10** on this run, so the
relevant comparison is the **+1 strict-match advantage** the compact
mode captured by avoiding the city-qualification expansion (the model
emitted `<call>getWeather location="Austin"</call>` faithfully) and the
**−18.6% output-token / −60% input-token** reductions.

### 4.3 Latency

Mean latencies are 34.2 s vs 31.4 s, but two outliers dominate the
distribution: `compact:getWeather (147 s)` and `json:calculate (170 s)`.
Both happened on the free tier and almost certainly reflect cold-start /
queue time, not work done. With outliers removed both modes cluster
around 8–15 s for a single tool-calling step. Latency is not the headline
result of this benchmark and we make no claim about it.

## 5. Discussion

### 5.1 What worked

- The compact format **does** reduce output tokens at materially the same
  match rate as JSON on a real model, even an inexpensive free-tier one.
- Replacing the JSON tool block with the compact manual is a one-time
  input-side win that compounds on prompt caching: the cache footprint
  is smaller and any cache miss is cheaper.
- Streaming integration was the most fragile piece and required a
  state machine that holds back partial `<call>` and `</call>` prefixes
  across chunk boundaries; we cover this with character-level and
  split-tag tests in `tests/middleware-extra.test.ts`.

### 5.2 Limitations

- **Lossy schema flattening.** Anything that isn't a flat record of
  primitives or string-enums falls back to JSON. We don't currently
  attempt to flatten one-level-deep nested objects with dotted keys, and
  arrays of primitives are encoded as JSON. Both are obvious extensions.
- **Equivalence-class scoring.** Strict `deepEq` is too strict for
  tool-call evaluation in general. The `softMatchArgs` in the live bench
  is a pragmatic stop-gap; a serious eval should use either a domain
  schema-aware matcher or an LLM-judge.
- **Latency variance.** The free-tier outliers (147 s, 170 s) make
  per-call timings unreliable on this model. A paid model at moderate
  concurrency would give a much cleaner latency story.
- **Single-step measurement.** We only measure one tool call per case
  here. The whole point of compacting outputs is multi-step agent loops
  where reductions stack — that's where the gap matters most.
- **Context contamination.** The compact manual nudges every model in
  the same direction. We have not measured whether a frontier model that
  natively prefers JSON tool calling pays a quality tax for being
  diverted to the compact format.

### 5.3 Forward plan

1. **Tau-bench style task suite.** Replace the synthetic 10-case
   catalogue with multi-turn, multi-tool agent tasks where the
   *cumulative* output-token cost is the relevant metric.
2. **LLM-judge evaluation.** Replace strict `deepEq` with a small judge
   that scores semantic match (location ≡ city; SQL with/without
   trailing `;`) so the headline match-rate isn't gated on phrasing.
3. **Anthropic prompt-caching integration test.** Run the same workload
   with cache-control breakpoints set on the compact manual and confirm
   the input-side savings persist across turns.
4. **Multi-step agent benchmark.** Run an actual `stopWhen: ({ steps }) =>
   steps.length >= N` loop on a tool-heavy workflow (search → fetch →
   summarize → cite), where the compact format's per-step output
   reduction compounds across N tool calls.
5. **Frontier model sweep.** Repeat the live bench on Claude Sonnet 4.5,
   GPT‑5 family, and a strong open model to measure whether the match-rate
   delta holds when the underlying model is more capable.

## 6. Reproducibility

- `bun test` — 129 unit tests across parser, signature, middleware
  (generate + stream), history rewriting, and round-trip serialization.
- `bun run bench` — offline token + correctness benchmark with a
  deterministic mock model.
- `OPENROUTER_API_KEY=… bun run bench/live.ts` — live benchmark; defaults
  to `minimax/minimax-m2.5:free`. Override with `OPENROUTER_MODEL=…`.

The numbers in §4 are the unedited output of one live run on
2026‑05‑01. They will move with model updates and free-tier load; the
relative comparisons are what matters.

---

*Anthony Holley · Sawyer Cutler — 2026‑05‑01*
