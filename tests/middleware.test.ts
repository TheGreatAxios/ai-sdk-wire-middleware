import { describe, expect, test } from 'bun:test';
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider';
import { compactTools } from '../src/index.ts';

/** Build a mock LanguageModelV3 that returns whatever content/stream you give it. */
function makeMockModel(opts: {
  generateContent?: LanguageModelV3GenerateResult['content'];
  streamParts?: LanguageModelV3StreamPart[];
  capture?: { lastParams?: LanguageModelV3CallOptions };
}): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-1',
    supportedUrls: {},
    async doGenerate(params) {
      if (opts.capture) opts.capture.lastParams = params;
      return {
        content: opts.generateContent ?? [{ type: 'text', text: '' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      } satisfies LanguageModelV3GenerateResult;
    },
    async doStream(params) {
      if (opts.capture) opts.capture.lastParams = params;
      const parts = opts.streamParts ?? [];
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          for (const p of parts) controller.enqueue(p);
          controller.close();
        },
      });
      return { stream } satisfies LanguageModelV3StreamResult;
    },
  };
}

const weatherTool = {
  type: 'function' as const,
  name: 'getWeather',
  description: 'Get the weather for a city',
  inputSchema: {
    type: 'object',
    properties: {
      location: { type: 'string' },
      units: { type: 'string', enum: ['metric', 'imperial'] },
    },
    required: ['location'],
  },
};

async function runMiddleware(
  mw: ReturnType<typeof compactTools>,
  model: LanguageModelV3,
  params: LanguageModelV3CallOptions,
): Promise<{ params: LanguageModelV3CallOptions; result: LanguageModelV3GenerateResult }> {
  const transformed = await mw.transformParams!({ type: 'generate', params, model });
  const result = await mw.wrapGenerate!({
    doGenerate: () => model.doGenerate(transformed),
    doStream: () => model.doStream(transformed),
    params: transformed,
    model,
  });
  return { params: transformed, result };
}

describe('compactTools middleware — transformParams', () => {
  test('strips tools and injects manual', async () => {
    const mw = compactTools();
    const model = makeMockModel({});
    const params: LanguageModelV3CallOptions = {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [weatherTool],
    };
    const transformed = await mw.transformParams!({ type: 'generate', params, model });
    expect(transformed.tools).toBeUndefined();
    expect(transformed.toolChoice).toBeUndefined();
    expect(transformed.prompt[0]!.role).toBe('user');
    // System message should be appended (placement: 'last').
    const last = transformed.prompt[transformed.prompt.length - 1]!;
    expect(last.role).toBe('system');
    expect((last as any).content).toContain('<call>');
    expect((last as any).content).toContain('getWeather');
  });

  test('placement first inserts system message at the front', async () => {
    const mw = compactTools({ placement: 'first' });
    const model = makeMockModel({});
    const transformed = await mw.transformParams!({
      type: 'generate',
      params: {
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        tools: [weatherTool],
      },
      model,
    });
    expect(transformed.prompt[0]!.role).toBe('system');
  });

  test('passes through when no tools', async () => {
    const mw = compactTools();
    const model = makeMockModel({});
    const params: LanguageModelV3CallOptions = {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    };
    const transformed = await mw.transformParams!({ type: 'generate', params, model });
    expect(transformed).toBe(params);
  });
});

describe('compactTools middleware — wrapGenerate', () => {
  test('parses a single compact call into tool-call content part', async () => {
    const model = makeMockModel({
      generateContent: [
        {
          type: 'text',
          text: 'Let me check.\n<call>getWeather location="Austin" units=metric</call>',
        },
      ],
    });
    const { result } = await runMiddleware(compactTools(), model, {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'weather?' }] }],
      tools: [weatherTool],
    });

    const toolCalls = result.content.filter(c => c.type === 'tool-call');
    expect(toolCalls).toHaveLength(1);
    const tc = toolCalls[0] as any;
    expect(tc.toolName).toBe('getWeather');
    expect(JSON.parse(tc.input)).toEqual({ location: 'Austin', units: 'metric' });
    expect(result.finishReason.unified).toBe('tool-calls');
  });

  test('preserves leading and trailing text around a call', async () => {
    const model = makeMockModel({
      generateContent: [
        { type: 'text', text: 'Sure.\n<call>getWeather location="Austin"</call>\nDone.' },
      ],
    });
    const { result } = await runMiddleware(compactTools(), model, {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'weather?' }] }],
      tools: [weatherTool],
    });
    const types = result.content.map(c => c.type);
    expect(types).toEqual(['text', 'tool-call', 'text']);
  });

  test('passes through text with no calls', async () => {
    const model = makeMockModel({
      generateContent: [{ type: 'text', text: 'just a normal answer' }],
    });
    const { result } = await runMiddleware(compactTools(), model, {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [weatherTool],
    });
    expect(result.content).toEqual([{ type: 'text', text: 'just a normal answer' }]);
    expect(result.finishReason.unified).toBe('stop');
  });

  test('emits tool-error text when arg is malformed', async () => {
    const model = makeMockModel({
      generateContent: [{ type: 'text', text: '<call>getWeather badtoken</call>' }],
    });
    const { result } = await runMiddleware(compactTools(), model, {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      tools: [weatherTool],
    });
    const text = result.content.map(c => (c as any).text ?? '').join('');
    expect(text).toContain('<tool-error');
  });
});

async function collectStream(
  stream: ReadableStream<LanguageModelV3StreamPart>,
): Promise<LanguageModelV3StreamPart[]> {
  const out: LanguageModelV3StreamPart[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

function deltaParts(text: string): LanguageModelV3StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'src' },
    ...[...text].map(ch => ({ type: 'text-delta' as const, id: 'src', delta: ch })),
    { type: 'text-end', id: 'src' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 0, text: 0, reasoning: 0 },
      },
    },
  ];
}

describe('compactTools middleware — wrapStream', () => {
  test('emits tool-input-start/delta/end and tool-call across char-level stream', async () => {
    const text = 'Let me check.\n<call>getWeather location="Austin" units=metric</call>\nOK';
    const model = makeMockModel({ streamParts: deltaParts(text) });
    const mw = compactTools();
    const params: LanguageModelV3CallOptions = {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'weather?' }] }],
      tools: [weatherTool],
    };
    const transformed = await mw.transformParams!({ type: 'stream', params, model });
    const streamRes = await mw.wrapStream!({
      doGenerate: () => model.doGenerate(transformed),
      doStream: () => model.doStream(transformed),
      params: transformed,
      model,
    });
    const parts = await collectStream(streamRes.stream);
    const types = parts.map(p => p.type);
    expect(types).toContain('tool-input-start');
    expect(types).toContain('tool-input-delta');
    expect(types).toContain('tool-input-end');
    expect(types).toContain('tool-call');
    const call = parts.find(p => p.type === 'tool-call') as any;
    expect(call.toolName).toBe('getWeather');
    expect(JSON.parse(call.input)).toEqual({ location: 'Austin', units: 'metric' });
    const finish = parts.find(p => p.type === 'finish') as any;
    expect(finish.finishReason.unified).toBe('tool-calls');
  });

  test('text without calls is forwarded as text-delta', async () => {
    const model = makeMockModel({ streamParts: deltaParts('just an answer') });
    const mw = compactTools();
    const params: LanguageModelV3CallOptions = {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [weatherTool],
    };
    const transformed = await mw.transformParams!({ type: 'stream', params, model });
    const streamRes = await mw.wrapStream!({
      doGenerate: () => model.doGenerate(transformed),
      doStream: () => model.doStream(transformed),
      params: transformed,
      model,
    });
    const parts = await collectStream(streamRes.stream);
    const text = parts
      .filter(p => p.type === 'text-delta')
      .map(p => (p as any).delta)
      .join('');
    expect(text).toBe('just an answer');
    const finish = parts.find(p => p.type === 'finish') as any;
    expect(finish.finishReason.unified).toBe('stop');
  });

  test('chunked open tag does not leak <ca into text', async () => {
    // Manually emit the open tag split across chunks.
    const parts: LanguageModelV3StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'src' },
      { type: 'text-delta', id: 'src', delta: 'hi <ca' },
      { type: 'text-delta', id: 'src', delta: 'll>getWeather location="A"</cal' },
      { type: 'text-delta', id: 'src', delta: 'l>' },
      { type: 'text-end', id: 'src' },
      {
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
      },
    ];
    const model = makeMockModel({ streamParts: parts });
    const mw = compactTools();
    const transformed = await mw.transformParams!({
      type: 'stream',
      params: {
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
        tools: [weatherTool],
      },
      model,
    });
    const streamRes = await mw.wrapStream!({
      doGenerate: () => model.doGenerate(transformed),
      doStream: () => model.doStream(transformed),
      params: transformed,
      model,
    });
    const got = await collectStream(streamRes.stream);
    const text = got
      .filter(p => p.type === 'text-delta')
      .map(p => (p as any).delta)
      .join('');
    expect(text).toBe('hi ');
    expect(text).not.toContain('<ca');
    const call = got.find(p => p.type === 'tool-call') as any;
    expect(call.toolName).toBe('getWeather');
    expect(JSON.parse(call.input)).toEqual({ location: 'A' });
  });
});

describe('history rewriting', () => {
  test('rewrites assistant tool-call into compact text', async () => {
    const mw = compactTools();
    const model = makeMockModel({});
    const params: LanguageModelV3CallOptions = {
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'weather please' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'on it.' },
            {
              type: 'tool-call',
              toolCallId: 'a',
              toolName: 'getWeather',
              input: JSON.stringify({ location: 'Austin', units: 'metric' }),
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'a',
              toolName: 'getWeather',
              output: { type: 'text', value: '72F sunny' },
            },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: 'thanks' }] },
      ],
      tools: [weatherTool],
    };
    const transformed = await mw.transformParams!({ type: 'generate', params, model });
    const assistantMsg = transformed.prompt.find(m => m.role === 'assistant')!;
    const txt = (assistantMsg.content[0] as any).text;
    expect(txt).toContain('on it.');
    expect(txt).toContain('<call>getWeather');
    expect(txt).toContain('Austin');
    // tool message should have become a user message
    const userMsgs = transformed.prompt.filter(m => m.role === 'user');
    const last = userMsgs[userMsgs.length - 1]!;
    expect((last.content as any)[0].text).toContain('72F sunny');
  });
});
