/**
 * tool-reduce — multi-step agent benchmark
 * --------------------------------------------------------------
 * Runs a set of multi-step agent tasks across models, comparing native JSON
 * tool-calling vs. compact `<call>` protocol. Each task defines a prompt,
 * expected tool sequence, and a deterministic success check.
 *
 * Tools return stub data so success is verifiable offline of providers.
 *
 * Usage:
 *   OPENROUTER_API_KEY=sk-or-... bun run bench/agent.ts
 *   OPENROUTER_API_KEY=sk-or-... bun run bench/agent.ts --models minimax/minimax-m2.5:free
 *   OPENROUTER_API_KEY=sk-or-... bun run bench/agent.ts --reps 1
 *   OPENROUTER_API_KEY=sk-or-... bun run bench/agent.ts --resume bench/results/latest-agent.jsonl
 *
 *   # Or use any OpenAI-compatible provider (no OpenRouter key needed):
 *   ZAI_BASE_URL=https://api.z.ai/v1 ZAI_API_KEY=sk-... ZAI_MODEL=glm-4.5-air:free \
 *     bun run bench/agent.ts --reps 1 --cases tx-cities-weather-email
 */
import { generateText, wrapLanguageModel, tool, zodSchema } from 'ai';
import { z } from 'zod';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createOpenAI } from '@ai-sdk/openai';
import { compactTools } from '../src/index.ts';
import { parseArgs, helpText } from './lib/cli.ts';
import {
  newRunId,
  appendRow,
  loadRows,
  updateLatestPointer,
  artifactPath,
  type ArtifactRow,
} from './lib/artifact.ts';
import { resolveModels } from './lib/models.ts';
import { agentTasks, type AgentStep, type AgentTask } from './agent-tasks.ts';

// Stub tool responses for deterministic checking.
const stubData: Record<string, (args: Record<string, unknown>) => string> = {
  getWeather: (args) => {
    const city = String(args.location ?? '').split(',')[0]!;
    return `72°F and sunny in ${city}`;
  },
  getTime: () => new Date().toLocaleString('en-US', { timeZone: 'UTC' }),
  sendEmail: (args) => `queued: ${args.subject} → ${args.to}`,
  searchProducts: (args) => `found ${args.maxResults ?? 3} products for "${args.query}"`,
  webFetch: () => `<!DOCTYPE html><html><body>Example Domain</body></html>`,
  calculate: (args) => {
    if (!/^[\d+\-*/().\s]+$/.test(String(args.expression ?? '')))
      throw new Error('illegal characters');
    // eslint-disable-next-line no-new-func
    return String(Function(`"use strict"; return (${args.expression});`)());
  },
  listFiles: () => `[./src] index.ts, parser.ts, serialize.ts, transform-params.ts`,
  setReminder: (args) => `reminder set: ${args.message} @ ${args.atIso}`,
  askDb: (args) => `[${args.limit ?? 10} rows for: ${String(args.sql ?? '').slice(0, 40)}…]`,
};

// Build stub tools identical to the real ones but with deterministic execute.
function buildStubTools(task: AgentTask): Record<string, any> {
  const tools: Record<string, any> = {};
  for (const name of task.tools) {
    const def = toolDefs[name];
    if (def) tools[name] = def;
  }
  return tools;
}

const toolDefs: Record<string, any> = {
  getWeather: tool({
    description: 'Get the current weather for a location.',
    inputSchema: zodSchema(z.object({
      location: z.string().describe('City and country, e.g. "Austin, TX"'),
      units: z.enum(['metric', 'imperial']).optional(),
    })),
    execute: async (args) => stubData.getWeather!(args as Record<string, unknown>),
  }),
  getTime: tool({
    description: 'Get the current time in a given IANA timezone.',
    inputSchema: zodSchema(z.object({
      timezone: z.string().describe('IANA timezone, e.g. "America/Chicago"'),
    })),
    execute: async (args) => stubData.getTime!(args as Record<string, unknown>),
  }),
  sendEmail: tool({
    description: 'Send an email to a recipient.',
    inputSchema: zodSchema(z.object({
      to: z.string(),
      subject: z.string(),
      body: z.string(),
      priority: z.enum(['low', 'normal', 'high']).optional(),
    })),
    execute: async (args) => stubData.sendEmail!(args as Record<string, unknown>),
  }),
  searchProducts: tool({
    description: 'Search a product catalogue.',
    inputSchema: zodSchema(z.object({
      query: z.string(),
      maxResults: z.number().int().optional(),
      inStock: z.boolean().optional(),
    })),
    execute: async (args) => stubData.searchProducts!(args as Record<string, unknown>),
  }),
  webFetch: tool({
    description: 'Fetch a URL and return its body as text.',
    inputSchema: zodSchema(z.object({
      url: z.string().url(),
      method: z.enum(['GET', 'POST']).optional(),
    })),
    execute: async (args) => stubData.webFetch!(args as Record<string, unknown>),
  }),
  calculate: tool({
    description: 'Evaluate a basic arithmetic expression.',
    inputSchema: zodSchema(z.object({
      expression: z.string(),
    })),
    execute: async (args) => stubData.calculate!(args as Record<string, unknown>),
  }),
  listFiles: tool({
    description: 'List files in a directory.',
    inputSchema: zodSchema(z.object({
      directory: z.string(),
      recursive: z.boolean().optional(),
    })),
    execute: async (args) => stubData.listFiles!(args as Record<string, unknown>),
  }),
  setReminder: tool({
    description: 'Set a reminder at a future ISO timestamp.',
    inputSchema: zodSchema(z.object({
      message: z.string(),
      atIso: z.string().describe('ISO 8601 timestamp'),
      channel: z.enum(['push', 'email', 'sms']).optional(),
    })),
    execute: async (args) => stubData.setReminder!(args as Record<string, unknown>),
  }),
  askDb: tool({
    description: 'Run a read-only SQL query against the analytics database.',
    inputSchema: zodSchema(z.object({
      sql: z.string(),
      limit: z.number().int().optional(),
    })),
    execute: async (args) => stubData.askDb!(args as Record<string, unknown>),
  }),
};

// Record steps as they happen (mutable, captured by the middleware wrapper).
function makeStepRecorder(steps: AgentStep[]) {
  return {
    record(toolName: string, args: Record<string, unknown>, result: unknown) {
      steps.push({ toolName, args, result });
    },
  };
}

// ─────────────────────────────────────────────────────── main ──

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(helpText());
    process.exit(0);
  }

  // ── Providers ──
  const zaiBaseUrl = process.env['ZAI_BASE_URL'];
  const zaiApiKey = process.env['ZAI_API_KEY'];
  const zaiModel  = process.env['ZAI_MODEL'];
  const zaiClient = zaiBaseUrl && zaiApiKey && zaiModel
    ? createOpenAI({ baseURL: zaiBaseUrl.replace(/\/$/, '') + '/', apiKey: zaiApiKey })
    : null;

  const openrouterApiKey = process.env['OPENROUTER_API_KEY'];
  const openrouter = openrouterApiKey ? createOpenRouter({ apiKey: openrouterApiKey }) : null;

  if (!zaiClient && !openrouter) {
    console.error('✗ No provider configured. Set either:');
    console.error('    OPENROUTER_API_KEY  — or —');
    console.error('    ZAI_BASE_URL + ZAI_API_KEY + ZAI_MODEL');
    process.exit(1);
  }

  const reps = args.reps ?? 3;
  const kind: ArtifactRow['kind'] = 'agent';
  const runId = newRunId(kind);
  const outPath = args.out ?? artifactPath(runId);
  const models = resolveModels(args.models, zaiClient ? zaiModel : undefined);

  // Filter tasks by --cases CSV if provided.
  let activeTasks: AgentTask[] = agentTasks;
  if (args.cases) {
    const wanted = new Set(args.cases);
    activeTasks = agentTasks.filter(t => wanted.has(t.name));
    if (activeTasks.length === 0) {
      console.error('✗ No matching tasks for --cases', args.cases);
      process.exit(1);
    }
  }

  // Build cell plan.
  interface Cell {
    model: string;
    taskName: string;
    mode: 'json' | 'compact';
    rep: number;
    key: string;
  }

  const cells: Cell[] = [];
  for (const m of models) {
    for (const t of activeTasks) {
      for (const mode of ['json', 'compact'] as const) {
        for (let rep = 1; rep <= reps; rep++) {
          cells.push({
            model: m.slug,
            taskName: t.name,
            mode,
            rep,
            key: `agent|${m.slug}|${t.name}|${mode}|${rep}|_`,
          });
        }
      }
    }
  }

  // --resume: skip already-present cells.
  let skipSet = new Set<string>();
  if (args.resume) {
    const existing = loadRows(args.resume);
    skipSet = new Set(existing.filter(r => r.ok).map(r =>
      `agent|${r.model}|${r.case}|${r.mode}|${r.rep}|_`,
    ));
  }
  const pending = cells.filter(c => !skipSet.has(c.key));

  console.log('=== tool-reduce agent benchmark ===');
  console.log(`runId:       ${runId}`);
  console.log(`artifact:    ${outPath}`);
  if (args.resume) console.log(`resume:      ${args.resume}  (${skipSet.size} existing, ${pending.length} pending)`);
  console.log(`models:      ${models.map(m => m.label).join(', ')}`);
  console.log(`tasks:       ${activeTasks.map(t => t.name).join(', ')}`);
  console.log(`reps:        ${reps}`);
  console.log(`total cells: ${cells.length} (${pending.length} pending)\n`);

  if (args.dry) {
    console.log('--dry: printing plan and exiting.');
    process.exit(0);
  }

  if (pending.length === 0) {
    console.log('All cells already present. Nothing to do.');
    process.exit(0);
  }

  let done = 0;
  const errors: string[] = [];

  for (const cell of pending) {
    const task = activeTasks.find(t => t.name === cell.taskName)!;
    // Resolve the model provider — use ZAI client when the cell model matches ZAI_MODEL.
    const useZai = zaiClient && zaiModel && cell.model === zaiModel;
    if (!useZai && !openrouter) {
      console.error(`✗ Model "${cell.model}" requires OpenRouter but no OPENROUTER_API_KEY is set.`);
      console.error('  Either set OPENROUTER_API_KEY or use a model matching ZAI_MODEL.');
      process.exit(1);
    }
    const rawModel = useZai
      ? zaiClient!.chat(cell.model)
      : openrouter!.chat(cell.model);
    const selectedTools = buildStubTools(task);
    const model = cell.mode === 'compact'
      ? wrapLanguageModel({ model: rawModel, middleware: compactTools() })
      : rawModel;

    const steps: AgentStep[] = [];
    const recorder = makeStepRecorder(steps);

    // Wrap tool executes to record steps.
    const instrumentedTools: Record<string, any> = {};
    for (const [name, t] of Object.entries(selectedTools)) {
      const originalExecute = (t as any).execute;
      instrumentedTools[name] = tool({
        description: (t as any)._def?.description ?? '',
        inputSchema: (t as any)._def?.schema ?? zodSchema(z.any()),
        execute: async (args: any) => {
          const result = await originalExecute(args);
          recorder.record(name, args as Record<string, unknown>, result);
          return result;
        },
      });
    }

    const t0 = performance.now();
    const row: ArtifactRow = {
      schemaVersion: 1,
      runId,
      ts: new Date().toISOString(),
      kind,
      model: cell.model,
      case: cell.taskName,
      mode: cell.mode,
      rep: cell.rep,
      ok: false,
    };

    try {
      const res = await generateText({
        model,
        tools: instrumentedTools as any,
        prompt: task.prompt,
        stopWhen: ({ steps: s }) => s.length >= 8,
        temperature: 0,
        maxOutputTokens: 4096,
      });

      const elapsed = Math.round(performance.now() - t0);

      row.inputTokens = res.usage?.inputTokens;
      row.outputTokens = res.usage?.outputTokens;
      row.elapsedMs = elapsed;

      // Log all steps for the record.
      row.extra = {
        steps: steps.map(s => ({
          toolName: s.toolName,
          args: s.args,
        })),
        finalMessage: res.text?.slice(0, 500),
      };

      // Run the success check.
      const verdict = task.successCheck(steps, res.text ?? '');
      row.ok = verdict.ok;
      if (!verdict.ok) {
        row.error = verdict.reason;
      }

      const flag = verdict.ok ? '✓' : '≈';
      console.log(
        `${flag} [${cell.model.padEnd(30)}] [${cell.mode.padEnd(7)}] rep=${cell.rep} ${cell.taskName.padEnd(36)}  ` +
        `${steps.map(s => s.toolName).join('→') || '(no calls)'}  ` +
        `in=${res.usage?.inputTokens ?? '?'} out=${res.usage?.outputTokens ?? '?'} ${elapsed}ms  ` +
        `${verdict.ok ? '' : verdict.reason}`,
      );
    } catch (err) {
      const elapsed = Math.round(performance.now() - t0);
      const message = (err as Error).message ?? String(err);
      row.ok = false;
      row.error = message.slice(0, 400);
      row.elapsedMs = elapsed;
      errors.push(`${cell.model}/${cell.taskName}/${cell.mode}/${cell.rep}: ${message.slice(0, 100)}`);

      console.log(
        `✗ [${cell.model.padEnd(30)}] [${cell.mode.padEnd(7)}] rep=${cell.rep} ${cell.taskName.padEnd(36)}  ` +
        `ERROR: ${message.slice(0, 80)}`,
      );
    }

    appendRow(outPath, row);
    done++;

    if (done % 5 === 0) updateLatestPointer(runId);
  }

  updateLatestPointer(runId);

  // ── Summary ──
  const allRows = loadRows(outPath);
  const jsonRows = allRows.filter(r => r.mode === 'json' && r.ok);
  const compactRows = allRows.filter(r => r.mode === 'compact' && r.ok);

  console.log('\n=== agent benchmark summary ===');
  console.log(`JSON:    ${jsonRows.length}/${allRows.filter(r => r.mode === 'json').length} success`);
  console.log(`Compact: ${compactRows.length}/${allRows.filter(r => r.mode === 'compact').length} success`);
  if (errors.length > 0) {
    console.log(`\n${errors.length} errors:`);
    for (const e of errors.slice(0, 5)) console.log(`  ${e}`);
    if (errors.length > 5) console.log(`  … and ${errors.length - 5} more`);
  }
  console.log(`\nArtifact: ${outPath}`);
}

await main();
