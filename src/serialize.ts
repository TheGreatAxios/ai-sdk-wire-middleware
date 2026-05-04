import type { ToolPlan } from './types.ts';
import { CALL_CLOSE, CALL_OPEN } from './parser.ts';

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
  // wire
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
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
    if (needsQuoting(v) || type === undefined) return JSON.stringify(v);
    return v;
  }
  return JSON.stringify(v);
}

function needsQuoting(s: string): boolean {
  return s.length === 0 || /[\s"'=<>]/.test(s);
}

/** Serialize a tool-result message body back into a compact form for the model. */
export function serializeToolResult(toolName: string, result: unknown, isError?: boolean): string {
  const tag = isError ? 'tool-error' : 'tool-result';
  const body = typeof result === 'string' ? result : JSON.stringify(result);
  return `<${tag} name="${toolName}">${body}</${tag}>`;
}
