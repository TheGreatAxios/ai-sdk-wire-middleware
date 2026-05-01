/**
 * Shared tool catalogue used by every benchmark and example.
 *
 * Each entry is provided in TWO shapes:
 *   - `aiSdkTool` — a Vercel AI SDK `tool({ inputSchema, execute })` value, ready to
 *     drop into `generateText({ tools: { ... } })`.
 *   - `providerTool` — the raw `LanguageModelV3FunctionTool` shape used by the offline
 *     token / round-trip bench (which never goes through `generateText`).
 *
 * Plus a `cases` array of representative invocations for each tool so the benches
 * can compare native-JSON cost vs. compact cost on identical workloads.
 */
import { tool, zodSchema } from 'ai';
import { z } from 'zod';

// ─────────────────────────────────────────── tool definitions ──

export const getWeather = tool({
  description: 'Get the current weather for a location.',
  inputSchema: zodSchema(
    z.object({
      location: z.string().describe('City and country, e.g. "Austin, TX"'),
      units: z.enum(['metric', 'imperial']).optional(),
    }),
  ),
  execute: async ({ location, units }) => {
    const u = units ?? 'imperial';
    return `72°${u === 'metric' ? 'C' : 'F'} and sunny in ${location}`;
  },
});

export const getTime = tool({
  description: 'Get the current time in a given IANA timezone.',
  inputSchema: zodSchema(
    z.object({
      timezone: z.string().describe('IANA timezone, e.g. "America/Chicago"'),
    }),
  ),
  execute: async ({ timezone }) => {
    return new Date().toLocaleString('en-US', { timeZone: timezone });
  },
});

export const sendEmail = tool({
  description: 'Send an email to a recipient.',
  inputSchema: zodSchema(
    z.object({
      to: z.string(),
      subject: z.string(),
      body: z.string(),
      priority: z.enum(['low', 'normal', 'high']).optional(),
    }),
  ),
  execute: async ({ to, subject }) => `queued: ${subject} → ${to}`,
});

export const searchProducts = tool({
  description: 'Search a product catalogue.',
  inputSchema: zodSchema(
    z.object({
      query: z.string(),
      maxResults: z.number().int().optional(),
      inStock: z.boolean().optional(),
    }),
  ),
  execute: async ({ query, maxResults }) =>
    `found ${maxResults ?? 3} products for "${query}"`,
});

export const webFetch = tool({
  description: 'Fetch a URL and return its body as text.',
  inputSchema: zodSchema(
    z.object({
      url: z.string().url(),
      method: z.enum(['GET', 'POST']).optional(),
    }),
  ),
  execute: async ({ url, method }) => {
    const res = await fetch(url, { method: method ?? 'GET' });
    return (await res.text()).slice(0, 4_000);
  },
});

export const calculate = tool({
  description: 'Evaluate a basic arithmetic expression. Supports + - * / ( ).',
  inputSchema: zodSchema(
    z.object({
      expression: z.string(),
    }),
  ),
  execute: async ({ expression }) => {
    // Tiny safe evaluator — digits, ops, parens, decimals only.
    if (!/^[\d+\-*/().\s]+$/.test(expression)) throw new Error('illegal characters');
    // eslint-disable-next-line no-new-func
    const value = Function(`"use strict"; return (${expression});`)();
    return String(value);
  },
});

export const listFiles = tool({
  description: 'List files in a directory.',
  inputSchema: zodSchema(
    z.object({
      directory: z.string(),
      recursive: z.boolean().optional(),
    }),
  ),
  execute: async ({ directory }) => `[${directory}] file1.txt, file2.md, README.md`,
});

export const setReminder = tool({
  description: 'Set a reminder at a future ISO timestamp.',
  inputSchema: zodSchema(
    z.object({
      message: z.string(),
      atIso: z.string().describe('ISO 8601 timestamp'),
      channel: z.enum(['push', 'email', 'sms']).optional(),
    }),
  ),
  execute: async ({ message, atIso }) => `reminder set: ${message} @ ${atIso}`,
});

export const askDb = tool({
  description: 'Run a read-only SQL query against the analytics database.',
  inputSchema: zodSchema(
    z.object({
      sql: z.string(),
      limit: z.number().int().optional(),
    }),
  ),
  execute: async ({ sql, limit }) => `[${limit ?? 10} rows for: ${sql.slice(0, 40)}…]`,
});

export const allAiSdkTools = {
  getWeather,
  getTime,
  sendEmail,
  searchProducts,
  webFetch,
  calculate,
  listFiles,
  setReminder,
  askDb,
};

// ─────────────────────────────────────────── provider-shape (for bench) ──

export const providerTools = [
  {
    type: 'function' as const,
    name: 'getWeather',
    description: 'Get the current weather for a location.',
    inputSchema: {
      type: 'object',
      properties: {
        location: { type: 'string' },
        units: { type: 'string', enum: ['metric', 'imperial'] },
      },
      required: ['location'],
    },
  },
  {
    type: 'function' as const,
    name: 'getTime',
    description: 'Get the current time in a given IANA timezone.',
    inputSchema: {
      type: 'object',
      properties: { timezone: { type: 'string' } },
      required: ['timezone'],
    },
  },
  {
    type: 'function' as const,
    name: 'sendEmail',
    description: 'Send an email to a recipient.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    type: 'function' as const,
    name: 'searchProducts',
    description: 'Search a product catalogue.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        maxResults: { type: 'integer' },
        inStock: { type: 'boolean' },
      },
      required: ['query'],
    },
  },
  {
    type: 'function' as const,
    name: 'webFetch',
    description: 'Fetch a URL and return its body as text.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        method: { type: 'string', enum: ['GET', 'POST'] },
      },
      required: ['url'],
    },
  },
  {
    type: 'function' as const,
    name: 'calculate',
    description: 'Evaluate a basic arithmetic expression.',
    inputSchema: {
      type: 'object',
      properties: { expression: { type: 'string' } },
      required: ['expression'],
    },
  },
  {
    type: 'function' as const,
    name: 'listFiles',
    description: 'List files in a directory.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string' },
        recursive: { type: 'boolean' },
      },
      required: ['directory'],
    },
  },
  {
    type: 'function' as const,
    name: 'setReminder',
    description: 'Set a reminder at a future ISO timestamp.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        atIso: { type: 'string' },
        channel: { type: 'string', enum: ['push', 'email', 'sms'] },
      },
      required: ['message', 'atIso'],
    },
  },
  {
    type: 'function' as const,
    name: 'askDb',
    description: 'Run a read-only SQL query against the analytics database.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string' },
        limit: { type: 'integer' },
      },
      required: ['sql'],
    },
  },
];

// ─────────────────────────────────────────── representative invocations ──

export interface ToolCase {
  name: string;
  /** Native JSON tool call as the model would emit it via OpenAI/Anthropic. */
  nativeCall: { name: string; arguments: Record<string, unknown> };
  /** Compact representation we expect from `tool-reduce`. */
  compactCall: string;
  /** A natural-language prompt that should elicit this exact call. */
  prompt: string;
}

export const cases: ToolCase[] = [
  {
    name: 'getWeather (1 required)',
    prompt: 'What is the weather in Austin?',
    nativeCall: { name: 'getWeather', arguments: { location: 'Austin' } },
    compactCall: '<call>getWeather location="Austin"</call>',
  },
  {
    name: 'getWeather (2 args, metric)',
    prompt: 'What is the weather in New York in metric?',
    nativeCall: { name: 'getWeather', arguments: { location: 'New York', units: 'metric' } },
    compactCall: '<call>getWeather location="New York" units=metric</call>',
  },
  {
    name: 'getTime',
    prompt: 'What time is it in Tokyo right now?',
    nativeCall: { name: 'getTime', arguments: { timezone: 'Asia/Tokyo' } },
    compactCall: '<call>getTime timezone="Asia/Tokyo"</call>',
  },
  {
    name: 'sendEmail (4 args)',
    prompt:
      'Send an email to alice@example.com with subject "Lunch?" and body "Free at 12:30?", priority normal.',
    nativeCall: {
      name: 'sendEmail',
      arguments: {
        to: 'alice@example.com',
        subject: 'Lunch?',
        body: 'Free at 12:30?',
        priority: 'normal',
      },
    },
    compactCall:
      '<call>sendEmail to="alice@example.com" subject="Lunch?" body="Free at 12:30?" priority=normal</call>',
  },
  {
    name: 'searchProducts (mixed types)',
    prompt: 'Search for noise cancelling headphones, max 5 results, only in-stock.',
    nativeCall: {
      name: 'searchProducts',
      arguments: { query: 'noise cancelling headphones', maxResults: 5, inStock: true },
    },
    compactCall:
      '<call>searchProducts query="noise cancelling headphones" maxResults=5 inStock=true</call>',
  },
  {
    name: 'webFetch (GET)',
    prompt: 'Fetch https://example.com and tell me the title.',
    nativeCall: { name: 'webFetch', arguments: { url: 'https://example.com' } },
    compactCall: '<call>webFetch url="https://example.com"</call>',
  },
  {
    name: 'calculate',
    prompt: 'What is (12 + 7) * 3?',
    nativeCall: { name: 'calculate', arguments: { expression: '(12 + 7) * 3' } },
    compactCall: '<call>calculate expression="(12 + 7) * 3"</call>',
  },
  {
    name: 'listFiles (recursive)',
    prompt: 'List files under ./src recursively.',
    nativeCall: { name: 'listFiles', arguments: { directory: './src', recursive: true } },
    compactCall: '<call>listFiles directory="./src" recursive=true</call>',
  },
  {
    name: 'setReminder',
    prompt: 'Remind me to "stand up" at 2026-05-01T17:00:00Z via push.',
    nativeCall: {
      name: 'setReminder',
      arguments: { message: 'stand up', atIso: '2026-05-01T17:00:00Z', channel: 'push' },
    },
    compactCall:
      '<call>setReminder message="stand up" atIso="2026-05-01T17:00:00Z" channel=push</call>',
  },
  {
    name: 'askDb',
    prompt: 'Query the database: SELECT * FROM users WHERE active = true; limit 100',
    nativeCall: {
      name: 'askDb',
      arguments: { sql: 'SELECT * FROM users WHERE active = true', limit: 100 },
    },
    compactCall:
      '<call>askDb sql="SELECT * FROM users WHERE active = true" limit=100</call>',
  },
];
