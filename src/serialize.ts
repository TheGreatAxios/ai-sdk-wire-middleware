import type { ToolPlan } from './types.ts';
import { CALL_CLOSE, CALL_OPEN } from './parser.ts';

/**
 * Flatten nested values from an object into dot-path keys.
 * Returns entries like [["profile.displayName", "Alice"], ["profile.address.city", "Austin"]]
 * Only flattens plain objects, not arrays.
 */
function flattenNested(obj: Record<string, unknown>, prefix: string = ''): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      // Recurse into nested objects
      out.push(...flattenNested(v as Record<string, unknown>, key));
    } else {
      out.push([key, v]);
    }
  }
  return out;
}

/**
 * Serialize a tool-call back into compact wire form. Used to rewrite
 * assistant-history `tool-call` parts as `text` parts before re-sending the
 * conversation to the model (the model never saw the JSON form).
 */
export function serializeCall(toolName: string, input: string, plan: ToolPlan | undefined): string {
  const args = safeParse(input);
  if (!plan || plan.encoding === 'json' || !args || typeof args !== 'object') {
    return `${CALL_OPEN}${toolName} ${input || '{}'}${CALL_CLOSE}`;
  }
  // wire: flatten nested objects into dot-path keys
  const entries = flattenNested(args as Record<string, unknown>);
  const parts: string[] = [];
  for (const [k, v] of entries) {
    const fieldType = plan.fields.find(f => f.name === k)?.type;
    parts.push(`${k}=${formatValue(v, fieldType)}`);
  }
  return `${CALL_OPEN}${toolName}${parts.length ? ' ' + parts.join(' ') : ''}${CALL_CLOSE}`;
}

function safeParse(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

export function formatValue(v: unknown, type: string | undefined): string {
  if (v == null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    if (needsQuoting(v) || type === undefined) return quoteString(v);
    return v;
  }
  if (Array.isArray(v)) {
    // Format arrays as JSON inline: ["a","b"]
    return JSON.stringify(v);
  }
  if (typeof v === 'object' && v !== null) {
    // Non-array objects fall back to JSON
    return JSON.stringify(v);
  }
  return JSON.stringify(v);
}

/**
 * Quote a string value intelligently:
 * - If it doesn't need quoting at all, return as-is (bare word).
 * - If it contains `"` but not `'`, use single quotes (avoids escapes).
 * - Otherwise use double quotes with JSON escaping (current behavior).
 */
function quoteString(s: string): string {
  if (!needsQuoting(s) && !looksLikeKeyword(s) && !looksLikeNumber(s)) return s;
  if (s.includes('"') && !s.includes("'")) {
    return `'${s}'`;
  }
  return JSON.stringify(s);
}

function needsQuoting(s: string): boolean {
  return s.length === 0 || /[\s"'=<>]/.test(s);
}

/** True if the string equals a keyword we'd coerce differently. */
function looksLikeKeyword(s: string): boolean {
  return s === 'true' || s === 'false' || s === 'null';
}

/** True if the string looks like a number the parser would coerce. */
function looksLikeNumber(s: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(s);
}

/** Serialize a tool-result message body back into a compact form for the model. */
export function serializeToolResult(toolName: string, result: unknown, isError?: boolean): string {
  const tag = isError ? 'tool-error' : 'tool-result';
  const body = typeof result === 'string' ? result : JSON.stringify(result);
  return `<${tag} name="${toolName}">${body}</${tag}>`;
}
