/**
 * Default model list for the multi-model sweep.
 *
 * Every model is an OpenRouter slug. The first five are the research-grade
 * lineup; the last is a cheap/free one for quick iteration.
 *
 * Models are tried in order. On 4xx / rate-limit the harness records
 * `{ ok: false, error }` and moves on — never halts the run.
 *
 * The list is overridable via `--models a,b,c` on the CLI.
 */
export const DEFAULT_MODELS: string[] = [
  'anthropic/claude-sonnet-4.5',
  'openai/gpt-4.1',          // best available GPT-4.x on OpenRouter as of 2026-05
  'google/gemini-2.5-pro',
  'qwen/qwen3-235b-a22b',
  'deepseek/deepseek-v3.1',
  'minimax/minimax-m2.5:free',
];

export interface ModelEntry {
  slug: string;
  label: string;
}

export function modelLabel(slug: string): string {
  // Strip the OpenRouter provider prefix for compact display labels.
  const parts = slug.split('/');
  if (parts.length === 2) {
    const [, model] = parts;
    return (
      model
        ?.replace(/:free$/, '')
        .replace(/-pro$/, ' Pro')
        .replace(/-sonnet/, ' Sonnet')
        .replace(/-v\d+(\.\d+)?/, '') ?? slug
    );
  }
  return slug;
}

export function resolveModels(cliModels?: string[]): ModelEntry[] {
  const slugs = (cliModels && cliModels.length > 0) ? cliModels : DEFAULT_MODELS;
  return slugs.map(slug => ({ slug, label: modelLabel(slug) }));
}
