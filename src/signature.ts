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
export function renderSignature(tool: FunctionTool, encoding: 'wire' | 'json' | 'kwargs'): string {
  const schema = tool.inputSchema as SchemaNode;
  const desc = tool.description ? ` — ${oneLine(tool.description)}` : '';
  if (encoding === 'json') {
    return `${tool.name}: <json>${desc}`;
  }
  if (!schema?.properties) {
    const parens = encoding === 'kwargs' ? '()' : '()';
    return `${tool.name}: ${parens}${desc}`;
  }
  const required = new Set(schema.required ?? []);
  // Build field descriptions
  let fieldParts: string[];
  
  if (encoding === 'kwargs') {
    // Template-style: param="", flag=false, count=0 — model fills in values
    // For nested objects, render inline: nested={sub1="", sub2=0}
    if (isWireCapable(schema)) {
      fieldParts = buildTemplateFields(schema, '', required);
    } else {
      fieldParts = Object.entries(schema.properties).map(([name]) => {
        return `${name}=`;
      });
    }
    return `${tool.name}(${fieldParts.join(', ')})${desc}`;
  }
  
  // wire format
  if (isWireCapable(schema)) {
    const fields = collectFlattenedPaths(schema, '', required);
    fieldParts = fields.map(f => `${f.name}${f.required ? '' : '?'}:${f.type}`);
  } else {
    fieldParts = Object.entries(schema.properties).map(([name, node]) => {
      const opt = required.has(name) ? '' : '?';
      const t = leafTypeLabel(node as SchemaNode);
      return `${name}${opt}:${t}`;
    });
  }
  return `${tool.name}: ${fieldParts.join(', ')}${desc}`;
}

/**
 * Build template-style kwargs fields with placeholder values:
 * - string → ""
 * - number/integer → 0
 * - boolean → false
 * - array → []
 * - nested object → {sub="", flag=false}
 * Optional params get a ? suffix: param?=""
 */
function buildTemplateFields(
  schema: SchemaNode,
  prefix: string,
  topLevelRequired: Set<string>,
): string[] {
  const out: string[] = [];
  if (!schema.properties) return out;
  for (const [name, node] of Object.entries(schema.properties)) {
    const key = prefix ? `${prefix}.${name}` : name;
    const required = prefix
      ? (schema.required ?? []).includes(name)
      : topLevelRequired.has(name);
    const opt = required ? '' : '?';
    if (node.type === 'object' && node.properties) {
      // Inline object: nested={sub1=""?, sub2?=0}
      const inner = buildTemplateFields(node, '', new Set(node.required ?? []));
      out.push(`${key}${opt}={${inner.join(', ')}}`);
    } else {
      out.push(`${key}${opt}=${templatePlaceholder(node)}`);
    }
  }
  return out;
}

/** Create a placeholder value that shows the type. */
function templatePlaceholder(node: SchemaNode): string {
  if (Array.isArray(node.enum)) {
    const first = node.enum[0];
    return typeof first === 'string' ? `"${first}"` : String(first);
  }
  if (typeof node.type === 'string') {
    if (node.type === 'string') return '""';
    if (node.type === 'number' || node.type === 'integer') return '0';
    if (node.type === 'boolean') return 'false';
    if (node.type === 'array') return '[]';
    if (node.type === 'object' && node.properties) {
      const inner = buildTemplateFields(node, '', new Set(node.required ?? []));
      return `{${inner.join(', ')}}`;
    }
  }
  return '""';
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
    let encoding: 'wire' | 'json' | 'kwargs' = options.syntax;
    
    if (!flat) {
      if (options.fallbackToJson === 'error') {
        throw new Error(
          `ai-sdk-wire-middleware: tool "${tool.name}" has a non-flat input schema; ` +
            `set fallbackToJson:"complex" (default) to allow JSON encoding for it, ` +
            `or fallbackToJson:"force" to attempt flattening anyway.`,
        );
      }
      if (options.fallbackToJson === 'complex') {
        // Use wire/kwargs for flattenable nested schemas, JSON for truly complex ones
        encoding = wireCapable ? options.syntax : 'json';
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
