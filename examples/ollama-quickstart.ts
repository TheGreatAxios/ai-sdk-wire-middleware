/**
 * Local Ollama quickstart using `ai-sdk-wire-middleware` with AI SDK v7.
 *
 * Prerequisites:
 *   ollama serve
 *   ollama pull qwen2.5:14b
 *
 * Run:
 *   bun run examples/ollama-quickstart.ts
 */
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, stepCountIs, tool, wrapLanguageModel } from 'ai';
import { z } from 'zod';
import { compactTools } from '../src/index.ts';

const ollama = createOpenAI({
  baseURL: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1',
  apiKey: process.env.OLLAMA_API_KEY ?? 'ollama',
});

const modelName = process.env.OLLAMA_MODEL ?? 'qwen2.5:14b';

const model = wrapLanguageModel({
  model: ollama.chat(modelName),
  middleware: compactTools({ debug: true }),
});

const result = await generateText({
  model,
  stopWhen: stepCountIs(4),
  tools: {
    getWeather: tool({
      description: 'Get the current weather for a city',
      inputSchema: z.object({
        location: z.string(),
        units: z.enum(['metric', 'imperial']).optional(),
      }),
      execute: async ({ location, units }) => ({
        location,
        temperature: units === 'metric' ? 22 : 72,
        units: units ?? 'imperial',
        condition: 'sunny',
      }),
    }),
    stageFields: tool({
      description: 'Stage extracted spreadsheet fields in a batch',
      inputSchema: z.object({
        file: z.string(),
        entries: z.array(
          z.object({
            row: z.number().int(),
            column: z.string(),
            field: z.string(),
          }),
        ),
      }),
      execute: async ({ file, entries }) => ({
        staged: entries.length,
        file,
      }),
    }),
  },
  prompt: 'Check the weather in Austin in metric units, then report it briefly.',
});

console.log(result.text);
