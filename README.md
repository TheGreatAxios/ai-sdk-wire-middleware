# ai-sdk-wire-middleware

> Compact-syntax tool calling for the [Vercel AI SDK v6](https://ai-sdk.dev). Drops tool-call **output tokens by ~40–60%** on agent loops by replacing JSON `tool_use` blocks with a one-line `<call>name k=v</call>` wire format — while keeping `streamText`/`generateText`/multi-step tool execution working unchanged.

```ts
import { wrapLanguageModel, generateText, tool } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { compactTools } from 'ai-sdk-wire-middleware';
import { z } from 'zod';

const model = wrapLanguageModel({
  model: anthropic('claude-sonnet-4-5'),
  middleware: compactTools(),  // ← that's it
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
      execute: async ({ location, units }) => `72°${units === 'metric' ? 'C' : 'F'} in ${location}`,
    }),
  },
  prompt: 'What is the weather in Austin in metric units?',
});
```

The model emits

```
<call>getWeather location="Austin" units=metric</call>
```

instead of

```json
{"type":"tool_use","id":"toolu_01ABCDEFG","name":"getWeather","input":{"location":"Austin","units":"metric"}}
```

The middleware parses it back into a real `tool-call` content part, so the AI SDK's tool-execution loop, `stopWhen`, `onStepFinish`, and `streamText` UI streaming all work exactly as if the model had used native function calling.

## Why

Per-step output tokens are **not** cached. Every step of an agent loop pays the full cost of re-emitting the tool-call envelope. The Vercel/Anthropic/OpenAI JSON shape is verbose:

| Case | Native JSON | Compact | Reduction |
|---|---|---|---|
| `getWeather(location)` | 23 t | 11 t | **2.09×** |
| `getTime(timezone)` | 24 t | 11 t | **2.18×** |
| `webFetch(url)` | 25 t | 12 t | **2.08×** |
| `sendEmail(to, subject, body, priority)` | 40 t | 25 t | **1.60×** |
| `searchProducts(query, max, inStock)` | 36 t | 23 t | **1.57×** |
| 10-step agent loop (full bench) | 296 t | 163 t | **44.9%** |

System-prompt overhead also flips in your favor as the tool catalogue grows: with 9 tools the compact manual is **177 tokens smaller** than the equivalent JSON tool-def block.

(`bun run bench` to reproduce. Numbers are 4-char-per-token estimates; actual savings track within ~10%.)

The system-prompt manual (~260 tokens) is a one-time cost that the provider's prompt cache will cover after the first call.

## Install

```sh
bun add ai-sdk-wire-middleware
# or
npm i ai-sdk-wire-middleware
```

Peer deps: `ai@^6`, `@ai-sdk/provider@^3`, `zod@^3 || ^4`.

## API

### `compactTools(options?)`

Returns a `LanguageModelV3Middleware` you can pass to `wrapLanguageModel`.

```ts
compactTools({
  syntax: 'shell',           // 'shell' | 'csv' | 'json'   (default 'shell')
  fallbackToJson: 'complex', // 'complex' | 'error' | 'force'
  placement: 'last',         // 'first' | 'last'
  manualHeader: undefined,   // override the manual injected into the system prompt
  debug: false,
});
```

#### Wire formats

| `syntax` | Output |
|---|---|
| `shell` (default) | `<call>getWeather location="New York" units=metric</call>` |
| `csv` | `<call>getWeather "New York", metric</call>` (positional) |
| `json` | `<call>getWeather {"location":"New York","units":"metric"}</call>` |

`shell` is the most readable for the model, supports optional fields cleanly, and is fully whitespace-tolerant. `csv` is the most token-efficient when every field is required and primitive.

#### `fallbackToJson`

Tools whose input schema is **not** a flat record of primitives (i.e. nested objects, arrays, or anyOf unions) can't be expressed in `shell`/`csv` syntax. By default (`'complex'`) those individual tools fall back to `json` encoding while flat tools keep using `shell`. Use `'error'` to fail loudly, or `'force'` if you really want to flatten.

## How it works

```diagram
╭───────────────────╮  transformParams       ╭──────────────────────────╮
│  generateText /   │───────────────────────▶│  - drop `tools`           │
│  streamText       │                        │  - inject manual + sigs   │
│  (your code)      │                        │  - rewrite history        │
╰────────┬──────────╯                        ╰─────────────┬────────────╯
         ▲                                                 ▼
         │                                       ╭───────────────────╮
         │  synthetic `tool-call` parts          │  upstream model   │
         │                                       │  (text response)  │
         │      wrapStream / wrapGenerate         ╰─────────┬────────╯
         ╰─────────── parser ◀────────────────────────────────╯
```

1. `transformParams` strips `tools` and `toolChoice` from the request. Each tool's JSON Schema is rendered as a one-line signature (e.g. `getWeather: location:string, units?:"metric"|"imperial" — Get the weather`) and appended to the system message. Assistant `tool-call` parts in the conversation history are re-serialized as compact text so the model sees a self-consistent transcript. `tool` messages become user-role text. The original tool plans are stashed in `providerOptions.toolReduce` for the wrap hooks.
2. `wrapGenerate` scans the model's text content for `<call>…</call>` spans, splits each `text` part into `text + tool-call + text`, and rewrites `finishReason` to `tool-calls` if any call was emitted.
3. `wrapStream` runs a streaming state machine that holds back partial open/close tags across chunk boundaries, emits `tool-input-start` / `tool-input-delta` / `tool-input-end` / `tool-call` parts at the right moments, and re-frames `text-start` / `text-end` cleanly around each call.

## Caveats

- **Big-model quality dip on first calls.** GPT-5/Sonnet 4.5 are heavily trained on the JSON tool protocol. They follow the compact format from a system prompt reliably, but expect a small accuracy hit on the very first call of a session before the format is in context. Benchmark on your task before claiming a Pareto win.
- **Schema → signature is lossy.** Nested objects, arrays, and unions can't be expressed in `shell`/`csv` syntax. Those tools fall back to JSON inside `<call>`. If your toolset is mostly nested, you'll save very little.
- **No `responseFormat` shenanigans.** The middleware does not force JSON mode for `toolChoice: required`. If you need hard tool-choice enforcement, use the native protocol (don't wrap that call).
- **Output tokens > input tokens.** The system-prompt manual is ~260 tokens; the per-call savings are ~10–15 tokens. With prompt caching the manual amortizes to ~zero quickly. Without caching, you need >~25 tool calls per session to break even on tokens.

## Running the eval

### Offline (no API key)

```sh
bun run bench
```

Runs against a deterministic mock model and reports:

- token cost of native JSON tool defs vs. compact system prompt
- per-call output cost across **9 tools / 10 representative cases** (`getWeather`, `getTime`, `sendEmail`, `searchProducts`, `webFetch`, `calculate`, `listFiles`, `setReminder`, `askDb`)
- round-trip correctness: every test case must parse back into the same JSON `input` the native protocol would have produced

### Live (real LLM via OpenRouter)

```sh
cp .env.example .env
# edit .env and put your OPENROUTER_API_KEY (free keys at https://openrouter.ai/keys)
bun run bench:live
```

The live benchmark:

1. Calls a real model via OpenRouter once per case in **JSON mode** (no middleware) and once in **compact mode** (with `compactTools()`).
2. Reports actual `inputTokens` / `outputTokens` from the provider, latency, and whether the emitted `tool-call` matches the ground-truth invocation.
3. Defaults to `minimax/minimax-m2.5:free` (zero cost). Override with:

   ```sh
   OPENROUTER_MODEL=qwen/qwen3-coder:free bun run bench:live
   ```

Other free options worth trying: `meta-llama/llama-3.3-70b-instruct:free`, `deepseek/deepseek-chat-v3.1:free`, `google/gemini-2.0-flash-exp:free`. Smaller free models will be the ones that benefit most from the compact format.

## Tests

```sh
bun test
```

36 tests cover the parser, signature compiler, transform-params, wrap-generate, wrap-stream (including character-level streaming and split-tag handling), and history rewriting.

## License

MIT
