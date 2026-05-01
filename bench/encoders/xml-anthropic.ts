/**
 * Anthropic-style XML tool-call encoder (baseline).
 *
 *   <tool_use>
 *     <tool_name>getWeather</tool_name>
 *     <parameters>
 *       <parameter name="location">Austin</parameter>
 *       <parameter name="units">metric</parameter>
 *     </parameters>
 *   </tool_use>
 *
 * Approximates the legacy/XML form Anthropic documented before native
 * tool-use parts. Used as a baseline in the offline bench so we can claim
 * compactness vs. an established alternative, not just vs. JSON.
 *
 * Parser is intentionally NOT implemented — the report only needs token cost.
 */
import type { ToolPlan } from '../../src/types.ts';

export function xmlEncodeCall(name: string, args: Record<string, unknown>): string {
  const params = Object.entries(args)
    .map(([k, v]) => `    <parameter name="${escapeXml(k)}">${escapeXml(formatValue(v))}</parameter>`)
    .join('\n');
  return `<tool_use>\n  <tool_name>${escapeXml(name)}</tool_name>\n  <parameters>\n${params}\n  </parameters>\n</tool_use>`;
}

export function xmlEncodeManual(plans: ToolPlan[]): string {
  const tools = plans
    .map(p => {
      const params = p.fields
        .map(f => `      <parameter name="${escapeXml(f.name)}" type="${escapeXml(f.type)}" required="${f.required}"/>`)
        .join('\n');
      return (
        `  <tool>\n    <name>${escapeXml(p.name)}</name>\n` +
        (p.description ? `    <description>${escapeXml(p.description)}</description>\n` : '') +
        `    <parameters>\n${params}\n    </parameters>\n  </tool>`
      );
    })
    .join('\n');
  const header =
    `When calling a tool, emit an XML block of the form:\n\n` +
    `<tool_use>\n  <tool_name>NAME</tool_name>\n  <parameters>\n    <parameter name="K">VALUE</parameter>\n  </parameters>\n</tool_use>\n\n` +
    `Available tools:`;
  return `${header}\n<tools>\n${tools}\n</tools>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}
