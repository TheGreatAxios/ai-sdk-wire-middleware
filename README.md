# ai-sdk-wire-middleware

> Better tool calling for frontier open-weight models on complex multi-step agents.  
> Replaces verbose JSON `tool_use` blocks with a concise `<call>name k=v</call>` wire format that even SOTA models handle more reliably on multi-turn agent tasks.

[![npm](https://img.shields.io/npm/v/ai-sdk-wire-middleware)](https://www.npmjs.com/package/ai-sdk-wire-middleware)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

```ts
import { wrapLanguageModel, generateText, tool } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { compactTools } from 'ai-sdk-wire-middleware';
import { z } from 'zod';

const model = wrapLanguageModel({
  model: anthropic('claude-sonnet-4-5'),
  middleware: compactTools(), // ← that's it
});

const result = await generateText({
  model,
  tools: {
    getWeather: tool({
      description: 'Get the weather for a city',
      inputSchema: z.object({
        location: z.string(),
        units: z.enum(['metric', 'imperial']).optional(),
      }),
      execute: async ({ location, units }) =>
        `72°${units === 'metric' ? 'C' : 'F'} in ${location}`,
    }),
  },
  prompt: 'What is the weather in Austin in metric units?',
});
```

The model emits:

```
<call>getWeather location="Austin" units=metric</call>
```

Instead of:

```json
{"type":"tool_use","id":"toolu_01ABCDEFG","name":"getWeather","input":{"location":"Austin","units":"metric"}}
```

The middleware parses the compact format back into real `tool-call` content parts, so the AI SDK's tool-execution loop, `stopWhen`, `onStepFinish`, and `streamText` UI streaming all work exactly as if the model had used native function calling.

---

## Why?

Even frontier open-weight models struggle with the verbose JSON tool-calling protocol on multi-turn agent tasks. On tasks requiring chained tool calls toward a goal, the compact format **substantially improves task completion** by reducing the structural overhead of each call.

### Primary benefit: complex agent accuracy

In a multi-model, multi-task agent benchmark (6 tasks requiring 3–12+ chained tool calls), compact consistently outperformed native JSON:

| Metric | Native JSON | Compact |
|--------|-------------|---------|
| Task success rate | **1/18** | **5/18** |
| Models tested | glm-5, glm-5.1, glm-5-turbo | same |

Compact models were more likely to:
- **Complete full multi-step chains** — `searchProducts → calculate` instead of looping `searchProducts → searchProducts → searchProducts`
- **Attempt all required parallel calls** — 4 parallel `getTime` calls instead of 1
- **Use correct parameter names** from the wire format signature instead of guessing from descriptions
- **Recover from errors** — parse errors surface as inline `<tool-error>` that the model can self-correct

### Secondary benefit: token efficiency

The compact call syntax is inherently smaller — **37.8% fewer tokens on the tool-call itself** (measured offline, pure call vs pure call):

| Case | Native JSON | Compact | Reduction |
|---|---|---|---|
| `getWeather(location)` | 25 t | 11 t | **56.0%** |
| `getTime(timezone)` | 28 t | 14 t | **50.0%** |
| `sendEmail(to, subject, body, priority)` | 46 t | 30 t | **34.8%** |
| `searchProducts(query, max, inStock)` | 37 t | 21 t | **43.2%** |
| `bookMeeting(title, date, duration, attendees, room)` | 63 t | 44 t | **30.2%** |
| `updateUserProfile(userId, profile[...])` | 67 t | 50 t | **25.4%** |
| 19-case full bench (13 tools) | 762 t | 474 t | **37.8%** |

System-prompt overhead also flips in your favor as the tool catalogue grows: with 13 tools the compact manual is **372 tokens smaller** than the equivalent JSON tool-def block (861 → 490).

> `bun run bench` to reproduce locally. Numbers use a real BPE tokenizer (`o200k_base`) via `js-tiktoken`.

---

## Install

```sh
bun add ai-sdk-wire-middleware
# or
npm i ai-sdk-wire-middleware
```

**Peer dependencies:** `ai@^6`, `@ai-sdk/provider@^3`, `zod@^3 || ^4`.

---

## API

### `compactTools(options?)`

Returns a `LanguageModelV3Middleware` you pass to `wrapLanguageModel`.

```ts
compactTools({
  syntax: 'wire',            // 'wire' | 'json'   (default 'wire')
  fallbackToJson: 'complex', // 'complex' | 'error' | 'force'
  placement: 'last',         // 'first' | 'last'
  manualHeader: undefined,   // override the manual injected into the system prompt
  debug: false,
});
```

#### Wire formats

| `syntax` | Output |
|---|---|
| `wire` (default) | `<call>getWeather location="New York" units=metric</call>` |
| `json` | `<call>getWeather {"location":"New York","units":"metric"}</call>` |

`wire` is the most readable for the model, supports optional fields cleanly, and is fully whitespace-tolerant.

#### `fallbackToJson`

Tools whose input schema is **not** a flat record of primitives (nested objects, arrays, anyOf unions) can't be expressed in `wire` syntax. By default (`'complex'`) those tools fall back to `json` encoding while flat tools keep using `wire`. Use `'error'` to fail loudly, or `'force'` to flatten everything (not recommended).

---

## How it works

```
╭───────────────────╮  transformParams       ╭──────────────────────────╮
│  generateText /   │───────────────────────▶│  - drop `tools`           │
│  streamText       │                        │  - inject manual + sigs  │
│  (your code)      │                        │  - rewrite history        │
╰────────┬──────────╯                        ╰─────────────┬────────────╯
         ▲                                                 ▼
         │                                       ╭───────────────────╮
         │  synthetic `tool-call` parts          │  upstream model   │
         │                                       │  (text response)  │
         │      wrapStream / wrapGenerate         ╰─────────┬────────╯
         ╰─────────── parser ◀────────────────────────────────╯
```

1. **`transformParams`** strips `tools` and `toolChoice` from the request. Each tool's JSON Schema is rendered as a one-line signature (e.g. `getWeather: location:string, units?:"metric"|"imperial" — Get the weather`) and appended to the system message. Assistant `tool-call` parts in the conversation history are re-serialized as compact text so the model sees a self-consistent transcript. `tool` messages become user-role text. The original tool plans are stashed in `providerOptions.toolReduce` for the wrap hooks.

2. **`wrapGenerate`** scans the model's text content for `<call>…</call>` spans, splits each `text` part into `text + tool-call + text`, and rewrites `finishReason` to `tool-calls` if any call was emitted.

3. **`wrapStream`** runs a streaming state machine that holds back partial open/close tags across chunk boundaries, emits `tool-input-start` / `tool-input-delta` / `tool-input-end` / `tool-call` parts at the right moments, and re-frames `text-start` / `text-end` cleanly around each call.

---

## Caveats

- **Big-model quality dip on first calls.** GPT-5 and Sonnet 4.5 are heavily trained on the JSON tool protocol. They follow the compact format from a system prompt reliably, but expect a small accuracy hit on the very first call of a session before the format is in context. Benchmark on your task before claiming a Pareto win.
- **Schema → signature is lossy.** Nested objects, arrays, and unions can't be expressed in `wire` syntax. Those tools fall back to JSON inside `<call>`. If your toolset is mostly nested, you'll save very little.
- **No `responseFormat` shenanigans.** The middleware does not force JSON mode for `toolChoice: required`. If you need hard tool-choice enforcement, use the native protocol (don't wrap that call).
- **Output tokens > input tokens.** The system-prompt manual is ~468 tokens (13 tools); the per-call savings are ~10–20 tokens. With prompt caching the manual amortizes to ~zero quickly. Without caching, you need >~25 tool calls per session to break even.

---

## Benchmarks

### Offline (no API key)

```sh
bun run bench
```

Runs against a deterministic mock model and reports:

- Token cost of native JSON tool defs vs. compact system prompt
- Per-call output cost across **13 tools / 19 representative cases** (flat tools like `getWeather`, `getTime`, `toggleFeature`, mixed-type tools like `searchProducts`, `sendEmail`, and complex tools like `bookMeeting`, `updateUserProfile` that use inline arrays and dot-path nesting)
- Round-trip correctness — every test case must parse back into the same JSON `input` the native protocol would have produced

### Live (real LLM via OpenRouter or any OpenAI-compatible provider)

```sh
cp .env.example .env
# edit .env and put your OPENROUTER_API_KEY (free at https://openrouter.ai/keys)
bun run bench:live
```

The live benchmark:

1. Calls a real model once per case in **JSON mode** (no middleware) and once in **compact mode** (with `compactTools()`).
2. Reports actual `inputTokens` / `outputTokens` from the provider, latency, and whether the emitted `tool-call` matches the ground-truth invocation (via LLM judge).
3. Supports OpenRouter and any OpenAI-compatible provider (Z.AI, Together, Groq, etc.). Set `ZAI_BASE_URL`, `ZAI_API_KEY`, and `ZAI_MODEL` to skip OpenRouter.
4. Supports ablation studies via `--ablation` flags (e.g. `syntax=json`, `no-manual`, `placement=first`).
5. Defaults to 3 reps per cell. Override:

   ```sh
   bun run bench:live --models minimax/minimax-m2.5:free --reps 1 --cases 'getWeather (1 required),getTime'
   ```

Other good free models to try: `qwen/qwen3-coder:free`, `meta-llama/llama-3.3-70b-instruct:free`, `deepseek/deepseek-chat-v3.1:free`, `google/gemini-2.0-flash-exp:free`.

---

## Tests

```sh
bun test
```

219 tests cover the parser, signature compiler, transform-params, wrap-generate, wrap-stream (including character-level streaming and split-tag handling), history rewriting, serialization, artifact I/O, and edge cases (unicode, internal quotes, long SQL, nested schemas, multiple calls).

---

## License

MIT — see [LICENSE](LICENSE).

Copyright (c) 2025 [Sawyer Cutler](https://github.com/thegreataxios) & Anthony Holley
