import type { LanguageModelV3FunctionTool } from '@ai-sdk/provider';

/** Public options for the `compactTools` middleware. */
export interface CompactToolsOptions {
  /**
   * Wire syntax used inside `<call>…</call>`.
   * - `wire` (default): `<call>name key="value" n=42 ok=true</call>`
   * - `json`: `<call>name {"key":"value"}</call>` (no compaction; useful as a fallback)
   * - `kwargs`: `<call>name(key=value, n=42, ok=true)</call>` (Python-style keyword args)
   */
  syntax?: 'wire' | 'json' | 'kwargs';
  /**
   * What to do when a tool's input schema is not a flat record of primitives.
   * - `complex` (default): use JSON inside `<call>` for that tool only
   * - `error`: throw at wrap time
   * - `force`: try to flatten anyway (may lose data)
   */
  fallbackToJson?: 'complex' | 'error' | 'force';
  /**
   * Insert position of the generated tool manual in the system message.
   * Default `last` (appended to existing system message, or new system message at end).
   */
  placement?: 'first' | 'last';
  /** Optional override of the manual that documents the call format. */
  manualHeader?: string;
  /**
   * If true, strip all text outside `<call>…</call>` tags from the model output.
   * Only tool-call parts are emitted — preamble, trailing text, and interstitial
   * text between multiple calls are dropped. This saves output tokens when the
   * model "thinks out loud" before/after calls.
   * Default `false` (preserve all text).
   */
  stripPreamble?: boolean;
  /** Verbose logging of transform decisions (stderr). */
  debug?: boolean;
}

/** Resolved per-tool plan computed once at transform time. */
export interface ToolPlan {
  name: string;
  description?: string;
  /** Compact positional signature, e.g. `getWeather: location, units?` */
  signature: string;
  /** Wire encoding chosen for this tool. */
  encoding: 'wire' | 'json' | 'kwargs';
  /** Ordered list of expected fields (for wire mode). */
  fields: Array<{ name: string; required: boolean; type: string }>;
  /** Original JSON Schema for coercion. */
  inputSchema: unknown;
}

/** A single parsed `<call>…</call>` invocation. */
export interface ParsedCall {
  toolName: string;
  /** JSON-stringified arguments (matches `LanguageModelV3ToolCall.input`). */
  input: string;
  /** Source range in the original text (for splitting around the call). */
  start: number;
  end: number;
}

export interface CompactToolsInternal {
  options: Required<Omit<CompactToolsOptions, 'manualHeader' | 'debug'>> & {
    manualHeader?: string;
    debug: boolean;
  };
}

/** Stash key in `providerOptions`. */
export const STASH_KEY = 'toolReduce' as const;

export interface StashedTools {
  plans: ToolPlan[];
  /** Stringified JSON schema for each tool, indexed by name. */
  schemas: Record<string, string>;
}

export type FunctionTool = LanguageModelV3FunctionTool;
