import type { LanguageModelV4Middleware } from '@ai-sdk/provider';
import type { CompactToolsOptions, ResolvedCompactToolsOptions } from './types.ts';
import { transformParams } from './transform-params.ts';
import { wrapGenerate } from './wrap-generate.ts';
import { wrapStream } from './wrap-stream.ts';

export type {
  CompactToolsOptions,
  FunctionTool,
  ParsedCall,
  ResolvedCompactToolsOptions,
  ToolPlan,
} from './types.ts';
export { CALL_CLOSE, CALL_OPEN, parseCalls, ToolReduceParseError } from './parser.ts';
export { isFlatObject, isWireCapable, planTools, renderSignature } from './signature.ts';

/** Default option values used by `compactTools()`. */
export const DEFAULT_COMPACT_TOOLS_OPTIONS: Readonly<
  Omit<ResolvedCompactToolsOptions, 'manualHeader'>
> = Object.freeze({
  syntax: 'wire',
  fallbackToJson: 'complex',
  placement: 'last',
  debug: false,
});

/**
 * Resolve user-supplied `CompactToolsOptions` against `DEFAULT_COMPACT_TOOLS_OPTIONS`.
 */
export function resolveCompactToolsOptions(
  options: CompactToolsOptions = {},
): ResolvedCompactToolsOptions {
  return {
    syntax: options.syntax ?? DEFAULT_COMPACT_TOOLS_OPTIONS.syntax,
    fallbackToJson: options.fallbackToJson ?? DEFAULT_COMPACT_TOOLS_OPTIONS.fallbackToJson,
    placement: options.placement ?? DEFAULT_COMPACT_TOOLS_OPTIONS.placement,
    manualHeader: options.manualHeader,
    debug: options.debug ?? DEFAULT_COMPACT_TOOLS_OPTIONS.debug,
  };
}

/**
 * `compactTools()` — replace JSON tool calls with a compact `<call>name k=v</call>` wire syntax.
 *
 * Supports two encoding styles:
 * - `'wire'` (default): `<call>getWeather location=Austin units=metric</call>`
 * - `'json'`: `<call>getWeather {"location":"Austin","units":"metric"}</call>`
 *
 * Plug into AI SDK v7 via `wrapLanguageModel`:
 *
 * ```ts
 * import { wrapLanguageModel } from 'ai';
 * import { compactTools } from 'ai-sdk-wire-middleware';
 *
 * const model = wrapLanguageModel({
 *   model: anthropic('claude-sonnet-4-5'),
 *   middleware: compactTools({ fallbackToJson: 'complex' }),
 * });
 * ```
 */
export function compactTools(options: CompactToolsOptions = {}): LanguageModelV4Middleware {
  const resolved = resolveCompactToolsOptions(options);

  return {
    specificationVersion: 'v4',
    transformParams: async ({ params }) => transformParams(params, resolved),
    wrapGenerate: async ({ doGenerate, params }) => wrapGenerate(params, doGenerate),
    wrapStream: async ({ doStream, params }) => wrapStream(params, doStream),
  };
}
