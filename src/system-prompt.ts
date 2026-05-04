import type { CompactToolsOptions, ToolPlan } from './types.ts';

const DEFAULT_HEADER = `# Wire format

Instead of JSON function calls, use:
  <call>getWeather location=Austin units=metric</call>
  <call>sendEmail to=user@co.com subject="Meeting" body='Said "hello"' priority=high</call>

Values:
  - Bare words: text=hello  (no quotes needed if no spaces/special chars)
  - Double quotes: text="hello world"  (when value has spaces)
  - Single quotes: text='said "hi"'  (when value has double quotes inside)
  - Unquoted: numbers, booleans, null
  - Arrays: tags=["a","b"]  (JSON array syntax)
  - Nested: profile.displayName=Alice  (dot paths for nested objects)
  - Tools marked <json> use: {"key":"val"}

No native JSON tool_calls. Only <call>…</call> tags are parsed.`;

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
