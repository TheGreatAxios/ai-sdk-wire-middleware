/**
 * Multi-provider resolution for benchmark runners.
 *
 * Lets users run multiple models per provider in a single benchmark run:
 *
 *   # Run 3 OpenRouter models + 2 Z.AI models in one shot
 *   bun run bench/live.ts --provider-models openrouter=anthropic/claude-sonnet-4.5,openai/gpt-4.1 \
 *                            --provider-models zai=glm-4.5-air:free,deepseek/deepseek-v3.1 \
 *     --reps 1
 *
 *   # Or use env vars for default provider model lists:
 *   OPENROUTER_API_KEY=... OPENROUTER_MODELS=anthropic/claude-sonnet-4.5,openai/gpt-4.1 \
 *   ZAI_BASE_URL=... ZAI_API_KEY=... ZAI_MODELS=glm-4.5-air:free,deepseek/deepseek-v3.1 \
 *     bun run bench/live.ts --reps 1
 *
 * The old ZAI_MODEL env var is still supported as a single-model shorthand.
 */
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModelV3 } from '@ai-sdk/provider';

// ─────────────────────────────────────────────────── Provider types ──

export type ProviderId = 'openrouter' | 'zai';

export interface ProviderConfig {
  id: ProviderId;
  /** Model slugs for this provider. */
  models: string[];
  /**
   * Factory to create a chat model instance.
   * Receives a model slug and returns an AI SDK language model.
   */
  chatModel: (slug: string) => LanguageModelV3;
  /** Human-readable label. */
  label: string;
}

export interface ResolvedProviders {
  /** All providers with at least one model. */
  providers: ProviderConfig[];
  /** All model slugs across all providers (for backward compat). */
  allModelSlugs: string[];
  /** True if a judge-capable provider is available (OpenRouter or ZAI). */
  hasJudge: boolean;
  /** The model slug to use for judging (first provider's model). */
  judgeModel: string;
}

// ─────────────────────────────────────────────────── Resolution ──

/**
 * Resolve providers and their models from CLI args and env vars.
 *
 * Priority:
 * 1. `--provider-models <provider>=<csv>` CLI flags (repeatable)
 * 2. `OPENROUTER_MODELS` / `ZAI_MODELS` env vars (CSV, overrides ZAI_MODEL)
 * 3. Legacy `ZAI_MODEL` env var (single model)
 * 4. If nothing specified, the caller's default model list
 */
export function resolveProviders(options: {
  /** Parsed --provider-models flags: e.g. { openrouter: [...], zai: [...] } */
  providerModels?: Record<string, string[]>;
  /** Default models to use when nothing is configured (fallback). */
  defaultModels?: string[];
  /** Judge model override from --judge-model. */
  judgeModelOverride?: string;
}): ResolvedProviders {
  const { providerModels: cliProviderModels = {}, defaultModels = [], judgeModelOverride } = options;

  const providers: ProviderConfig[] = [];

  // ── Z.AI provider ──
  const zaiBaseUrl = process.env['ZAI_BASE_URL'];
  const zaiApiKey = process.env['ZAI_API_KEY'];
  const zaiClient = zaiBaseUrl && zaiApiKey
    ? createOpenAI({ baseURL: zaiBaseUrl.replace(/\/$/, '') + '/', apiKey: zaiApiKey })
    : null;

  if (zaiClient) {
    // Resolve ZAI models: CLI > env var > legacy ZAI_MODEL > none
    let zaiModels: string[];
    if (cliProviderModels['zai'] && cliProviderModels['zai'].length > 0) {
      zaiModels = cliProviderModels['zai'];
    } else {
      const envModels = process.env['ZAI_MODELS'];
      if (envModels) {
        zaiModels = envModels.split(',').map(s => s.trim()).filter(Boolean);
      } else {
        const legacy = process.env['ZAI_MODEL'];
        zaiModels = legacy ? [legacy] : [];
      }
    }

    if (zaiModels.length > 0) {
      providers.push({
        id: 'zai',
        models: zaiModels,
        chatModel: (slug) => zaiClient.chat(slug),
        label: `Z.AI (${zaiBaseUrl})`,
      });
    }
  }

  // ── OpenRouter provider ──
  const openrouterApiKey = process.env['OPENROUTER_API_KEY'];
  const openrouter = openrouterApiKey ? createOpenRouter({ apiKey: openrouterApiKey }) : null;

  if (openrouter) {
    let orModels: string[];
    if (cliProviderModels['openrouter'] && cliProviderModels['openrouter'].length > 0) {
      orModels = cliProviderModels['openrouter'];
    } else {
      const envModels = process.env['OPENROUTER_MODELS'];
      if (envModels) {
        orModels = envModels.split(',').map(s => s.trim()).filter(Boolean);
      } else {
        // If CLI --models was given and ZAI is also configured, only use those
        // models that aren't claimed by ZAI for OpenRouter.
        // Otherwise defaultModels includes everything.
        orModels = defaultModels;
      }
    }

    if (orModels.length > 0) {
      providers.push({
        id: 'openrouter',
        models: orModels,
        chatModel: (slug) => openrouter.chat(slug),
        label: 'OpenRouter',
      });
    }
  }

  // ── Validation ──
  if (providers.length === 0) {
    // No provider configured.
    return {
      providers: [],
      allModelSlugs: [],
      hasJudge: false,
      judgeModel: '',
    };
  }

  const allModelSlugs = providers.flatMap(p => p.models);

  // Warn on model overlap between providers (ambiguous routing).
  const seen = new Map<string, ProviderId[]>();
  for (const p of providers) {
    for (const slug of p.models) {
      const existing = seen.get(slug) ?? [];
      existing.push(p.id);
      seen.set(slug, existing);
    }
  }
  for (const [slug, pidList] of seen) {
    if (pidList.length > 1) {
      console.warn(`⚠ Model "${slug}" is configured in multiple providers (${pidList.join(', ')}). ` +
        `It will run once per provider. Use --provider-models for explicit scoping.`);
    }
  }

  // Determine judge capability: OpenRouter is preferred for judging.
  const hasJudge = providers.some(p => p.id === 'openrouter') ||
    providers.some(p => p.id === 'zai');

  // Default judge model: override > OpenRouter's first model > ZAI's first model
  const judgeModel = judgeModelOverride
    ?? providers.find(p => p.id === 'openrouter')?.models[0]
    ?? providers.find(p => p.id === 'zai')?.models[0]
    ?? '';

  return { providers, allModelSlugs, hasJudge, judgeModel };
}

/**
 * Check whether a given model slug belongs to the Z.AI provider.
 * Used for routing cells to the correct provider.
 */
export function modelBelongsToProvider(modelSlug: string, providers: ProviderConfig[]): ProviderConfig | null {
  return providers.find(p => p.models.includes(modelSlug)) ?? null;
}

/**
 * Get the first available judge model from the resolved providers.
 */
export function getJudgeModel(providers: ProviderConfig[], override?: string): string {
  if (override) return override;
  // Prefer OpenRouter for cheap judging, fall back to ZAI.
  return providers.find(p => p.id === 'openrouter')?.models[0]
    ?? providers.find(p => p.id === 'zai')?.models[0]
    ?? '';
}
