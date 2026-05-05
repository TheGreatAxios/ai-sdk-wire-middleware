/**
 * YAML-style tool-call encoder for ablation testing.
 *
 *   tool_name: getWeather
 *   parameters:
 *     location: Austin
 *     units: metric
 *
 * Or compact inline form:
 *   getWeather: {location: Austin, units: metric}
 *
 * YAML is often cited as easier for small models to parse due to reduced
 * syntax noise (no braces, minimal quotes). Used here for token-cost
 * comparison and potential accuracy ablations.
 */
import type { ToolPlan } from '../../src/types.ts';

/** Escape a string value for YAML (quote if needed). */
function escapeYaml(s: string): string {
  // Quote if contains special YAML characters, newlines, or starts with a quote
  if (/[:#{}\[\],&*!?|>'"\s]/.test(s) || s.startsWith('"') || s.startsWith("'") || s === '' || s === 'true' || s === 'false' || s === 'null' || /^-?\d/.test(s)) {
    // Prefer single quotes if no single quotes inside
    if (!s.includes("'")) return `'${s}'`;
    // Otherwise use double quotes and escape
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
  }
  return s;
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return escapeYaml(v);
  if (Array.isArray(v)) {
    // Flow-style array: [a, b, c]
    return `[${v.map(formatValue).join(', ')}]`;
  }
  if (typeof v === 'object') {
    // Inline object for nested structures
    const entries = Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => `${k}: ${formatValue(val)}`);
    return `{${entries.join(', ')}}`;
  }
  return escapeYaml(String(v));
}

/** Encode a single tool call as YAML block style. */
export function yamlEncodeCall(name: string, args: Record<string, unknown>): string {
  const lines: string[] = [`tool_name: ${escapeYaml(name)}`, 'parameters:'];
  for (const [k, v] of Object.entries(args)) {
    const formatted = formatValue(v);
    // If value is multi-line or complex, indent it
    if (formatted.includes('\n') || (typeof v === 'object' && v !== null && !Array.isArray(v))) {
      lines.push(`  ${k}:`);
      // Recursively indent nested objects
      lines.push(...formatNested(v, 4));
    } else {
      lines.push(`  ${k}: ${formatted}`);
    }
  }
  return lines.join('\n');
}

/** Encode a single tool call as compact YAML flow style (one line per call). */
export function yamlEncodeCallCompact(name: string, args: Record<string, unknown>): string {
  const params = Object.entries(args)
    .map(([k, v]) => `${k}: ${formatValue(v)}`)
    .join(', ');
  return `${escapeYaml(name)}: {${params}}`;
}

function formatNested(v: unknown, indent: number): string[] {
  const spaces = ' '.repeat(indent);
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    const lines: string[] = [];
    for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
        lines.push(`${spaces}${key}:`);
        lines.push(...formatNested(val, indent + 2));
      } else {
        lines.push(`${spaces}${key}: ${formatValue(val)}`);
      }
    }
    return lines;
  }
  return [`${spaces}${formatValue(v)}`];
}

/** Build the tool manual/instructions in YAML format. */
export function yamlEncodeManual(plans: ToolPlan[], compact = false): string {
  const lines: string[] = [
    'When calling a tool, emit a YAML block of the form:',
    '',
    'tool_name: <name>',
    'parameters:',
    '  <key>: <value>',
    '  <key>: <value>',
    '',
    'Or compact flow style:',
    '',
    '<name>: {<key>: <value>, <key>: <value>}',
    '',
    'Available tools:',
    '',
  ];

  for (const p of plans) {
    lines.push(`${escapeYaml(p.name)}:`);
    if (p.description) {
      lines.push(`  description: ${escapeYaml(p.description)}`);
    }
    lines.push('  parameters:');
    for (const f of p.fields) {
      const reqFlag = f.required ? ' (required)' : ' (optional)';
      lines.push(`    ${f.name}: <${f.type}>${reqFlag}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** Build compact single-line manual for token comparison fairness. */
export function yamlEncodeManualCompact(plans: ToolPlan[]): string {
  const sigs = plans
    .map(p => {
      const params = p.fields
        .map(f => `${f.name}${f.required ? '' : '?'}: ${f.type}`)
        .join(', ');
      return `${escapeYaml(p.name)}: {${params}}  # ${p.description || 'no description'}`;
    })
    .join('\n');
  return `Call tools as YAML flow-style: {key: value}\n\n${sigs}`;
}
