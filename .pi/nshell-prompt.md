# Implement `nshell` — bracket-nested shell encoding for tool-reduce

Add a new wire encoding called `nshell` (nested shell) to the `tool-reduce` library that handles arbitrarily nested objects and arrays without falling back to JSON inside `<call>...</call>`.

## Background

Currently `tool-reduce` has three wire encodings inside `<call>name ...</call>`:

- `shell` (default) — `key="value"` flat pairs, only works with flat records of primitives
- `csv` — positional args, only flat records
- `json` — full JSON object, used as fallback for tools with nested schemas

The problem: tools with nested objects (`profile: { address: { city } }`) or arrays (`attendees: string[]`) fall back to JSON, which cuts the token savings from ~45% to ~20%.

## The `nshell` encoding

Extend shell syntax with bracket-delimited nesting:

```
# Flat primitives (same as shell):
key="string" n=42 flag=true

# Arrays of primitives:
tags=["a","b","c"]

# Nested objects (bracket-delimited sub-contexts):
profile[displayName="Alice" address[street="123 Main" city="Austin"]]

# Arrays of objects (curly-brace delimited objects inside brackets):
team[{name="Alice" role="dev"} {name="Bob" role="design"}]
```

### Design rules

1. **Scalars** — identical to existing `shell`: `key="value"`, `key=42`, `key=true`, `key=false`, `key=null`
2. **Objects** — `key[prop=val prop2=val2]` — `[` opens a sub-context where every token follows the same rules. `]` closes it.
3. **Arrays of primitives** — `key=["a", "b", 42]` — JSON array literal as the value (detected by leading `[` and not followed by `{` or `[...`)
4. **Arrays of objects** — `key[{name="Alice"} {name="Bob"}]` — `[{` starts an array of objects, each `{...}` is one element, `}]` closes the array. This is the most complex case — handle carefully.
5. **Nesting is arbitrary-depth** — objects inside objects inside arrays inside objects, etc.
6. **No JSON anywhere** — the entire `<call>name body</call>` should be parseable without a JSON parser

## What to change

### 1. Types (`src/types.ts`)

- Add `'nshell'` to the `CompactToolsOptions.syntax` union type
- Add `'nshell'` to the `ToolPlan.encoding` union

### 2. Signature compiler (`src/signature.ts`)

- Rename `isFlatObject` to `isDeepFlat` — it should return `true` for schemas whose leaves are primitives **or** arrays of primitives **or** nested objects whose leaves are all primitives.
- For `nshell` encoding, `renderSignature` should emit nested signatures like:
  ```
  createUser: userId, profile[displayName, address[street, city, country], preferences[theme?, notifications?]]
  ```

### 3. Parser (`src/parser.ts`)

- Add a `tokenizeNShell` function that tracks `[` / `]` / `{` / `}` depth so it doesn't split tokens on whitespace inside brackets or braces.
- Add `parseNestedBody(body, plan)` that recursively walks the token tree. When it sees `key[...]`, it recursively parses the inside as a nested object. When it sees `key=[...]` or `key[...` with commas, it handles arrays.
- For arrays of objects (`[{...} {...}]`), each `{...}` block is parsed with the same recursive parser and pushed onto an array.
- The new parser should be registered under `plan.encoding === 'nshell'`.
- Keep all existing parsers (`shell`, `csv`, `json`) unchanged.

### 4. Serializer (`src/serialize.ts`)

- Add `serializeToNShell(args, fields, plan)` that recursively walks the args object and emits `nshell` format.
- For flat values, reuse `formatValue`.
- For nested objects, emit `subkey[prop=val prop2=val2]`.
- For arrays, emit `key=["a","b"]` for primitives, `key[{prop=val} {prop2=val2}]` for objects.

### 5. Middleware integration

- `planTools` in `signature.ts` — when `options.syntax === 'nshell'`, use `'nshell'` as the base encoding instead of `'shell'`, and only fall back to `'json'` for tools whose schema has `anyOf`, `oneOf`, or truly exotic structures.
- `transform-params.ts` — if the plan encoding is `'nshell'`, serialize history with `serializeToNShell`.
- No changes to `wrap-generate.ts` or `wrap-stream.ts` — they call `parseCalls` which dispatches to the right parser based on `plan.encoding`.

## Tests

1. **New round-trip tests** — add entries to `bench/tools.ts` with `nshell` compactCall strings for:
   - `updateUserProfile` (nested objects, 3 levels deep)
   - `bookMeeting` (array of primitives + scalar mix)
   - A new tool with array of objects (e.g. `batchProcess` with `tasks: [{name, priority}]`)
2. **Parser edge cases** — test bracket depth tracking, unclosed brackets, nested quotes inside brackets
3. **Serializer round-trip** — `serialize ∘ parse ∘ serialize ≡ serialize` for every nshell case
4. **Integration test** — `compactTools({ syntax: 'nshell' })` produces correct signatures and parses model output correctly

## What NOT to change

- Do not touch `wrap-generate.ts` or `wrap-stream.ts` (they dispatch through `parseCalls` which is encoding-agnostic)
- Do not touch `transform-params.ts` beyond the serialization call
- Do not remove or modify existing `shell`/`csv`/`json` encodings — `nshell` is additive
- Do not modify the `LanguageModelV3Middleware` interface — `compactTools` options are the only API surface

## Success criteria

- `bun test` — all existing 227 tests pass + new tests
- `npx tsc --noEmit` — clean
- `bun run bench` — shows `nshell` as a new encoding column with improved savings on nested tools
- `updateUserProfile` token savings should jump from ~19% (json fallback) to ~40%+ (nshell)
