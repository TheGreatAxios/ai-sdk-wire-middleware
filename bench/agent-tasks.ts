/**
 * Multi-step agent benchmark tasks.
 *
 * Each task has:
 *  - name
 *  - prompt     (natural-language instruction for the LLM)
 *  - tools      (names of tools from `allAiSdkTools` that should be available)
 *  - expectedToolSequence (ordered set of tool names the agent should call — loose match)
 *  - successCheck(steps): returns `{ ok, reason }`
 *
 * All tools return deterministic stub data so success is checkable offline.
 */
export interface AgentStep {
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
}

export interface AgentTask {
  name: string;
  prompt: string;
  tools: string[];
  expectedToolSequence: string[];
  successCheck: (steps: AgentStep[], finalMessage: string) => { ok: boolean; reason: string };
}

export const agentTasks: AgentTask[] = [
  {
    name: 'tx-cities-weather-email',
    prompt:
      'Get the weather in Houston, Dallas, and Austin all in imperial units. ' +
      'Then send an email to weather@example.com with subject "TX Weather Summary" and ' +
      'body containing the three forecasts. Priority normal.',
    tools: ['getWeather', 'sendEmail'],
    expectedToolSequence: ['getWeather', 'getWeather', 'getWeather', 'sendEmail'],
    successCheck: (steps) => {
      const weatherCalls = steps.filter(s => s.toolName === 'getWeather');
      const emailCalls = steps.filter(s => s.toolName === 'sendEmail');
      if (weatherCalls.length < 3)
        return { ok: false, reason: `expected ≥3 getWeather calls, got ${weatherCalls.length}` };
      if (emailCalls.length < 1)
        return { ok: false, reason: 'expected ≥1 sendEmail call, got 0' };
      const locations = weatherCalls.map(s => (s.args as any).location).filter(Boolean);
      if (!locations.some((l: string) => l.toLowerCase().includes('houst')))
        return { ok: false, reason: `Houston not found in weather calls: ${locations}` };
      if (!locations.some((l: string) => l.toLowerCase().includes('dalla')))
        return { ok: false, reason: `Dallas not found in weather calls: ${locations}` };
      if (!locations.some((l: string) => l.toLowerCase().includes('aust')))
        return { ok: false, reason: `Austin not found in weather calls: ${locations}` };
      return { ok: true, reason: `3 weather calls + 1 email` };
    },
  },

  {
    name: 'search-then-fetch',
    prompt:
      'Search for "wireless earbuds" with max 3 results, in stock only. ' +
      'Take the first result URL and fetch it. Then calculate 29.99 * 1.08 (price with tax).',
    tools: ['searchProducts', 'webFetch', 'calculate'],
    expectedToolSequence: ['searchProducts', 'webFetch', 'calculate'],
    successCheck: (steps) => {
      const search = steps.find(s => s.toolName === 'searchProducts');
      if (!search) return { ok: false, reason: 'no searchProducts call' };
      const { query, maxResults, inStock } = search.args as any;
      if (!query?.toLowerCase().includes('earbud'))
        return { ok: false, reason: `search query missing "earbuds": ${query}` };
      const calc = steps.find(s => s.toolName === 'calculate');
      if (!calc) return { ok: false, reason: 'no calculate call' };
      return { ok: true, reason: 'search → fetch → calculate chain complete' };
    },
  },

  {
    name: 'db-then-email',
    prompt:
      'Query the database: SELECT * FROM users WHERE active = true order by signup_date desc. ' +
      'Limit 50. Then email the result count to admin@example.com with subject "Active Users Report".',
    tools: ['askDb', 'sendEmail'],
    expectedToolSequence: ['askDb', 'sendEmail'],
    successCheck: (steps) => {
      const db = steps.find(s => s.toolName === 'askDb');
      if (!db) return { ok: false, reason: 'no askDb call' };
      const { sql, limit } = db.args as any;
      if (!sql?.toLowerCase().includes('active'))
        return { ok: false, reason: `SQL missing active filter: ${sql}` };
      if (limit !== 50) return { ok: false, reason: `expected limit=50, got ${limit}` };
      const email = steps.find(s => s.toolName === 'sendEmail');
      if (!email) return { ok: false, reason: 'no sendEmail call' };
      return { ok: true, reason: 'query + email complete' };
    },
  },

  {
    name: 'time-around-world',
    prompt:
      'Get the current time in New York (America/New_York), London (Europe/London), ' +
      'Tokyo (Asia/Tokyo), and Sydney (Australia/Sydney). Then summarize the times.',
    tools: ['getTime'],
    expectedToolSequence: ['getTime', 'getTime', 'getTime', 'getTime'],
    successCheck: (steps) => {
      const timeCalls = steps.filter(s => s.toolName === 'getTime');
      if (timeCalls.length < 4)
        return { ok: false, reason: `expected 4 getTime calls, got ${timeCalls.length}` };
      const timezones = timeCalls.map(s => (s.args as any).timezone).filter(Boolean);
      const expected = ['America/New_York', 'Europe/London', 'Asia/Tokyo', 'Australia/Sydney'];
      for (const tz of expected) {
        if (!timezones.some((t: string) => t.includes(tz.replace('America/', '').replace('Europe/', '').replace('Asia/', '').replace('Australia/', ''))))
          return { ok: false, reason: `timezone ${tz} not found in calls: ${timezones}` };
      }
      return { ok: true, reason: `all 4 timezones queried` };
    },
  },

  {
    name: 'reminder-cascade',
    prompt:
      'Set three reminders: (1) "Meeting with Alice" at 2026-05-02T14:00:00Z via email, ' +
      '(2) "Pick up groceries" at 2026-05-02T17:00:00Z via push, ' +
      '(3) "Evening standup" at 2026-05-02T18:30:00Z via sms.',
    tools: ['setReminder'],
    expectedToolSequence: ['setReminder', 'setReminder', 'setReminder'],
    successCheck: (steps) => {
      if (steps.length < 3)
        return { ok: false, reason: `expected 3 setReminder calls, got ${steps.length}` };
      const messages = steps.map(s => (s.args as any).message).filter(Boolean);
      if (!messages.some(m => m?.toLowerCase().includes('alice')))
        return { ok: false, reason: `"Meeting with Alice" not found: ${messages}` };
      if (!messages.some(m => m?.toLowerCase().includes('grocer')))
        return { ok: false, reason: `"Pick up groceries" not found: ${messages}` };
      if (!messages.some(m => m?.toLowerCase().includes('standup') || m?.toLowerCase().includes('stand')))
        return { ok: false, reason: `"Evening standup" not found: ${messages}` };
      return { ok: true, reason: `all 3 reminders set` };
    },
  },

  {
    name: 'files-then-fetch',
    prompt:
      'List files in the ./src directory recursively. Pick the first .ts file listed ' +
      'and search the web for documentation about it. Also fetch the example.com homepage.',
    tools: ['listFiles', 'webFetch'],
    expectedToolSequence: ['listFiles', 'webFetch'],
    successCheck: (steps) => {
      const list = steps.find(s => s.toolName === 'listFiles');
      if (!list) return { ok: false, reason: 'no listFiles call' };
      const { directory, recursive } = list.args as any;
      if (!directory?.includes('./src'))
        return { ok: false, reason: `expected ./src directory, got ${directory}` };
      const fetchCalls = steps.filter(s => s.toolName === 'webFetch');
      if (fetchCalls.length < 1)
        return { ok: false, reason: 'expected at least 1 webFetch call' };
      return { ok: true, reason: 'listFiles + webFetch complete' };
    },
  },
];
