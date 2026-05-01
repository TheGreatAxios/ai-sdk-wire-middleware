/**
 * Python-style function-call DSL encoder (baseline).
 *
 *   getWeather(location="Austin", units="metric")
 *
 * Closer to "code-y" tool-call formats some open models default to. Used as
 * a token-cost baseline only; no parser is implemented.
 */
import type { ToolPlan } from '../../src/types.ts';

export function pyEncodeCall(name: string, args: Record<string, unknown>): string {
  const parts = Object.entries(args).map(([k, v]) => `${k}=${formatValue(v)}`);
  return `${name}(${parts.join(', ')})`;
}

export function pyEncodeManual(plans: ToolPlan[]): string {
  const sigs = plans
    .map(p => {
      const params = p.fields
        .map(f => `${f.name}${f.required ? '' : '?'}: ${f.type}`)
        .join(', ')
        .trim();
      const desc = p.description ? `  # ${p.description}` : '';
      return `${p.name}(${params})${desc}`;
    })
    .join('\n');
  const header =
    `Call tools as Python function calls on their own line:\n\n` +
    `  tool_name(arg="value", n=42, ok=True)\n\n` +
    `Strings are quoted; numbers and booleans are bare. Available tools:`;
  return `${header}\n${sigs}`;
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  return JSON.stringify(v);
}
