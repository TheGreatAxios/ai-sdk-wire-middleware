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
  if (plan.encoding === 'yaml') {
    const parsed = parseYamlBody(argsBody, plan);
    return JSON.stringify(parsed);
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
 * Parse YAML-style arguments from the body.
 * Supports:
 * - Flow style: `{key: value, key2: value2}`
 * - Bare key-value pairs (simple cases)
 * - Arrays: `[a, b, c]` or `["a", "b"]`
 * - Nested objects via dot-path expansion
 */
export function parseYamlBody(body: string, plan: ToolPlan): Record<string, unknown> {
  const trimmed = body.trim();
  if (!trimmed) return {};
  
  // Try to detect flow-style YAML object: `{key: value, key: value}`
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      // YAML flow objects are close enough to JSON that we can parse them
      // with a forgiving JSON-like parser
      const jsonLike = yamlFlowToJson(trimmed);
      const parsed = JSON.parse(jsonLike);
      // Apply type coercion based on plan fields
      return coerceYamlValues(parsed, plan);
    } catch {
      // Fall through to best-effort parsing
    }
  }
  
  // Try bare key: value pairs (one per line or comma-separated)
  const out: Record<string, unknown> = {};
  // Split on newlines or commas not inside brackets/braces
  const entries = splitYamlEntries(trimmed);
  for (const entry of entries) {
    const colonIdx = entry.indexOf(':');
    if (colonIdx === -1) continue;
    const key = entry.slice(0, colonIdx).trim();
    let rawVal = entry.slice(colonIdx + 1).trim();
    
    // Handle quoted values (both single and double quotes)
    if (rawVal.length >= 2 && 
        ((rawVal.startsWith('"') && rawVal.endsWith('"')) ||
         (rawVal.startsWith("'") && rawVal.endsWith("'")))) {
      rawVal = rawVal.slice(1, -1);
    }
    
    const field = plan.fields.find(f => f.name === key);
    out[key] = coerceYamlValue(rawVal, field?.type);
  }
  
  // Check for nested paths
  const hasDotPaths = plan.fields.some(f => f.name.includes('.'));
  if (hasDotPaths) {
    return reconstructNested(out);
  }
  return out;
}

/** Convert YAML flow-style to valid JSON for parsing. */
function yamlFlowToJson(yaml: string): string {
  // Replace unquoted keys with quoted keys: key: → "key":
  // Replace unquoted string values with quoted: : value → : "value"
  // This is a best-effort transformation
  let json = yaml;
  // Handle booleans, nulls, numbers specially - don't quote them
  const preservedTokens = new Map<string, string>();
  let tokenId = 0;
  
  // Preserve true/false/null/numbers as placeholders
  json = json.replace(/\b(true|false|null)\b/g, (m) => {
    const id = `___${tokenId++}___`;
    preservedTokens.set(id, m);
    return id;
  });
  json = json.replace(/(-?\d+(\.\d+)?)/g, (m) => {
    // Don't replace if it's part of a word
    if (/\w/.test(m.charAt(m.length - 1)) || /\w/.test(m.charAt(0))) return m;
    const id = `___${tokenId++}___`;
    preservedTokens.set(id, m);
    return id;
  });
  
  // Quote unquoted keys (before colon)
  json = json.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
  json = json.replace(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/, '"$1":');
  
  // Quote unquoted values (after colon, before comma or })
  json = json.replace(/:\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*([,}])/g, ': "$1"$2');
  json = json.replace(/:\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*$/, ': "$1"');
  
  // Restore preserved tokens
  for (const [id, val] of preservedTokens) {
    json = json.replace(id, val);
  }
  
  return json;
}

/** Split YAML entries, respecting brackets and braces. */
function splitYamlEntries(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let inQuote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    // Track quote state
    if (!inQuote && (ch === '"' || ch === "'")) {
      inQuote = ch;
    } else if (inQuote && ch === inQuote) {
      // Handle escaped quotes: check if preceded by backslash
      if (i === 0 || text[i - 1] !== '\\') {
        inQuote = null;
      }
    }
    // Only track bracket depth when not inside quotes
    if (!inQuote) {
      if (ch === '{' || ch === '[' || ch === '(') depth++;
      if (ch === '}' || ch === ']' || ch === ')') depth--;
    }
    if ((ch === ',' || ch === '\n') && depth === 0 && !inQuote) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Coerce all values in a parsed YAML object based on plan field types. */
function coerceYamlValues(obj: Record<string, unknown>, plan: ToolPlan): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    const field = plan.fields.find(f => f.name === key);
    if (typeof val === 'string') {
      out[key] = coerceYamlValue(val, field?.type);
    } else if (Array.isArray(val)) {
      // Coerce array items if type is known
      const itemType = field?.type?.replace(/\[\]$/, '');
      out[key] = val.map(v => typeof v === 'string' ? coerceYamlValue(v, itemType) : v);
    } else {
      out[key] = val;
    }
  }
  return out;
}

/** Coerce a single YAML value to the expected type. */
function coerceYamlValue(raw: string, type: string | undefined): unknown {
  // Handle explicit strings (quoted)
  if ((raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  
  // YAML booleans (true/false/yes/no/on/off)
  if (raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === 'false' || raw === 'no' || raw === 'off') return false;
  if (raw === 'null' || raw === '~') return null;
  
  // Arrays in flow style [a, b, c]
  if (raw.startsWith('[') && raw.endsWith(']')) {
    try {
      const inner = raw.slice(1, -1);
      if (!inner.trim()) return [];
      const items = splitYamlEntries(inner);
      return items.map(item => item.trim()).filter(Boolean);
    } catch {
      return raw;
    }
  }
  
  if (type === 'string') return raw;
  
  // Numbers
  if (type === 'number' || type === 'int') {
    const n = Number(raw);
    if (Number.isFinite(n)) return type === 'int' ? Math.trunc(n) : n;
    return raw;
  }
  
  // Best-effort numeric for untyped
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  
  return raw;
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
  // Array literals: ["a","b"]
  if (raw.startsWith('[') && raw.endsWith(']')) {
    try {
      return JSON.parse(raw);
    } catch {
      // Fall through if JSON parse fails — treat as string
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


