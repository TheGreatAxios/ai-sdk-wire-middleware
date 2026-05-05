/**
 * ai-sdk-wire-middleware — offline benchmark
 * --------------------------------------------------------------
 * Measures (a) token cost of the compact format vs. baselines (JSON,
 * Anthropic-style XML, Python-style DSL) and (b) round-trip correctness on a
 * small task suite using a deterministic mock model.
 *
 * Uses a real BPE tokenizer (js-tiktoken / o200k_base) — see
 * `bench/lib/tokenizer.ts` for the methodological note. Writes a JSON artifact
 * under `bench/results/offline-<ts>.json` that the aggregator and REPORT.md can
 * cite without re-running.
 *
 *   bun run bench
 */
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider';
import { writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { compactTools } from '../src/index.ts';
import { buildSystemPrompt } from '../src/system-prompt.ts';
import { planTools } from '../src/signature.ts';
import { cases, providerTools, type ToolCase } from './tools.ts';
import { countTokens, TOKENIZER_NAME } from './lib/tokenizer.ts';
import { xmlEncodeCall, xmlEncodeManual } from './encoders/xml-anthropic.ts';
import { pyEncodeCall, pyEncodeManual } from './encoders/python-dsl.ts';
import { newRunId } from './lib/artifact.ts';

function nativeJsonCallText(c: ToolCase): string {
  return JSON.stringify({
    type: 'tool_use',
    id: 'toolu_01ABCDEFG',
    name: c.nativeCall.name,
    input: c.nativeCall.arguments,
  });
}

function nativeJsonToolDef(t: (typeof providerTools)[number]): string {
  return JSON.stringify({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  });
}

interface PerCallRow {
  case: string;
  json: number;
  compact: number;
  xml: number;
  pythonDsl: number;
  reductionVsJson: number;
}

interface OfflineArtifact {
  schemaVersion: 1;
  runId: string;
  ts: string;
  tokenizer: string;
  tools: number;
  cases: number;
  manual: { json: number; compact: number; xml: number; pythonDsl: number };
  perCall: PerCallRow[];
  totals: { json: number; compact: number; xml: number; pythonDsl: number };
  reductions: {
    compactVsJson: number;
    xmlVsJson: number;
    pythonDslVsJson: number;
  };
  correctness: { passed: number; total: number };
}

function bench(runId: string): OfflineArtifact {
  const plans = planTools(providerTools, { syntax: 'wire', fallbackToJson: 'complex' });

  // ── 1. Manual / tool-definition cost ──
  const nativeDefBytes = providerTools.map(nativeJsonToolDef).join('\n');
  const compactSystem = buildSystemPrompt(plans, { syntax: 'wire', fallbackToJson: 'complex' });
  const xmlManual = xmlEncodeManual(plans);
  const pyManual = pyEncodeManual(plans);
  const manual = {
    json: countTokens(nativeDefBytes),
    compact: countTokens(compactSystem),
    xml: countTokens(xmlManual),
    pythonDsl: countTokens(pyManual),
  };

  // ── 2. Per-call output cost (every encoding) ──
  const perCall: PerCallRow[] = cases.map(c => {
    const j = countTokens(nativeJsonCallText(c));
    const k = countTokens(c.compactCall);
    const x = countTokens(xmlEncodeCall(c.nativeCall.name, c.nativeCall.arguments));
    const p = countTokens(pyEncodeCall(c.nativeCall.name, c.nativeCall.arguments));
    return {
      case: c.name,
      json: j,
      compact: k,
      xml: x,
      pythonDsl: p,
      reductionVsJson: round((j - k) / j),
    };
  });

  const totals = {
    json: perCall.reduce((a, r) => a + r.json, 0),
    compact: perCall.reduce((a, r) => a + r.compact, 0),
    xml: perCall.reduce((a, r) => a + r.xml, 0),
    pythonDsl: perCall.reduce((a, r) => a + r.pythonDsl, 0),
  };

  const reductions = {
    compactVsJson: round((totals.json - totals.compact) / totals.json),
    xmlVsJson: round((totals.json - totals.xml) / totals.json),
    pythonDslVsJson: round((totals.json - totals.pythonDsl) / totals.json),
  };

  console.log('=== ai-sdk-wire-middleware offline benchmark ===\n');
  console.log(`tokenizer: ${TOKENIZER_NAME}`);
  console.log(`tool catalogue: ${providerTools.length} tools, ${cases.length} test cases\n`);

  console.log('Manual / tool-definition tokens (cached after first call on Anthropic/OpenAI):');
  console.table([
    { encoding: 'json (native function defs)', tokens: manual.json },
    { encoding: 'compact (manual + sigs)', tokens: manual.compact },
    { encoding: 'xml-anthropic (manual + sigs)', tokens: manual.xml },
    { encoding: 'python-dsl (manual + sigs)', tokens: manual.pythonDsl },
  ]);

  console.log('\nPer-call output tokens (NOT cached — paid every call):');
  console.table(perCall);

  console.log(`\n${cases.length}-step cumulative output tokens:`);
  console.table([
    { encoding: 'json', tokens: totals.json },
    { encoding: 'compact', tokens: totals.compact, vsJson: pct(reductions.compactVsJson) },
    { encoding: 'xml-anthropic', tokens: totals.xml, vsJson: pct(reductions.xmlVsJson) },
    { encoding: 'python-dsl', tokens: totals.pythonDsl, vsJson: pct(reductions.pythonDslVsJson) },
  ]);

  return {
    schemaVersion: 1,
    runId,
    ts: new Date().toISOString(),
    tokenizer: TOKENIZER_NAME,
    tools: providerTools.length,
    cases: cases.length,
    manual,
    perCall,
    totals,
    reductions,
    correctness: { passed: 0, total: cases.length }, // filled in by correctness()
  };
}

function round(n: number, d = 4): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function pct(r: number): string {
  return `${(r * 100).toFixed(1)}%`;
}

// ─────────────────────────────────────────── round-trip correctness ──

function makeMockModel(scriptedText: string): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-1',
    supportedUrls: {},
    async doGenerate(): Promise<LanguageModelV3GenerateResult> {
      return {
        content: [{ type: 'text', text: scriptedText }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      };
    },
    async doStream(): Promise<LanguageModelV3StreamResult> {
      const parts: LanguageModelV3StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 's' },
        ...[...scriptedText].map(ch => ({
          type: 'text-delta' as const,
          id: 's',
          delta: ch,
        })),
        { type: 'text-end', id: 's' },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 0, text: 0, reasoning: 0 },
          },
        },
      ];
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const p of parts) controller.enqueue(p);
            controller.close();
          },
        }),
      };
    },
  };
}

async function correctness(): Promise<{ passed: number; total: number }> {
  console.log('\n=== round-trip correctness (mock model) ===\n');
  const mw = compactTools();
  let pass = 0;
  let fail = 0;
  for (const c of cases) {
    const model = makeMockModel(c.compactCall);
    const params: LanguageModelV3CallOptions = {
      prompt: [{ role: 'user', content: [{ type: 'text', text: c.prompt }] }],
      tools: providerTools,
    };
    const transformed = await mw.transformParams!({ type: 'generate', params, model });
    const result = await mw.wrapGenerate!({
      doGenerate: () => model.doGenerate(transformed),
      doStream: () => model.doStream(transformed),
      params: transformed,
      model,
    });
    const tc = result.content.find(p => p.type === 'tool-call') as
      | { toolName: string; input: string }
      | undefined;
    const ok =
      tc?.toolName === c.nativeCall.name &&
      deepEq(JSON.parse(tc!.input), c.nativeCall.arguments);
    console.log(`${ok ? '✓' : '✗'}  ${c.name}`);
    if (!ok) {
      console.log(`   expected: ${JSON.stringify(c.nativeCall.arguments)}`);
      console.log(`   got:      ${tc ? tc.input : '(no tool-call emitted)'}`);
      fail++;
    } else {
      pass++;
    }
  }
  console.log(`\n${pass}/${pass + fail} passed`);
  return { passed: pass, total: pass + fail };
}

function deepEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const runId = newRunId('offline');
const artifact = bench(runId);
artifact.correctness = await correctness();

const outDir = 'bench/results';
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `${runId}.json`);
writeFileSync(outPath, JSON.stringify(artifact, null, 2));
const latest = join(outDir, 'latest-offline.json');
writeFileSync(latest, JSON.stringify(artifact, null, 2));

// Publish for git tracking.
const publishedDir = join(outDir, 'published');
if (!existsSync(publishedDir)) mkdirSync(publishedDir, { recursive: true });
const publishedPath = join(publishedDir, `${runId}.json`);
copyFileSync(outPath, publishedPath);

console.log(`\nartifact: ${outPath}`);
console.log(`latest:   ${latest}`);
console.log(`\nPublished: ${publishedPath}`);
console.log(`To commit:  git add bench/results/published/${runId}.json && git commit -m "publish ${runId}"`);
