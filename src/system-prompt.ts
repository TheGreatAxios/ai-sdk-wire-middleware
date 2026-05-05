import type { CompactToolsOptions, ToolPlan } from './types.ts';

const DEFAULT_HEADER = `# Wire format

Use <call>toolName key=value</call> instead of JSON tools.

Examples:
<call>getWeather location=Austin units=metric</call>
<call>bookMeeting title="Review" date=2026-05-15 duration=60 attendees=["a@c.com"] room=A</call>

Values: bare if safe (text=hello), "quotes" if spaces, 'quotes' if inner ",
numbers/booleans unquoted, arrays as ["a","b"], nested as parent.child=val.
<json> tools use {"key":"val"} inside the call.

Only <call>…</call> is parsed — no native JSON tool calls.`;

export function buildSystemPrompt(plans: ToolPlan[], options: CompactToolsOptions): string {
  const header = options.manualHeader ?? getDefaultHeader(options.syntax ?? 'wire');
  if (plans.length === 0) return header;
  const lines = plans.map(p => `- ${p.signature}`).join('\n');
  return `${header}\n\n## Available tools\n\n${lines}`;
}

function getDefaultHeader(syntax: 'wire' | 'json'): string {
  return DEFAULT_HEADER;
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
