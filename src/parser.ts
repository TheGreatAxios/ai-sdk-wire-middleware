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
  while (i < body.length && !/\s/.test(body[i]!)) i++;
  const toolName = body.slice(nameStart, i);
  const argsBody = body.slice(i).trim();
  return { toolName, argsBody };
}

/** Convert a free-form args body to JSON-stringified args matching the tool schema. */
export function encodeArgs(argsBody: string, plan: ToolPlan): string {
  if (plan.encoding === 'json') {
    return parseJsonBody(argsBody);
  }
  return JSON.stringify(parseWireBody(argsBody, plan));
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
  // Quoted strings.
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return unquote(raw);
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


