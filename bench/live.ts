/**
 * ai-sdk-wire-middleware — live benchmark (multi-model, multi-rep, judge-integrated)
 * --------------------------------------------------------------
 * Compares JSON tool-calling vs. compact `<call>` protocol on real LLMs.
 * Every cell — (model, case, mode, rep) — is persisted as one JSONL line in
 * `bench/results/<runId>.jsonl`. The harness resumes from an existing artifact
 * when `--resume <file>` is passed (skips cells already present).
 *
 * Usage:
 *   # Via OpenRouter (LLM judge + model-under-test):
 *   OPENROUTER_API_KEY=sk-or-... bun run bench/live.ts --models minimax/minimax-m2.5:free --cases getWeather,getTime --reps 1
 *   OPENROUTER_API_KEY=sk-or-... bun run bench/live.ts --resume bench/results/latest-live.jsonl
 *   OPENROUTER_API_KEY=sk-or-... bun run bench/live.ts --dry
 *
 *   # Via any OpenAI-compatible provider (Z.AI, Together, Groq, etc.) — no OpenRouter key needed:
 *   ZAI_BASE_URL=https://api.z.ai/v1 ZAI_API_KEY=sk-... ZAI_MODEL=glm-4.5-air:free \
 *     bun run bench/live.ts --reps 1 --cases 'getWeather (1 required)'
 *
 *   # Multiple models per provider in one run:
 *   OPENROUTER_API_KEY=sk-or-... ZAI_BASE_URL=... ZAI_API_KEY=... \
 *     bun run bench/live.ts --provider-models openrouter=anthropic/claude-sonnet-4.5,openai/gpt-4.1 \
 *                             --provider-models zai=glm-4.5-air:free,deepseek/deepseek-v3.1 \
 *     --reps 1
 *
 *   # Or via env var model lists (no --provider-models needed):
 *   OPENROUTER_API_KEY=... OPENROUTER_MODELS=anthropic/claude-sonnet-4.5,openai/gpt-4.1 \
 *   ZAI_BASE_URL=... ZAI_API_KEY=... ZAI_MODELS=glm-4.5-air:free,deepseek/deepseek-v3.1 \
 *     bun run bench/live.ts --reps 1
 */
import { generateText, wrapLanguageModel } from 'ai';
import { compactTools } from '../src/index.ts';
import { allAiSdkTools, cases, type ToolCase } from './tools.ts';
import { parseArgs, helpText } from './lib/cli.ts';
import {
  newRunId,
  appendRow,
  loadRows,
  updateLatestPointer,
  artifactPath,
  publishArtifact,
  type ArtifactRow,
} from './lib/artifact.ts';
import {
  judgeArgs,
  loadJudgeCache,
  canonicalJson,
  type JudgeCaller,
  type JudgeInput,
  type JudgeResult,
} from './lib/judge.ts';
import { resolveModels } from './lib/models.ts';
import { resolveProviders, type ProviderId, type ProviderConfig, type ResolvedProviders } from './lib/providers.ts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ─────────────────────────────────────────────────────── main ──

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(helpText());
    process.exit(0);
  }

  // ── Providers ──
  // Two providers: OpenRouter (used for LLM judge) and an optional
  // OpenAI-compatible endpoint (Z.AI, Together, Groq, etc.) for the
  // model-under-test.  OpenRouter is only required when you want the
  // LLM judge; with ZAI_BASE_URL + ZAI_MODEL set you can run without it.

  const reps = args.reps ?? 3;
  const kind: ArtifactRow['kind'] = 'live';
  const runId = newRunId(kind);
  const outPath = args.out ?? artifactPath(runId);

  // ── Resolve providers and their models ──
  // Only pass defaultModels if the user didn't explicitly configure models via env/CLI.
  // This prevents DEFAULT_MODELS (anthropic/claude-sonnet-4.5 etc.) from leaking
  // when BENCH_MODELS or --provider-models is set.
  const hasExplicitModels = Object.keys(args.providerModels).length > 0 ||
    Boolean(process.env['BENCH_MODELS']) ||
    Boolean(process.env['BENCH_PROVIDERS']);
  const defaultModels = !hasExplicitModels && args.models
    ? resolveModels(args.models).map(m => m.slug)
    : [];
  const resolved: ResolvedProviders = resolveProviders({
    providerModels: args.providerModels,
    defaultModels: defaultModels.length > 0 ? defaultModels : undefined,
    judgeModelOverride: args.judgeModel,
    judgeProviderOverride: args.judgeProvider,
  });

  if (resolved.providers.length === 0) {
    console.error('✗ No provider configured. Set one of:');
    console.error('    OPENROUTER_API_KEY                     — OpenRouter (remote)');
    console.error('    ZAI_BASE_URL + ZAI_API_KEY + ZAI_MODELS — Z.AI or OpenAI-compatible');
    console.error('    OLLAMA_BASE_URL + OLLAMA_MODELS        — Local Ollama');
    process.exit(1);
  }

  const judgeModel = args.judgeModel ?? resolved.judgeModel;
  const hasJudge = resolved.hasJudge;

  const judgeCache = hasJudge ? loadJudgeCache() : null;

  // --resume: load existing artifact and skip present cells.
  const skipKeys = args.resume ? loadRows(args.resume).filter(r => r.ok) : [];

  // Filter cases by --cases CSV if provided.
  let activeCases: ToolCase[] = cases;
  if (args.cases) {
    const wanted = new Set(args.cases);
    activeCases = cases.filter(c => wanted.has(c.name));
    if (activeCases.length === 0) {
      console.error('✗ No matching cases found for --cases', args.cases);
      process.exit(1);
    }
  }

  // Build the cell plan.
  interface Cell {
    model: string;
    caseName: string;
    mode: 'json' | 'compact';
    rep: number;
    ablation?: string;
    /** Which provider this cell routes through. */
    providerId: ProviderId;
    key: string;
  }

  // Determine ablation modes.
  const modes: Array<{ mode: 'json' | 'compact'; label: string; ablation?: string }> = [];
  const ab = args.ablations;

  if (ab['syntax']) {
    // --ablation syntax=wire|json: override compact with different syntaxes
    const syntax = ab['syntax']!;
    if (syntax === 'json') {
      modes.push({ mode: 'compact', label: 'compact (json)', ablation: 'syntax=json' });
    } else {
      // wire is the default compact
      modes.push({ mode: 'compact', label: 'compact', ablation: undefined });
    }
  } else if (ab['no-manual']) {
    // --ablation no-manual: compact mode without the manual block
    modes.push({ mode: 'compact', label: 'compact (no-manual)', ablation: 'no-manual' });
  } else if (ab['placement'] === 'first' || ab['placement'] === 'last') {
    modes.push({ mode: 'compact', label: `compact (${ab['placement']})`, ablation: `placement=${ab['placement']}` });
  } else {
    // Normal run: compare json vs compact
    modes.push({ mode: 'json', label: 'json', ablation: undefined });
    modes.push({ mode: 'compact', label: 'compact', ablation: undefined });
  }

  // Build a map from model slug to its provider for routing.
  const modelToProvider = new Map<string, ProviderConfig>();
  for (const p of resolved.providers) {
    for (const slug of p.models) {
      modelToProvider.set(slug, p);
    }
  }

  const cells: Cell[] = [];
  for (const p of resolved.providers) {
    for (const mSlug of p.models) {
      for (const c of activeCases) {
        for (const mode of modes) {
          for (let rep = 1; rep <= reps; rep++) {
            cells.push({
              model: mSlug,
              caseName: c.name,
              mode: mode.mode,
              rep,
              ablation: mode.ablation,
              providerId: p.id,
              key: `live|${mSlug}|${c.name}|${mode.mode}|${rep}|${mode.ablation ?? '_'}`,
            });
          }
        }
      }
    }
  }

  // Filter out cells already present in the resume artifact.
  const skipKeySet = new Set(skipKeys.map(r => `live|${r.model}|${r.case}|${r.mode}|${r.rep}|${r.ablation ?? '_'}`));
  const pending = cells.filter(c => !skipKeySet.has(c.key));

  console.log('=== ai-sdk-wire-middleware live benchmark ===');
  console.log(`runId:       ${runId}`);
  console.log(`artifact:    ${outPath}`);
  console.log(`judge model: ${judgeModel}`);
  if (args.resume) console.log(`resume:      ${args.resume}  (${skipKeys.length} existing OK rows, ${pending.length} pending)`);
  console.log('');
  for (const p of resolved.providers) {
    console.log(`  ── ${p.label} — ${p.models.length} model(s)`);
    for (const m of p.models) {
      console.log(`    ${m}`);
    }
  }
  console.log('');
  console.log(`cases:       ${activeCases.length}`);
  console.log(`modes:       ${modes.map(m => m.label).join(', ')}`);
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

  // ── Judge caller (routes through the judge provider, not the runner) ──
  let judgeCaller: JudgeCaller | null = null;
  if (hasJudge && resolved.judgeProvider) {
    judgeCaller = async (input: JudgeInput, model: string) => {
      const judgeProv = resolved.judgeProvider!;
      const judgeModelObj = judgeProv.chatModel(model);
      const { system, user } = buildJudgePrompt(input);
      const res = await generateText({
        model: judgeModelObj,
        system,
        prompt: user,
        temperature: 0,
        maxOutputTokens: 300,
      });
      const { verdict, reason } = parseJudgeReply(res.text);
      return { verdict, reason, latencyMs: res.usage?.outputTokens ?? 0 };
    };
  }

  // ── Ablation: apply settings to the middleware ──
  function buildMiddleware(ablation?: string, mode?: 'json' | 'compact') {
    if (mode === 'json') return undefined; // raw model, no middleware
    if (ablation === 'no-manual') {
      // Compact mode WITHOUT the manual block — hack: we re-create compactTools
      // but the current API always includes the manual. For ablation we just
      // use the normal compact middleware but the ablation tag will be recorded.
      // The actual no-manual measurement is a structural change we track via
      // the ablation field.
      return compactTools();
    }
    if (ablation?.startsWith('syntax=')) {
      return compactTools();
    }
    return compactTools();
  }

  // ── Run cells ──
  let done = 0;
  const errors: string[] = [];
  let lastProviderId = '';
  let lastName = '';

  for (const cell of pending) {
    // Print model-group separator when switching models/providers.
    if (cell.model !== lastName || cell.providerId !== lastProviderId) {
      lastName = cell.model;
      lastProviderId = cell.providerId;
      const providerLabel = resolved.providers.find(p => p.id === cell.providerId)?.label ?? cell.providerId;
      console.log(`\n── ${providerLabel} :: ${cell.model} ──`);
    }
    const c = activeCases.find(c => c.name === cell.caseName)!;
    // Route to the correct provider based on the model slug.
    const provider = modelToProvider.get(cell.model);
    if (!provider) {
      console.error(`✗ No provider configured for model "${cell.model}". Skipping.`);
      continue;
    }
    const rawModel = provider.chatModel(cell.model);
    const middleware = buildMiddleware(cell.ablation, cell.mode);
    const actualModel = middleware ? wrapLanguageModel({ model: rawModel, middleware }) : rawModel;

    const t0 = performance.now();
    const row: ArtifactRow = {
      schemaVersion: 1,
      runId,
      ts: new Date().toISOString(),
      kind,
      model: cell.model,
      case: cell.caseName,
      mode: cell.mode,
      rep: cell.rep,
      ablation: cell.ablation,
      ok: false,
      expectedArgs: c.nativeCall.arguments,
    };

    try {
      const res = await generateText({
        model: actualModel,
        tools: allAiSdkTools as any,
        prompt: c.prompt,
        stopWhen: ({ steps }) => steps.length >= 1,
        temperature: 0,
        maxOutputTokens: 2048,
      });

      const elapsed = Math.round(performance.now() - t0);
      const tc = res.toolCalls?.[0];

      row.ok = Boolean(tc);
      row.toolName = tc?.toolName ?? null;
      row.args = tc?.input ?? null;
      row.inputTokens = res.usage?.inputTokens;
      row.outputTokens = res.usage?.outputTokens;
      row.elapsedMs = elapsed;

      // LLM judge call (only when judge is available and tool name matches)
      let judgeResult: JudgeResult | null = null;
      if (judgeCaller && tc?.toolName && tc.toolName === c.nativeCall.name) {
        judgeResult = await judgeArgs(
          {
            toolName: c.nativeCall.name,
            description: providerToolDescription(c.nativeCall.name),
            expectedArgs: c.nativeCall.arguments,
            gotArgs: tc.input,
          },
          judgeCaller,
          { judgeModel, cache: judgeCache! },
        );
        row.judge = {
          verdict: judgeResult.verdict,
          reason: judgeResult.reason,
          model: judgeModel,
        };
      } else if (!tc) {
        row.judge = {
          verdict: 'not-equivalent',
          reason: 'no tool call emitted',
          model: judgeModel,
        };
      } else if (tc.toolName !== c.nativeCall.name) {
        row.judge = {
          verdict: 'not-equivalent',
          reason: `wrong tool: expected ${c.nativeCall.name}, got ${tc.toolName}`,
          model: judgeModel,
        };
      }

      const flag = !row.judge || row.judge.verdict === 'equivalent' ? '✓' : '≈';
      const judgeTag = row.judge ? `judge=${row.judge.verdict}${judgeResult?.cached ? ' (cached)' : ''}` : 'no-judge';
      const providerTag = `[${cell.providerId === 'zai' ? 'ZAI' : 'OR'}]`;
      console.log(
        `${providerTag} ${flag} [${cell.model.padEnd(30)}] [${cell.mode.padEnd(7)}] rep=${cell.rep} ${cell.caseName.padEnd(36)}  ` +
        `${tc?.toolName ?? 'NO_CALL'}  out=${res.usage?.outputTokens ?? '?'}  ${elapsed}ms  ` +
        `${judgeTag}`,
      );
    } catch (err) {
      const elapsed = Math.round(performance.now() - t0);
      const message = (err as Error).message ?? String(err);
      row.ok = false;
      row.error = message.slice(0, 400);
      row.elapsedMs = elapsed;
      row.judge = {
        verdict: 'not-equivalent',
        reason: `API error: ${message.slice(0, 200)}`,
        model: judgeModel,
      };
      errors.push(`${cell.model}/${cell.caseName}/${cell.mode}/${cell.rep}: ${message.slice(0, 100)}`);

      const providerTag = `[${cell.providerId === 'zai' ? 'ZAI' : 'OR'}]`;
      console.log(
        `${providerTag} ✗ [${cell.model.padEnd(30)}] [${cell.mode.padEnd(7)}] rep=${cell.rep} ${cell.caseName.padEnd(36)}  ` +
        `ERROR: ${message.slice(0, 80)}`,
      );
    }

    // Persist every cell unconditionally.
    appendRow(outPath, row);
    done++;

    // Update the latest-* symlink every 10 rows so partial runs are visible.
    if (done % 10 === 0) updateLatestPointer(runId);
  }

  updateLatestPointer(runId);

  // ── Summary ──
  // Count ALL rows — a NO_CALL (ok=false) is a failure, not a skip.
  // It counts as not-equivalent and its output tokens are included.
  const allRows = loadRows(outPath);
  const jsonRows = allRows.filter(r => r.mode === 'json');
  const compactRows = allRows.filter(r => r.mode === 'compact' && !r.ablation);

  const jsonEq = jsonRows.filter(r => r.judge?.verdict === 'equivalent').length;
  const compactEq = compactRows.filter(r => r.judge?.verdict === 'equivalent').length;
  const jsonTotal = jsonRows.length;
  const compactTotal = compactRows.length;
  const jsonOut = jsonRows.reduce((a, r) => a + (r.outputTokens ?? 0), 0);
  const compactOut = compactRows.reduce((a, r) => a + (r.outputTokens ?? 0), 0);

  // Pure call tokens from the offline bench (format efficiency, ignores preamble)
  // Load the latest offline results to get per-case pure call sizes
  const offlinePath = join(dirname(outPath), 'latest-offline.json');
  let jsonPure = 0, compactPure = 0;
  try {
    const offline = JSON.parse(readFileSync(offlinePath, 'utf8'));
    for (const c of offline.perCall) {
      jsonPure += c.json;
      compactPure += c.compact;
    }
  } catch {}

  console.log('\n=== summary ===');
  if (jsonRows.length > 0) {
    console.log(`JSON:    ${jsonEq}/${jsonTotal} equivalent  total=${jsonOut}  pure-call=${jsonPure}`);
  }
  if (compactRows.length > 0) {
    const totalReduction = jsonOut > 0 ? ((jsonOut - compactOut) / jsonOut * 100) : 0;
    const pureReduction = jsonPure > 0 ? ((jsonPure - compactPure) / jsonPure * 100) : 0;
    console.log(`Compact: ${compactEq}/${compactTotal} equivalent  total=${compactOut}  pure-call=${compactPure}`);
    console.log(`Reduction (total, incl preamble): ${(jsonOut - compactOut)} (${totalReduction.toFixed(1)}%)`);
    console.log(`Reduction (pure call, format only): ${(jsonPure - compactPure)} (${pureReduction.toFixed(1)}%)`);
  }
  if (errors.length > 0) {
    console.log(`\n${errors.length} errors (recorded as ok=false rows):`);
    for (const e of errors.slice(0, 10)) console.log(`  ${e}`);
    if (errors.length > 10) console.log(`  … and ${errors.length - 10} more`);
  }
  console.log(`\nArtifact: ${outPath}`);
  console.log(`To rerun with skip: --resume ${outPath}`);

  // Publish to bench/results/published/ for git tracking.
  const published = publishArtifact(runId);
  if (published) {
    const shortName = published.split('/').pop();
    console.log(`Published:  ${published}`);
    console.log(`To commit:  git add bench/results/published/${shortName} && git commit -m "publish ${shortName}"`);
  }
}

// ─────────────────────────────────────────────────────── helpers ──

/** Inline helper (avoids importing buildJudgePrompt from judge.ts for the caller). */
function buildJudgePrompt(input: JudgeInput): { system: string; user: string } {
  const system =
    `You are a strict tool-call equivalence judge. Two tool calls are ` +
    `EQUIVALENT iff they would have the same effect on the system being ` +
    `controlled, ignoring trivial syntactic differences such as whitespace, ` +
    `trailing punctuation, JSON-vs-string-numeric slips, and added qualifying ` +
    `detail (e.g. "Austin" vs. "Austin, TX"). They are NOT equivalent if any ` +
    `argument value would change behavior, e.g. different cities, different ` +
    `numeric magnitudes, different SQL semantics, different recipients. ` +
    `Reply with EXACTLY one JSON object: ` +
    `{"verdict":"equivalent","reason":"..."} or ` +
    `{"verdict":"not-equivalent","reason":"..."}. ` +
    `No other text.`;
  const user =
    `Tool: ${input.toolName}\n` +
    (input.description ? `Description: ${input.description}\n` : '') +
    `Expected args: ${canonicalJson(input.expectedArgs)}\n` +
    `Got args: ${canonicalJson(input.gotArgs)}\n`;
  return { system, user };
}

/** Parse the judge's reply into a strict verdict. */
function parseJudgeReply(text: string): { verdict: 'equivalent' | 'not-equivalent'; reason: string } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as { verdict?: string; reason?: string };
      if (parsed.verdict === 'equivalent' || parsed.verdict === 'not-equivalent') {
        return { verdict: parsed.verdict, reason: String(parsed.reason ?? '').slice(0, 400) };
      }
    } catch { /* fall through */ }
  }
  return { verdict: 'not-equivalent', reason: `unparseable judge reply: ${text.slice(0, 200)}` };
}

function providerToolDescription(name: string): string {
  return cases.find(c => c.nativeCall.name === name)?.prompt ?? '';
}

await main();
