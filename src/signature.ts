import type { CompactToolsOptions, FunctionTool, ToolPlan } from './types.ts';

/** A subset of JSON Schema we recognize for flattening. */
type SchemaNode = {
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  required?: string[];
  description?: string;
  enum?: unknown[];
  items?: SchemaNode;
  anyOf?: SchemaNode[];
  oneOf?: SchemaNode[];
  [k: string]: unknown;
};

const PRIMITIVE_TYPES = new Set(['string', 'number', 'integer', 'boolean']);

/** Return true iff the schema is a flat object whose props are all primitives or string-enums. */
export function isFlatObject(schema: SchemaNode | undefined): boolean {
  if (!schema || schema.type !== 'object' || !schema.properties) return false;
  for (const prop of Object.values(schema.properties)) {
    if (!isPrimitiveLeaf(prop)) return false;
  }
  return true;
}

function isPrimitiveLeaf(node: SchemaNode): boolean {
  if (!node) return false;
  // string | number | boolean | integer
  if (typeof node.type === 'string' && PRIMITIVE_TYPES.has(node.type)) return true;
  if (Array.isArray(node.type) && node.type.every(t => PRIMITIVE_TYPES.has(t) || t === 'null'))
    return true;
  // string-enum
  if (Array.isArray(node.enum) && node.enum.every(v => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'))
    return true;
  return false;
}

/** Render a tool as a compact one-line signature. */
export function renderSignature(tool: FunctionTool, encoding: 'shell' | 'csv' | 'json'): string {
  const schema = tool.inputSchema as SchemaNode;
  const desc = tool.description ? ` — ${oneLine(tool.description)}` : '';
  if (encoding === 'json') {
    return `${tool.name}: <json>${desc}`;
  }
  if (!schema?.properties) {
    return `${tool.name}: ()${desc}`;
  }
  const required = new Set(schema.required ?? []);
  const props = Object.entries(schema.properties).map(([name, node]) => {
    const opt = required.has(name) ? '' : '?';
    const t = leafTypeLabel(node as SchemaNode);
    return encoding === 'csv' ? `${name}${opt}:${t}` : `${name}${opt}:${t}`;
  });
  return `${tool.name}: ${props.join(', ')}${desc}`;
}

function leafTypeLabel(node: SchemaNode): string {
  if (Array.isArray(node.enum)) {
    return node.enum.map(v => JSON.stringify(v)).join('|');
  }
  if (typeof node.type === 'string') {
    if (node.type === 'integer') return 'int';
    return node.type;
  }
  if (Array.isArray(node.type)) return node.type.join('|');
  return 'any';
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** Plan the encoding for every tool given the user's options. */
export function planTools(
  tools: FunctionTool[],
  options: Required<Pick<CompactToolsOptions, 'syntax' | 'fallbackToJson'>>,
): ToolPlan[] {
  return tools.map(tool => {
    const schema = tool.inputSchema as SchemaNode;
    const flat = isFlatObject(schema);
    let encoding: 'shell' | 'csv' | 'json' = options.syntax;
    if (!flat) {
      if (options.fallbackToJson === 'error') {
        throw new Error(
          `tool-reduce: tool "${tool.name}" has a non-flat input schema; ` +
            `set fallbackToJson:"complex" (default) to allow JSON encoding for it, ` +
            `or fallbackToJson:"force" to attempt flattening anyway.`,
        );
      }
      if (options.fallbackToJson === 'complex') encoding = 'json';
    }
    const required = new Set(schema?.required ?? []);
    const fields = schema?.properties
      ? Object.entries(schema.properties).map(([name, node]) => ({
          name,
          required: required.has(name),
          type: leafTypeLabel(node as SchemaNode),
        }))
      : [];
    return {
      name: tool.name,
      description: tool.description,
      signature: renderSignature(tool, encoding),
      encoding,
      fields,
      inputSchema: tool.inputSchema,
    };
  });
}
