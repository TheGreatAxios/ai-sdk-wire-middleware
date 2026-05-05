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

/**
 * Check if a schema can be expressed in wire format.
 * Extends `isFlatObject` to also accept:
 * - Arrays of primitives / enums (e.g. `attendees: string[]`)
 * - Nested objects up to `maxDepth` that only contain primitive leaves at all leaf paths
 */
export function isWireCapable(schema: SchemaNode | undefined, maxDepth = 2): boolean {
  if (!schema || schema.type !== 'object' || !schema.properties) return false;
  for (const prop of Object.values(schema.properties)) {
    if (!isWireLeaf(prop, maxDepth)) return false;
  }
  return true;
}

function isWireLeaf(node: SchemaNode, depth: number): boolean {
  if (!node) return false;
  // Primitive types
  if (typeof node.type === 'string' && PRIMITIVE_TYPES.has(node.type)) return true;
  if (Array.isArray(node.type) && node.type.every(t => PRIMITIVE_TYPES.has(t) || t === 'null'))
    return true;
  // String/number/boolean enums
  if (Array.isArray(node.enum) && node.enum.every(v => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'))
    return true;
  // Arrays of wire-leaves (primitive or nested-object items)
  if (typeof node.type === 'string' && node.type === 'array' && node.items) {
    return isWireLeaf(node.items, depth);
  }
  // Nested objects — recurse if we still have depth
  if (typeof node.type === 'string' && node.type === 'object' && node.properties && depth > 0) {
    for (const prop of Object.values(node.properties)) {
      if (!isWireLeaf(prop as SchemaNode, depth - 1)) return false;
    }
    return true;
  }
  return false;
}

/**
 * Collect flattened field paths from a nested schema.
 * Returns entries like:
 *   { name: "profile.displayName", required: true, type: "string", leaf: true }
 *   { name: "profile.address.street", required: true, type: "string", leaf: true }
 */
function collectFlattenedPaths(
  schema: SchemaNode,
  prefix: string,
  topLevelRequired: Set<string>,
): Array<{ name: string; required: boolean; type: string }> {
  const out: Array<{ name: string; required: boolean; type: string }> = [];
  if (!schema.properties) return out;
  for (const [name, node] of Object.entries(schema.properties)) {
    const key = prefix ? `${prefix}.${name}` : name;
    const required = prefix
      ? (schema.required ?? []).includes(name)
      : topLevelRequired.has(name);

    if (node.type === 'object' && node.properties) {
      // Recurse into nested objects (this creates the flattened paths)
      out.push(...collectFlattenedPaths(node, key, new Set(schema.required ?? [])));
    } else {
      out.push({ name: key, required, type: leafTypeLabel(node) });
    }
  }
  return out;
}

/** Render a tool as a compact one-line signature. */
export function renderSignature(tool: FunctionTool, encoding: 'wire' | 'json' | 'yaml'): string {
  const schema = tool.inputSchema as SchemaNode;
  const desc = tool.description ? ` — ${oneLine(tool.description)}` : '';
  if (encoding === 'json') {
    return `${tool.name}: <json>${desc}`;
  }
  if (!schema?.properties) {
    if (encoding === 'yaml') return `${tool.name}: {}${desc}`;
    return `${tool.name}: ()${desc}`;
  }
  const required = new Set(schema.required ?? []);
  // For wire-capable nested schemas, use flattened paths
  if (isWireCapable(schema)) {
    const fields = collectFlattenedPaths(schema, '', required);
    if (encoding === 'yaml') {
      // YAML format: key: type, key?: type
      const parts = fields.map(f => `${f.name}${f.required ? '' : '?'}: ${f.type}`);
      return `${tool.name}: {${parts.join(', ')}}${desc}`;
    }
    const parts = fields.map(f => `${f.name}${f.required ? '' : '?'}:${f.type}`);
    return `${tool.name}: ${parts.join(', ')}${desc}`;
  }
  const props = Object.entries(schema.properties).map(([name, node]) => {
    const opt = required.has(name) ? '' : '?';
    const t = leafTypeLabel(node as SchemaNode);
    return encoding === 'yaml' ? `${name}${opt}: ${t}` : `${name}${opt}:${t}`;
  });
  if (encoding === 'yaml') {
    return `${tool.name}: {${props.join(', ')}}${desc}`;
  }
  return `${tool.name}: ${props.join(', ')}${desc}`;
}

function leafTypeLabel(node: SchemaNode): string {
  if (Array.isArray(node.enum)) {
    return node.enum.map(v => JSON.stringify(v)).join('|');
  }
  if (typeof node.type === 'string') {
    if (node.type === 'integer') return 'int';
    if (node.type === 'array' && node.items) {
      const inner = leafTypeLabel(node.items);
      if (inner === 'string' || inner === 'int' || inner === 'number' || inner === 'boolean') {
        return `${inner}[]`;
      }
      return `[${inner}]`;
    }
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
    const wireCapable = !flat && isWireCapable(schema);
    let encoding: 'wire' | 'json' | 'yaml' = options.syntax;
    
    // YAML uses the same capability model as wire
    if (options.syntax === 'yaml') {
      if (!flat && options.fallbackToJson === 'error') {
        throw new Error(
          `ai-sdk-wire-middleware: tool "${tool.name}" has a non-flat input schema; ` +
            `set fallbackToJson:"complex" (default) to allow JSON encoding for it, ` +
            `or fallbackToJson:"force" to attempt flattening anyway.`,
        );
      }
      if (!flat && options.fallbackToJson === 'complex') {
        encoding = wireCapable ? 'yaml' : 'json';
      }
    } else if (!flat) {
      if (options.fallbackToJson === 'error') {
        throw new Error(
          `ai-sdk-wire-middleware: tool "${tool.name}" has a non-flat input schema; ` +
            `set fallbackToJson:"complex" (default) to allow JSON encoding for it, ` +
            `or fallbackToJson:"force" to attempt flattening anyway.`,
        );
      }
      if (options.fallbackToJson === 'complex') {
        // Use wire for flattenable nested schemas, JSON for truly complex ones
        encoding = wireCapable ? 'wire' : 'json';
      }
    }

    const required = new Set(schema?.required ?? []);
    let fields: Array<{ name: string; required: boolean; type: string }>;

    if (flat || wireCapable) {
      // For both flat and flattenable nested schemas, build the full field list
      fields = schema?.properties
        ? collectFlattenedPaths(schema, '', required)
        : [];
    } else {
      // For JSON-encoded tools, just show top-level fields
      fields = schema?.properties
        ? Object.entries(schema.properties).map(([name, node]) => ({
            name,
            required: required.has(name),
            type: leafTypeLabel(node as SchemaNode),
          }))
        : [];
    }

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
