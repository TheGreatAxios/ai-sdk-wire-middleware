import type { ParsedCall, ToolPlan } from './types.ts';

/** Hard delimiters. Single-line is preferred; multi-line is tolerated. */
export const CALL_OPEN = '<call>';
export const CALL_CLOSE = '</call>';

/** Find every <call>…</call> span in a complete text. */
export function findCallSpans(text: string): Array<{ start: number; end: number; body: string }> {
  const out: Array<{ start: number; end: number; body: string }> = [];
  let i = 0;
  while (true) {
    const open = text.indexOf(CALL_OPEN, i);
    if (open === -1) break;
    const bodyStart = open + CALL_OPEN.length;
    const close = text.indexOf(CALL_CLOSE, bodyStart);
    if (close === -1) break;
    out.push({ start: open, end: close + CALL_CLOSE.length, body: text.slice(bodyStart, close) });
    i = close + CALL_CLOSE.length;
  }
  return out;
}

/** Parse the full text against a tool plan; returns parsed calls. Throws on unknown tool. */
export function parseCalls(text: string, plans: ToolPlan[]): ParsedCall[] {
  const planByName = new Map(plans.map(p => [p.name, p]));
  const calls: ParsedCall[] = [];
  for (const span of findCallSpans(text)) {
    const { toolName, argsBody } = splitNameAndBody(span.body);
    const plan = planByName.get(toolName);
    if (!plan) {
      throw new ToolReduceParseError(
        `Unknown tool "${toolName}". Known: ${[...planByName.keys()].join(', ') || '(none)'}`,
        { toolName, body: span.body },
      );
    }
    const input = encodeArgs(argsBody, plan);
    calls.push({ toolName, input, start: span.start, end: span.end });
  }
  return calls;
}

/** Custom error so the middleware can surface clean messages back to the model. */
export class ToolReduceParseError extends Error {
  details: { toolName?: string; body?: string };
  constructor(msg: string, details: { toolName?: string; body?: string } = {}) {
    super(msg);
    this.name = 'ToolReduceParseError';
    this.details = details;
  }
}

/** Pull `tool_name` off the front of the body, return the remaining args portion. */
export function splitNameAndBody(body: string): { toolName: string; argsBody: string } {
  let i = 0;
  while (i < body.length && /\s/.test(body[i]!)) i++;
  const nameStart = i;
  // Read tool name: stop at whitespace OR open paren
  while (i < body.length && !/\s/.test(body[i]!) && body[i] !== '(') i++;
  const toolName = body.slice(nameStart, i);
  const argsBody = body.slice(i).trim();
  return { toolName, argsBody };
}

/** Convert a free-form args body to JSON-stringified args matching the tool schema. */
export function encodeArgs(argsBody: string, plan: ToolPlan): string {
  if (plan.encoding === 'json') {
    return parseJsonBody(argsBody);
  }
  if (plan.encoding === 'kwargs') {
    // kwargs uses inline {key=val} objects for nesting, not dot paths
    return JSON.stringify(parseKwargsBody(argsBody, plan));
  }
  const flat = parseWireBody(argsBody, plan);
  // Check if any plan fields use dot paths (nested flattening).
  const hasDotPaths = plan.fields.some(f => f.name.includes('.'));
  if (hasDotPaths) {
    return JSON.stringify(reconstructNested(flat));
  }
  return JSON.stringify(flat);
}

function parseJsonBody(body: string): string {
  if (!body) return '{}';
  // Auto-detect whether it's a JSON object body.
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) {
    throw new ToolReduceParseError(
      `Expected a JSON object body for json-encoded tool, got: ${trimmed.slice(0, 60)}`,
    );
  }
  try {
    const parsed = JSON.parse(trimmed);
    return JSON.stringify(parsed);
  } catch (err) {
    throw new ToolReduceParseError(
      `Invalid JSON in tool call body: ${(err as Error).message}`,
    );
  }
}

/**
 * Parse kwargs-style arguments: `key1=val1, key2=val2`
 * inside parentheses. Handles quoted strings, arrays, inline objects (`{key=val}`),
 * and dot-paths for nested fields.
 *
 * @param body - The raw args body (may include surrounding parens)
 * @param plan - ToolPlan for field type info (can be null for recursive inline parsing)
 */
export function parseKwargsBody(body: string, plan: ToolPlan | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const trimmed = body.trim();
  if (!trimmed) return out;

  // Strip surrounding parentheses if present
  let inner = trimmed;
  if (inner.startsWith('(') && inner.endsWith(')')) {
    inner = inner.slice(1, -1).trim();
  }
  if (!inner) return out;

  const tokens = tokenizeKwargs(inner);
  for (const tok of tokens) {
    const eq = tok.indexOf('=');
    if (eq === -1) {
      throw new ToolReduceParseError(
        `Expected key=value in kwargs, got "${tok}" in tool "${plan?.name ?? '(inline)'}"`,
        { toolName: plan?.name, body },
      );
    }
    const key = tok.slice(0, eq).trim();
    const rawVal = tok.slice(eq + 1).trim();
    
    // Handle inline objects: nested={sub1=val, sub2=val}
    if (rawVal.startsWith('{') && rawVal.endsWith('}')) {
      const innerBody = rawVal.slice(1, -1);
      // Recursively parse inline objects — pass null for plan since field names differ
      const innerObj = parseKwargsBody(innerBody, null);
      out[key] = innerObj;
    } else {
      const field = plan?.fields?.find(f => f.name === key);
      out[key] = coerceValue(rawVal, field?.type);
    }
  }
  
  // Handle dot-path keys for mixed usage (some inline, some dot paths)
  const hasDotKeys = Object.keys(out).some(k => k.includes('.'));
  if (hasDotKeys) {
    return reconstructNested(out);
  }
  return out;
}

/**
 * Comma-delimited tokenizer for kwargs. Splits on commas outside brackets/quotes,
 * preserving quoted strings and array/bracket content.
 */
function tokenizeKwargs(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let inQuote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (inQuote) {
      cur += ch;
      if (ch === '\\' && i + 1 < input.length) {
        cur += input[++i]!;
      } else if (ch === inQuote) {
        inQuote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      cur += ch;
      continue;
    }
    if (ch === '[' || ch === '{' || ch === '(') {
      depth++;
      cur += ch;
      continue;
    }
    if (ch === ']' || ch === '}' || ch === ')') {
      depth--;
      cur += ch;
      continue;
    }
    if (ch === ',' && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** key=value pairs; values may be quoted with " or '. */
export function parseWireBody(body: string, plan: ToolPlan): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!body) return out;
  const tokens = tokenizeWire(body);
  for (const tok of tokens) {
    const eq = tok.indexOf('=');
    if (eq === -1) {
      throw new ToolReduceParseError(
        `Expected key=value, got "${tok}" in tool "${plan.name}"`,
        { toolName: plan.name, body },
      );
    }
    const key = tok.slice(0, eq);
    const rawVal = tok.slice(eq + 1);
    const field = plan.fields.find(f => f.name === key);
    out[key] = coerceValue(rawVal, field?.type);
  }
  return out;
}



/**
 * Reconstruct a nested object from flat dot-path keys.
 * E.g. {"profile.displayName": "Alice", "profile.bio": "Engineer"}
 * → {"profile": {"displayName": "Alice", "bio": "Engineer"}}
 */
export function reconstructNested(flat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(flat)) {
    const parts = key.split('.');
    if (parts.length === 1) {
      out[key] = val;
    } else {
      let current = out;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        if (i === parts.length - 1) {
          current[part] = val;
        } else {
          if (!(part in current) || typeof current[part] !== 'object' || current[part] === null) {
            current[part] = {};
          }
          current = current[part] as Record<string, unknown>;
        }
      }
    }
  }
  return out;
}

/**
 * Whitespace-delimited tokenizer. Splits on whitespace except inside matched quotes.
 * A token may contain an `=` followed by a quoted string. Backslash escapes
 * inside quotes are honored: \", \\, \n, \t.
 */
export function tokenizeWire(input: string): string[] {
  const out: string[] = [];
  let i = 0;
  let cur = '';
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      if (cur.length) {
        out.push(cur);
        cur = '';
      }
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      cur += ch; // keep quote in token; consumed below in coerceValue
      i++;
      while (i < input.length) {
        const c2 = input[i]!;
        if (c2 === '\\' && i + 1 < input.length) {
          cur += c2 + input[i + 1]!;
          i += 2;
          continue;
        }
        cur += c2;
        i++;
        if (c2 === quote) break;
      }
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Coerce a raw string value into the JS type implied by the schema field type label. */
export function coerceValue(raw: string, type: string | undefined): unknown {
  // Quoted strings (double or single).
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return unquote(raw);
  }
  // Array literals: ["a","b"] or [a, b, c]
  if (raw.startsWith('[') && raw.endsWith(']')) {
    try {
      return JSON.parse(raw);
    } catch {
      // Fall back to unquoted item parsing: [a, b, c] → ["a", "b", "c"]
      const inner = raw.slice(1, -1).trim();
      if (!inner) return [];
      // Check if it's a simple comma-separated list with no nested quotes/braces
      const items: unknown[] = [];
      let cur = '';
      let depth = 0;
      let inQuote: string | null = null;
      for (let i = 0; i < inner.length; i++) {
        const ch = inner[i]!;
        if (inQuote) {
          cur += ch;
          if (ch === inQuote && (i === 0 || inner[i - 1] !== '\\')) inQuote = null;
        } else if (ch === '\\' && i + 1 < inner.length) {
          cur += ch + inner[++i]!;
        } else if (ch === '"' || ch === "'") {
          inQuote = ch;
          cur += ch;
        } else if (ch === '{' || ch === '[' || ch === '(') {
          depth++;
          cur += ch;
        } else if (ch === '}' || ch === ']' || ch === ')') {
          depth--;
          cur += ch;
        } else if (ch === ',' && depth === 0 && !inQuote) {
          items.push(coerceValue(cur.trim(), type?.replace(/\[\]$/, '')));
          cur = '';
        } else {
          cur += ch;
        }
      }
      if (cur.trim()) items.push(coerceValue(cur.trim(), type?.replace(/\[\]$/, '')));
      if (items.length > 0 || inner.trim()) return items;
    }
  }
  if (type === 'string') return raw;
  // Booleans and null
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  // Numbers
  if (type === 'number' || type === 'int') {
    const n = Number(raw);
    if (Number.isFinite(n)) return type === 'int' ? Math.trunc(n) : n;
  } else {
    // Untyped: best-effort numeric coercion only if it round-trips.
    if (raw.length > 0 && /^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  }
  // String-enum or fallthrough
  return raw;
}

function unquote(s: string): string {
  const inner = s.slice(1, -1);
  return inner.replace(/\\(["'\\nrt])/g, (_, c: string) => {
    switch (c) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      default:
        return c;
    }
  });
}


