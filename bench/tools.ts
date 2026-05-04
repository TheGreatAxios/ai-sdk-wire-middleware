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

export const bookMeeting = tool({
  description: 'Book a meeting room with optional projector and attendee list.',
  inputSchema: zodSchema(
    z.object({
      title: z.string(),
      date: z.string().describe('ISO 8601 date, e.g. 2026-05-15'),
      duration: z.number().int().describe('Duration in minutes'),
      attendees: z.array(z.string()).describe('List of attendee email addresses'),
      room: z.string(),
      requiresProjector: z.boolean().optional(),
    }),
  ),
  execute: async ({ title, date, duration, room }) =>
    `Booked "${title}" on ${date} for ${duration}min in ${room}`,
});

export const updateUserProfile = tool({
  description: 'Update a user\'s profile including nested address and preferences.',
  inputSchema: zodSchema(
    z.object({
      userId: z.string(),
      profile: z.object({
        displayName: z.string(),
        bio: z.string().optional(),
        address: z.object({
          street: z.string(),
          city: z.string(),
          country: z.string(),
        }),
        preferences: z.object({
          theme: z.enum(['light', 'dark', 'system']).optional(),
          notifications: z.boolean().optional(),
        }).optional(),
      }),
    }),
  ),
  execute: async ({ userId }) => `Profile updated for ${userId}`,
});

export const toggleFeature = tool({
  description: 'Enable or disable a feature flag.',
  inputSchema: zodSchema(
    z.object({
      name: z.string().describe('Feature flag name'),
      enable: z.boolean(),
    }),
  ),
  execute: async ({ name, enable }) =>
    `Feature "${name}" ${enable ? 'enabled' : 'disabled'}`,
});

export const analyzeSentiment = tool({
  description: 'Analyze the sentiment of a piece of text. Returns positive, negative, or neutral.',
  inputSchema: zodSchema(
    z.object({
      text: z.string(),
      language: z.string().optional().describe('ISO 639-1 language code, e.g. en, es, fr'),
    }),
  ),
  execute: async ({ text }) => {
    const positive = ['good', 'great', 'love', 'amazing', 'excellent'];
    const negative = ['bad', 'terrible', 'hate', 'awful', 'poor'];
    const lower = text.toLowerCase();
    if (positive.some(w => lower.includes(w))) return 'positive';
    if (negative.some(w => lower.includes(w))) return 'negative';
    return 'neutral';
  },
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
  {
    type: 'function' as const,
    name: 'bookMeeting',
    description: 'Book a meeting room with optional projector and attendee list.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        date: { type: 'string' },
        duration: { type: 'integer' },
        attendees: { type: 'array', items: { type: 'string' } },
        room: { type: 'string' },
        requiresProjector: { type: 'boolean' },
      },
      required: ['title', 'date', 'duration', 'attendees', 'room'],
    },
  },
  {
    type: 'function' as const,
    name: 'updateUserProfile',
    description: "Update a user's profile including nested address and preferences.",
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        profile: {
          type: 'object',
          properties: {
            displayName: { type: 'string' },
            bio: { type: 'string' },
            address: {
              type: 'object',
              properties: {
                street: { type: 'string' },
                city: { type: 'string' },
                country: { type: 'string' },
              },
              required: ['street', 'city', 'country'],
            },
            preferences: {
              type: 'object',
              properties: {
                theme: { type: 'string', enum: ['light', 'dark', 'system'] },
                notifications: { type: 'boolean' },
              },
            },
          },
          required: ['displayName', 'address'],
        },
      },
      required: ['userId', 'profile'],
    },
  },
  {
    type: 'function' as const,
    name: 'toggleFeature',
    description: 'Enable or disable a feature flag.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        enable: { type: 'boolean' },
      },
      required: ['name', 'enable'],
    },
  },
  {
    type: 'function' as const,
    name: 'analyzeSentiment',
    description: 'Analyze the sentiment of a piece of text.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        language: { type: 'string' },
      },
      required: ['text'],
    },
  },
];

// ─────────────────────────────────────────── representative invocations ──

export interface ToolCase {
  name: string;
  /** Native JSON tool call as the model would emit it via OpenAI/Anthropic. */
  nativeCall: { name: string; arguments: Record<string, unknown> };
  /** Compact representation we expect from the middleware. */
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
  {
    name: 'bookMeeting (6 args)',
    prompt:
      'Book a meeting titled \"Sprint Review\" on 2026-05-15 for 60 minutes ' +
      'with alice@co.com, bob@co.com in room A requiring a projector.',
    nativeCall: {
      name: 'bookMeeting',
      arguments: {
        title: 'Sprint Review',
        date: '2026-05-15',
        duration: 60,
        attendees: ['alice@co.com', 'bob@co.com'],
        room: 'A',
        requiresProjector: true,
      },
    },
    compactCall:
      '<call>bookMeeting title="Sprint Review" date=2026-05-15 duration=60 ' +
      'attendees=["alice@co.com","bob@co.com"] room="A" requiresProjector=true</call>',
  },
  {
    name: 'bookMeeting (required only)',
    prompt:
      'Book a meeting called \"Quick Sync\" on 2026-06-01 for 30 minutes ' +
      'with just me in Room B (no projector needed).',
    nativeCall: {
      name: 'bookMeeting',
      arguments: {
        title: 'Quick Sync',
        date: '2026-06-01',
        duration: 30,
        attendees: ['me@co.com'],
        room: 'B',
      },
    },
    compactCall:
      '<call>bookMeeting title="Quick Sync" date=2026-06-01 duration=30 ' +
      'attendees=["me@co.com"] room="B"</call>',
  },
  {
    name: 'updateUserProfile (nested)',
    prompt:
      'Update user abc123: set display name to \"Alice\", bio \"Engineer\", ' +
      'address 123 Main St, Austin, US, dark theme, notifications off.',
    nativeCall: {
      name: 'updateUserProfile',
      arguments: {
        userId: 'abc123',
        profile: {
          displayName: 'Alice',
          bio: 'Engineer',
          address: { street: '123 Main St', city: 'Austin', country: 'US' },
          preferences: { theme: 'dark', notifications: false },
        },
      },
    },
    compactCall:
      '<call>updateUserProfile userId=abc123 profile.displayName=Alice ' +
      'profile.bio=Engineer profile.address.street="123 Main St" ' +
      'profile.address.city=Austin profile.address.country=US ' +
      'profile.preferences.theme=dark profile.preferences.notifications=false</call>',
  },
  {
    name: 'getWeather (unicode)',
    prompt: 'What is the weather in México City?',
    nativeCall: { name: 'getWeather', arguments: { location: 'México City' } },
    compactCall: '<call>getWeather location="México City"</call>',
  },
  {
    name: 'sendEmail (internal quotes)',
    prompt:
      'Send email to ceo@co.com with subject \"Quote of the day\" ' +
      'and body The CEO said \"great job everyone\" at the all-hands.',
    nativeCall: {
      name: 'sendEmail',
      arguments: {
        to: 'ceo@co.com',
        subject: 'Quote of the day',
        body: 'The CEO said "great job everyone" at the all-hands',
      },
    },
    compactCall:
      '<call>sendEmail to="ceo@co.com" subject="Quote of the day" ' +
      'body="The CEO said \\"great job everyone\\" at the all-hands"</call>',
  },
  {
    name: 'askDb (long SQL)',
    prompt:
      'Run this query: ' +
      'SELECT u.name, u.email, o.total, o.status FROM users u ' +
      'JOIN orders o ON u.id = o.user_id WHERE o.status = \"pending\" ' +
      'AND o.total > 100 ORDER BY o.created_at DESC LIMIT 50',
    nativeCall: {
      name: 'askDb',
      arguments: {
        sql:
          'SELECT u.name, u.email, o.total, o.status FROM users u ' +
          'JOIN orders o ON u.id = o.user_id WHERE o.status = "pending" ' +
          'AND o.total > 100 ORDER BY o.created_at DESC',
        limit: 50,
      },
    },
    compactCall:
      '<call>askDb sql="SELECT u.name, u.email, o.total, o.status FROM users u ' +
      'JOIN orders o ON u.id = o.user_id WHERE o.status = \\"pending\\" ' +
      'AND o.total > 100 ORDER BY o.created_at DESC" limit=50</call>',
  },
  {
    name: 'toggleFeature (boolean only)',
    prompt: 'Turn on the new-dashboard feature flag.',
    nativeCall: {
      name: 'toggleFeature',
      arguments: { name: 'new-dashboard', enable: true },
    },
    compactCall: '<call>toggleFeature name="new-dashboard" enable=true</call>',
  },
  {
    name: 'analyzeSentiment (with optional)',
    prompt: 'Analyze the sentiment of \"I love this product!\" in English.',
    nativeCall: {
      name: 'analyzeSentiment',
      arguments: { text: 'I love this product!', language: 'en' },
    },
    compactCall:
      '<call>analyzeSentiment text="I love this product!" language=en</call>',
  },
  {
    name: 'listFiles (no recursive)',
    prompt: 'List files in the current directory (not recursive).',
    nativeCall: { name: 'listFiles', arguments: { directory: '.' } },
    compactCall: '<call>listFiles directory="."</call>',
  },
];

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
  bookMeeting,
  updateUserProfile,
  toggleFeature,
  analyzeSentiment,
};
