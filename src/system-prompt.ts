import type { CompactToolsOptions, ToolPlan } from './types.ts';

const DEFAULT_HEADER = `# Tool calling protocol

When you want to call a tool, emit EXACTLY one call per tool invocation, on its own line, in this form:

<call>tool_name arg=value other=42</call>

Rules:
- Quote any value containing spaces, commas, or special chars: name="New York"
- Numbers and booleans are unquoted: count=3 enabled=true
- For tools marked <json> below, put a single JSON object as the body: <call>tool_name {"x": 1}</call>
- Do NOT wrap the call in code fences. Do NOT emit JSON tool_calls; only the <call>…</call> form is recognized.
- After emitting a call, stop generating until you receive the tool result.
- Free-form prose before/after a call is fine; the parser only acts on <call>…</call> tags.`;

export function buildSystemPrompt(plans: ToolPlan[], options: CompactToolsOptions): string {
  const header = options.manualHeader ?? DEFAULT_HEADER;
  if (plans.length === 0) return header;
  const lines = plans.map(p => `- ${p.signature}`).join('\n');
  return `${header}\n\n## Available tools\n\n${lines}`;
}

/**
 * Inject the generated system prompt into the existing prompt:
 * - Concatenate to existing leading `system` message, or
 * - Insert a new `system` message at first/last per `placement`.
 */
export function injectSystemPrompt<M extends { role: string; content: unknown }>(
  prompt: M[],
  toolManual: string,
  placement: 'first' | 'last',
): M[] {
  const out = prompt.slice();
  // Concatenate into the first existing `system` message if present.
  for (let i = 0; i < out.length; i++) {
    const m = out[i] as M;
    if (m.role === 'system' && typeof m.content === 'string') {
      const merged =
        placement === 'first'
          ? `${toolManual}\n\n${m.content}`
          : `${m.content}\n\n${toolManual}`;
      out[i] = { ...m, content: merged } as M;
      return out;
    }
  }
  // No system message: insert one.
  const sysMsg = { role: 'system', content: toolManual } as unknown as M;
  if (placement === 'first') return [sysMsg, ...out];
  return [...out, sysMsg];
}
