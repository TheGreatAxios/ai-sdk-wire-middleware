import { describe, expect, test } from 'bun:test';
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider';
import { compactTools } from '../src/index.ts';

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
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            for (const p of parts) controller.enqueue(p);
            controller.close();
          },
        }),
      } satisfies LanguageModelV3StreamResult;
    },
  };
}

const weatherTool = {
  type: 'function' as const,
  name: 'getWeather',
  description: 'Get weather',
  inputSchema: {
    type: 'object',
    properties: {
      location: { type: 'string' },
      units: { type: 'string', enum: ['metric', 'imperial'] },
    },
    required: ['location'],
  },
};

const sendEmailTool = {
  type: 'function' as const,
  name: 'sendEmail',
  description: 'Send email',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string' },
      subject: { type: 'string' },
      body: { type: 'string' },
    },
    required: ['to', 'subject', 'body'],
  },
};

async function runGenerate(
  mw: ReturnType<typeof compactTools>,
  model: LanguageModelV3,
  params: LanguageModelV3CallOptions,
) {
  const transformed = await mw.transformParams!({ type: 'generate', params, model });
  const result = await mw.wrapGenerate!({
    doGenerate: () => model.doGenerate(transformed),
    doStream: () => model.doStream(transformed),
    params: transformed,
    model,
  });
  return { transformed, result };
}

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

async function runStream(
  mw: ReturnType<typeof compactTools>,
  model: LanguageModelV3,
  params: LanguageModelV3CallOptions,
): Promise<LanguageModelV3StreamPart[]> {
  const transformed = await mw.transformParams!({ type: 'stream', params, model });
  const streamRes = await mw.wrapStream!({
    doGenerate: () => model.doGenerate(transformed),
    doStream: () => model.doStream(transformed),
    params: transformed,
    model,
  });
  return collectStream(streamRes.stream);
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

describe('transformParams — toolChoice handling', () => {
  test('toolChoice "none" with no tools is a true passthrough', async () => {
    const mw = compactTools();
    const model = makeMockModel({});
    const params: LanguageModelV3CallOptions = {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      toolChoice: { type: 'none' },
    };
    const transformed = await mw.transformParams!({ type: 'generate', params, model });
    expect(transformed).toBe(params);
  });

  test('toolChoice "required" + tools still strips and injects', async () => {
    const mw = compactTools();
    const model = makeMockModel({});
    const transformed = await mw.transformParams!({
      type: 'generate',
      params: {
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
        tools: [weatherTool],
        toolChoice: { type: 'required' },
      },
      model,
    });
    expect(transformed.tools).toBeUndefined();
    expect(transformed.toolChoice).toBeUndefined();
  });

  test('toolChoice {type:"tool", toolName} + tools still strips and injects', async () => {
    const mw = compactTools();
    const model = makeMockModel({});
    const transformed = await mw.transformParams!({
      type: 'generate',
      params: {
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
        tools: [weatherTool],
        toolChoice: { type: 'tool', toolName: 'getWeather' },
      },
      model,
    });
    expect(transformed.tools).toBeUndefined();
    expect(transformed.toolChoice).toBeUndefined();
  });
});

describe('transformParams — system prompt merging', () => {
  test('existing system message is preserved and the manual is appended (placement: last)', async () => {
    const mw = compactTools();
    const model = makeMockModel({});
    const transformed = await mw.transformParams!({
      type: 'generate',
      params: {
        prompt: [
          { role: 'system', content: 'You are concise.' },
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        ],
        tools: [weatherTool],
      },
      model,
    });
    // No new system message inserted — merged into existing one.
    const systemMsgs = transformed.prompt.filter(m => m.role === 'system');
    expect(systemMsgs).toHaveLength(1);
    const sys = systemMsgs[0]!;
    expect((sys as any).content).toContain('You are concise.');
    expect((sys as any).content).toContain('<call>');
    // Original "You are concise." appears before the appended manual.
    const content = (sys as any).content as string;
    expect(content.indexOf('You are concise.')).toBeLessThan(content.indexOf('<call>'));
  });

  test('existing system message is preserved and the manual is prepended (placement: first)', async () => {
    const mw = compactTools({ placement: 'first' });
    const model = makeMockModel({});
    const transformed = await mw.transformParams!({
      type: 'generate',
      params: {
        prompt: [
          { role: 'system', content: 'You are concise.' },
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        ],
        tools: [weatherTool],
      },
      model,
    });
    const sys = transformed.prompt.find(m => m.role === 'system')!;
    const content = (sys as any).content as string;
    expect(content.indexOf('<call>')).toBeLessThan(content.indexOf('You are concise.'));
  });

  test('manualHeader override replaces the default header', async () => {
    const mw = compactTools({ manualHeader: '## CUSTOM HEADER ##' });
    const model = makeMockModel({});
    const transformed = await mw.transformParams!({
      type: 'generate',
      params: {
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        tools: [weatherTool],
      },
      model,
    });
    const last = transformed.prompt[transformed.prompt.length - 1]!;
    const content = (last as any).content as string;
    expect(content).toContain('## CUSTOM HEADER ##');
    expect(content).not.toContain('Tool calling protocol');
  });
});

describe('wrapGenerate — additional cases', () => {
  test('multiple back-to-back tool calls in one response', async () => {
    const model = makeMockModel({
      generateContent: [
        {
          type: 'text',
          text: 'doing two things\n<call>getWeather location="A"</call>\n<call>getWeather location="B"</call>',
        },
      ],
    });
    const { result } = await runGenerate(compactTools(), model, {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      tools: [weatherTool],
    });
    const toolCalls = result.content.filter(c => c.type === 'tool-call');
    expect(toolCalls).toHaveLength(2);
    expect(JSON.parse((toolCalls[0] as any).input)).toEqual({ location: 'A' });
    expect(JSON.parse((toolCalls[1] as any).input)).toEqual({ location: 'B' });
    expect(result.finishReason.unified).toBe('tool-calls');
  });

  test('reasoning parts flow through unchanged', async () => {
    const model = makeMockModel({
      generateContent: [
        { type: 'reasoning', text: 'thinking…' } as any,
        { type: 'text', text: '<call>getWeather location="X"</call>' },
      ],
    });
    const { result } = await runGenerate(compactTools(), model, {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      tools: [weatherTool],
    });
    const types = result.content.map(c => c.type);
    expect(types).toContain('reasoning');
    expect(types).toContain('tool-call');
  });

  test('unknown tool inside <call> is preserved as text (not a tool-call)', async () => {
    const model = makeMockModel({
      generateContent: [{ type: 'text', text: '<call>nope x=1</call>' }],
    });
    const { result } = await runGenerate(compactTools(), model, {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      tools: [weatherTool],
    });
    expect(result.content.filter(c => c.type === 'tool-call')).toHaveLength(0);
    const text = result.content.map(c => (c as any).text ?? '').join('');
    expect(text).toContain('<call>nope');
  });

  test('whitespace-only leading/trailing slices are NOT emitted as text parts', async () => {
    const model = makeMockModel({
      generateContent: [
        { type: 'text', text: '   \n<call>getWeather location="A"</call>\n   ' },
      ],
    });
    const { result } = await runGenerate(compactTools(), model, {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      tools: [weatherTool],
    });
    expect(result.content.map(c => c.type)).toEqual(['tool-call']);
  });

  test('finishReason is preserved when no tool-call is emitted', async () => {
    const model = makeMockModel({
      generateContent: [{ type: 'text', text: 'no calls here' }],
    });
    const { result } = await runGenerate(compactTools(), model, {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [weatherTool],
    });
    expect(result.finishReason.unified).toBe('stop');
  });
});

describe('wrapStream — additional cases', () => {
  test('split </call> across chunks still produces a single tool-call', async () => {
    const parts: LanguageModelV3StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'src' },
      { type: 'text-delta', id: 'src', delta: '<call>getWeather location="X"</' },
      { type: 'text-delta', id: 'src', delta: 'cal' },
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
    const got = await runStream(compactTools(), model, {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      tools: [weatherTool],
    });
    const calls = got.filter(p => p.type === 'tool-call');
    expect(calls).toHaveLength(1);
    expect(JSON.parse((calls[0] as any).input)).toEqual({ location: 'X' });
  });

  test('two back-to-back streamed calls produce two tool-call parts', async () => {
    const text = '<call>getWeather location="A"</call><call>getWeather location="B"</call>';
    const model = makeMockModel({ streamParts: deltaParts(text) });
    const got = await runStream(compactTools(), model, {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      tools: [weatherTool],
    });
    const calls = got.filter(p => p.type === 'tool-call');
    expect(calls).toHaveLength(2);
    expect(JSON.parse((calls[0] as any).input)).toEqual({ location: 'A' });
    expect(JSON.parse((calls[1] as any).input)).toEqual({ location: 'B' });
  });

  test('streamed tool-input-delta parts concatenate to the full body', async () => {
    const text = '<call>sendEmail to="a@b" subject="Hi" body="hello there"</call>';
    const model = makeMockModel({ streamParts: deltaParts(text) });
    const got = await runStream(compactTools(), model, {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      tools: [sendEmailTool],
    });
    const start = got.find(p => p.type === 'tool-input-start') as any;
    expect(start.toolName).toBe('sendEmail');
    const deltas = got
      .filter(p => p.type === 'tool-input-delta')
      .map(p => (p as any).delta)
      .join('');
    // The accumulated deltas should contain every key=value piece (plus surrounding whitespace).
    expect(deltas).toContain('to="a@b"');
    expect(deltas).toContain('subject="Hi"');
    expect(deltas).toContain('body="hello there"');
    const call = got.find(p => p.type === 'tool-call') as any;
    expect(JSON.parse(call.input)).toEqual({
      to: 'a@b',
      subject: 'Hi',
      body: 'hello there',
    });
  });

  test('upstream text-start/text-end framing is suppressed; we manage our own', async () => {
    const text = 'just talking';
    const model = makeMockModel({ streamParts: deltaParts(text) });
    const got = await runStream(compactTools(), model, {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [weatherTool],
    });
    const startIds = got.filter(p => p.type === 'text-start').map(p => (p as any).id);
    const endIds = got.filter(p => p.type === 'text-end').map(p => (p as any).id);
    // We re-frame under our own ids (prefixed with 'txt_').
    for (const id of startIds) expect(id).toMatch(/^txt_/);
    for (const id of endIds) expect(id).toMatch(/^txt_/);
    expect(startIds).toHaveLength(endIds.length);
  });

  test('flush handler closes any open text block on stream end without a finish', async () => {
    // No 'finish' part at all — only stream-start + text deltas, then upstream closes.
    const parts: LanguageModelV3StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'src' },
      { type: 'text-delta', id: 'src', delta: 'hello' },
      { type: 'text-end', id: 'src' },
    ];
    const model = makeMockModel({ streamParts: parts });
    const got = await runStream(compactTools(), model, {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [weatherTool],
    });
    const startIds = got.filter(p => p.type === 'text-start').map(p => (p as any).id);
    const endIds = got.filter(p => p.type === 'text-end').map(p => (p as any).id);
    expect(startIds.length).toBe(endIds.length);
  });
});

describe('history rewriting — additional cases', () => {
  test('tool-result with type:"json" output is serialized into <tool-result>', async () => {
    const mw = compactTools();
    const model = makeMockModel({});
    const transformed = await mw.transformParams!({
      type: 'generate',
      params: {
        prompt: [
          { role: 'user', content: [{ type: 'text', text: 'go' }] },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: 'a',
                toolName: 'getWeather',
                input: JSON.stringify({ location: 'X' }),
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
                output: { type: 'json', value: { temp: 72, sky: 'sunny' } },
              } as any,
            ],
          } as any,
        ],
        tools: [weatherTool],
      },
      model,
    });
    const lastUser = [...transformed.prompt].reverse().find(m => m.role === 'user')!;
    const text = (lastUser.content as any)[0].text as string;
    expect(text).toContain('<tool-result name="getWeather">');
    expect(text).toContain('"temp":72');
  });

  test('tool-result with type:"error-text" is serialized as <tool-error>', async () => {
    const mw = compactTools();
    const model = makeMockModel({});
    const transformed = await mw.transformParams!({
      type: 'generate',
      params: {
        prompt: [
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'a',
                toolName: 'getWeather',
                output: { type: 'error-text', value: 'no network' },
              } as any,
            ],
          } as any,
        ],
        tools: [weatherTool],
      },
      model,
    });
    const userMsg = transformed.prompt.find(m => m.role === 'user')!;
    const text = (userMsg.content as any)[0].text as string;
    expect(text).toContain('<tool-error name="getWeather">');
    expect(text).toContain('no network');
  });

  test('consecutive user messages after rewriting are merged', async () => {
    const mw = compactTools();
    const model = makeMockModel({});
    const transformed = await mw.transformParams!({
      type: 'generate',
      params: {
        prompt: [
          { role: 'user', content: [{ type: 'text', text: 'a' }] },
          { role: 'user', content: [{ type: 'text', text: 'b' }] },
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: 't',
                toolName: 'getWeather',
                output: { type: 'text', value: 'sunny' },
              } as any,
            ],
          } as any,
        ],
        tools: [weatherTool],
      },
      model,
    });
    const userMsgs = transformed.prompt.filter(m => m.role === 'user');
    // a + b should have merged before rewriting, and the rewritten tool-result becomes
    // a third user msg that may or may not merge depending on order; either way: <=2 user msgs.
    expect(userMsgs.length).toBeLessThanOrEqual(2);
  });
});
