import type { LanguageModelV4FunctionTool } from '@ai-sdk/provider';

/**
 * Public options for the `compactTools` middleware.
 */
export interface CompactToolsOptions {
  /**
   * Wire syntax used inside `<call>…</call>`.
   * - `'wire'` (default): `<call>name key="value" n=42 ok=true</call>`
   * - `'json'`: `<call>name {"key":"value"}</call>` (no compaction; useful as a fallback)
   *
   * @default 'wire'
   */
  syntax?: 'wire' | 'json';
  /**
   * Strategy when a tool's input schema is not a flat record of primitives.
   * - `'complex'` (default): use `wire` for flattenable schemas and JSON inside `<call>` for deeply nested/union schemas
   * - `'error'`: throw when planning a non-flat tool schema
   * - `'force'`: attempt wire flattening anyway (may lose structure)
   *
   * @default 'complex'
   */
  fallbackToJson?: 'complex' | 'error' | 'force';
  /**
   * Insert position of the generated tool manual in the system message.
   * - `'last'` (default): appended to existing system message, or added at the end
   * - `'first'`: prepended to existing system message, or inserted at the front
   *
   * @default 'last'
   */
  placement?: 'first' | 'last';
  /** Optional custom header replacing the default wire-format instructions in the system prompt. */
  manualHeader?: string;
  /**
   * Reserved for stripping non-call prose outside `<call>…</call>` spans.
   *
   * @default false
   */
  stripPreamble?: boolean;
  /**
   * Enable verbose stderr logging of middleware transform decisions.
   *
   * @default false
   */
  debug?: boolean;
}

/** Fully resolved middleware options with defaults applied. */
export interface ResolvedCompactToolsOptions {
  readonly syntax: 'wire' | 'json';
  readonly fallbackToJson: 'complex' | 'error' | 'force';
  readonly placement: 'first' | 'last';
  readonly manualHeader?: string;
  readonly debug: boolean;
}

/** Resolved per-tool plan computed once at transform time. */
export interface ToolPlan {
  name: string;
  description?: string;
  /** Compact one-line signature, e.g. `getWeather: location:string, units?:"metric"|"imperial"` */
  signature: string;
  /** Wire encoding chosen for this tool. */
  encoding: 'wire' | 'json';
  /** Ordered list of expected fields (for wire mode). */
  fields: Array<{ name: string; required: boolean; type: string }>;
  /** Original JSON Schema for coercion. */
  inputSchema: unknown;
}

/** A single parsed `<call>…</call>` invocation. */
export interface ParsedCall {
  toolName: string;
  /** JSON-stringified arguments (matches `LanguageModelV4ToolCall.input`). */
  input: string;
  /** Source range in the original text (for splitting around the call). */
  start: number;
  end: number;
}

/** Stash key in `providerOptions`. */
export const STASH_KEY = 'toolReduce' as const;

/** AI SDK v7 function tool definition (`LanguageModelV4FunctionTool`). */
export type FunctionTool = LanguageModelV4FunctionTool;
