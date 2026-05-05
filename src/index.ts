import type { LanguageModelV3Middleware } from '@ai-sdk/provider';
import type { CompactToolsOptions } from './types.ts';
import { transformParams } from './transform-params.ts';
import { wrapGenerate } from './wrap-generate.ts';
import { wrapStream } from './wrap-stream.ts';

export type { CompactToolsOptions };
export { ToolReduceParseError } from './parser.ts';
export { renderSignature, planTools, isFlatObject } from './signature.ts';

/**
 * `compactTools()` — replace JSON tool calls with a compact `<call>name k=v</call>` syntax.
 *
 * Supports two encoding styles:
 * - `wire` (default): `<call>getWeather location=Austin units=metric</call>`
 * - `json`: `<call>getWeather {"location":"Austin","units":"metric"}</call>`
 *
 * Plug into AI SDK v6 via `wrapLanguageModel`:
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
export function compactTools(options: CompactToolsOptions = {}): LanguageModelV3Middleware {
  const opts = {
    syntax: options.syntax ?? 'wire',
    fallbackToJson: options.fallbackToJson ?? 'complex',
    placement: options.placement ?? 'last',
    manualHeader: options.manualHeader,
    debug: options.debug ?? false,
  } as const;

  return {
    specificationVersion: 'v3',
    transformParams: async ({ params }) => transformParams(params, opts),
    wrapGenerate: async ({ doGenerate, params }) => wrapGenerate(params, doGenerate),
    wrapStream: async ({ doStream, params }) => wrapStream(params, doStream),
  };
}
