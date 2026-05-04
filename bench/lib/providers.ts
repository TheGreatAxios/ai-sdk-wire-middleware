/**
 * Multi-provider resolution for benchmark runners.
 *
 * Design principle: connection config is separate from model selection.
 *
 * ── Provider connection config (one per provider type in .env) ──
 *   ZAI_BASE_URL, ZAI_API_KEY
 *   OPENROUTER_API_KEY
 *   OLLAMA_BASE_URL (default http://localhost:11434), OLLAMA_API_KEY (optional)
 *
 * ── Bench model selection ──
 *   BENCH_PROVIDERS=zai,ollama             (CSV, which providers to use for running)
 *   BENCH_MODELS=zai:glm-5,glm-5-turbo|ollama:llama3.2,qwen2.5
 *     (pipe-separated per provider, colon-separated provider:models, comma-separated models)
 *   Old env vars ZAI_MODELS, OLLAMA_MODELS, OPENROUTER_MODELS still work as fallback.
 *   CLI flag --provider-models overrides everything.
 *
 * ── Judge model selection ──
 *   JUDGE_PROVIDER=zai                      (which provider routes judge calls)
 *   JUDGE_MODEL=glm-5-turbo                (model slug for judging)
 *   CLI flags --judge-model and --judge-provider override env.
 */
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModelV3 } from '@ai-sdk/provider';

// ─────────────────────────────────────────────────── Provider types ──

export type ProviderId = 'openrouter' | 'zai' | 'ollama';

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
  /** All providers with at least one model (the ones used for running). */
  providers: ProviderConfig[];
  /** All model slugs across all bench providers. */
  allModelSlugs: string[];
  /** True if a judge provider is available. */
  hasJudge: boolean;
  /** The model slug to use for judging. */
  judgeModel: string;
  /** The provider config that owns the judge model. */
  judgeProvider: ProviderConfig | undefined;
}

// ─────────────────────────────────────────────────── Resolution ──

/**
 * Parse BENCH_MODELS env var format:
 *   zai:glm-5,glm-5-turbo|ollama:llama3.2,qwen2.5
 *
 * Also handles bare model lists (no provider prefix) when there are no pipes:
 *   llama3.2,qwen2.5              — models only, provider inferred later
 *
 * Model names can contain colons (e.g. gemma3:270m). To distinguish from the
 * provider:models separator, we check if the part before the first colon in
 * each pipe-segment matches a known provider id. If not, treat the whole
 * segment as model names (no provider prefix).
 *
 * Returns a map of (optional) provider id → model slug array.
 */
const KNOWN_PROVIDER_IDS = new Set(['zai', 'openrouter', 'ollama']);

function parseBenchModels(env: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  const segments = env.split('|').map(s => s.trim()).filter(Boolean);
  for (const seg of segments) {
    // Check if the first colon-separated part is a known provider id.
    const firstColon = seg.indexOf(':');
    if (firstColon === -1) {
      // No colon at all — bare model list (no provider prefix).
      // We'll assign to a default provider later.
      const models = seg.split(',').map(s => s.trim()).filter(Boolean);
      if (models.length > 0) result['__bare__'] = models;
      continue;
    }
    const candidate = seg.slice(0, firstColon).trim().toLowerCase();
    if (KNOWN_PROVIDER_IDS.has(candidate)) {
      // Explicit provider:models syntax
      const models = seg.slice(firstColon + 1).split(',').map(s => s.trim()).filter(Boolean);
      if (models.length > 0) result[candidate] = models;
    } else {
      // First part doesn't match a known provider — treat whole segment as model names.
      // Models with colons (e.g. gemma3:270m) are comma-separated.
      const models = seg.split(',').map(s => s.trim()).filter(Boolean);
      if (models.length > 0) result['__bare__'] = [...(result['__bare__'] ?? []), ...models];
    }
  }
  // Deduplicate bare models
  if (result['__bare__']) {
    result['__bare__'] = [...new Set(result['__bare__'])];
  }
  return result;
}

/**
 * Resolve providers and their models from CLI args, env vars, and .env.
 *
 * Priority for bench models (highest to lowest):
 * 1. --provider-models CLI flags (repeatable)
 * 2. BENCH_MODELS env var (pipe-separated format)
 * 3. Legacy per-provider env vars: ZAI_MODELS, OPENROUTER_MODELS, OLLAMA_MODELS
 * 4. Legacy ZAI_MODEL env var (single model)
 *
 * Priority for judge:
 * 1. --judge-model + --judge-provider CLI flags
 * 2. JUDGE_MODEL + JUDGE_PROVIDER env vars
 * 3. Auto-detect: first model from first available provider
 */
export function resolveProviders(options: {
  /** Parsed --provider-models flags: e.g. { openrouter: [...], zai: [...] } */
  providerModels?: Record<string, string[]>;
  /** Default models to use when nothing is configured (fallback). */
  defaultModels?: string[];
  /** Judge model override from --judge-model. */
  judgeModelOverride?: string;
  /** Judge provider override from --judge-provider. */
  judgeProviderOverride?: string;
}): ResolvedProviders {
  const {
    providerModels: cliProviderModels = {},
    defaultModels = [],
    judgeModelOverride,
    judgeProviderOverride,
  } = options;

  // ── Determine which providers are configured (connection-wise) ──
  const zaiBaseUrl = process.env['ZAI_BASE_URL'];
  const zaiApiKey = process.env['ZAI_API_KEY'];
  const hasZaiConnection = Boolean(zaiBaseUrl && zaiApiKey);

  const openrouterApiKey = process.env['OPENROUTER_API_KEY'];
  const hasOrConnection = Boolean(openrouterApiKey);

  // Ollama is always available (local, no key needed), but only if explicitly used.
  const ollamaBaseUrl = (process.env['OLLAMA_BASE_URL'] || 'http://localhost:11434').replace(/\/$/, '');
  const ollamaApiKey = process.env['OLLAMA_API_KEY'] || '';

  // ── Resolve bench model selection (which providers/models to run) ──

  // 1. CLI --provider-models has highest priority
  const benchModelsByProvider: Record<string, string[]> = { ...cliProviderModels };

  // 2. BENCH_MODELS env var (new unified format)
  if (Object.keys(benchModelsByProvider).length === 0) {
    const benchModelsEnv = process.env['BENCH_MODELS'];
    if (benchModelsEnv) {
      const parsed = parseBenchModels(benchModelsEnv);
      for (const [p, models] of Object.entries(parsed)) {
        if (p === '__bare__') {
          // Bare models (no provider prefix). Assign to BENCH_PROVIDERS if set,
          // or the first connected provider with models.
          // This is handled later after we know which providers are active.
          if (!benchModelsByProvider['__bare__']) benchModelsByProvider['__bare__'] = [];
          benchModelsByProvider['__bare__'].push(...models);
        } else {
          if (!benchModelsByProvider[p]) benchModelsByProvider[p] = models;
        }
      }
    }
  }

  // 3. Legacy per-provider env vars
  if (Object.keys(benchModelsByProvider).length === 0) {
    // ZAI_MODELS or ZAI_MODEL
    const zaiEnv = process.env['ZAI_MODELS'];
    if (zaiEnv) {
      benchModelsByProvider['zai'] = zaiEnv.split(',').map(s => s.trim()).filter(Boolean);
    } else {
      const legacy = process.env['ZAI_MODEL'];
      if (legacy) benchModelsByProvider['zai'] = [legacy];
    }

    // OPENROUTER_MODELS
    const orEnv = process.env['OPENROUTER_MODELS'];
    if (orEnv) {
      benchModelsByProvider['openrouter'] = orEnv.split(',').map(s => s.trim()).filter(Boolean);
    }

    // OLLAMA_MODELS
    const ollamaEnv = process.env['OLLAMA_MODELS'];
    if (ollamaEnv) {
      benchModelsByProvider['ollama'] = ollamaEnv.split(',').map(s => s.trim()).filter(Boolean);
    }
  }

  // Resolve bare models (no provider prefix) to a real provider BEFORE filtering by
  // BENCH_PROVIDERS, so bare models get assigned to the right provider first.
  if (benchModelsByProvider['__bare__']?.length) {
    const bareModels = benchModelsByProvider['__bare__'];
    delete benchModelsByProvider['__bare__'];

    let targetProvider: string | undefined;
    const benchProvidersEnvForBare = process.env['BENCH_PROVIDERS'];
    if (benchProvidersEnvForBare) {
      const active = benchProvidersEnvForBare.split(',').map(s => s.trim()).filter(Boolean);
      if (active.length === 1) {
        // One provider specified — assign bare models to it.
        targetProvider = active[0];
      } else {
        // Multiple providers — assign to the first connected one.
        targetProvider = active.find(p =>
          p === 'zai' ? Boolean(process.env['ZAI_BASE_URL'] && process.env['ZAI_API_KEY']) :
          p === 'openrouter' ? Boolean(process.env['OPENROUTER_API_KEY']) :
          p === 'ollama'
        );
      }
    } else {
      // No BENCH_PROVIDERS — use first connected provider.
      targetProvider = hasZaiConnection ? 'zai' :
        hasOrConnection ? 'openrouter' : 'ollama';
    }

    if (targetProvider) {
      const existing = benchModelsByProvider[targetProvider] ?? [];
      benchModelsByProvider[targetProvider] = existing;
      benchModelsByProvider[targetProvider]!.push(...bareModels);
    }
  }

  // Filter by BENCH_PROVIDERS if set (limits which providers are active).
  // This runs AFTER bare model resolution so __bare__ is gone.
  const benchProvidersEnv = process.env['BENCH_PROVIDERS'];
  if (benchProvidersEnv) {
    const active = new Set(benchProvidersEnv.split(',').map(s => s.trim()).filter(Boolean));
    for (const p of Object.keys(benchModelsByProvider)) {
      if (!active.has(p)) delete benchModelsByProvider[p];
    }
  }

  // 4. Fallback to defaultModels if nothing else matched
  if (Object.keys(benchModelsByProvider).length === 0 && defaultModels.length > 0) {
    // If ZAI is configured as a connection, put defaults there; otherwise OpenRouter.
    if (hasZaiConnection) {
      benchModelsByProvider['zai'] = defaultModels;
    } else if (hasOrConnection) {
      benchModelsByProvider['openrouter'] = defaultModels;
    }
  }

  // ── Build provider configs (only for providers that have both connection and models) ──
  const providers: ProviderConfig[] = [];

  // Z.AI
  if (hasZaiConnection && benchModelsByProvider['zai']?.length) {
    const zaiClient = createOpenAI({
      baseURL: zaiBaseUrl!.replace(/\/$/, '') + '/',
      apiKey: zaiApiKey!,
    });
    providers.push({
      id: 'zai',
      models: benchModelsByProvider['zai'],
      chatModel: (slug) => zaiClient.chat(slug),
      label: `Z.AI (${zaiBaseUrl})`,
    });
  }

  // OpenRouter
  if (hasOrConnection && benchModelsByProvider['openrouter']?.length) {
    const orClient = createOpenRouter({ apiKey: openrouterApiKey! });
    providers.push({
      id: 'openrouter',
      models: benchModelsByProvider['openrouter'],
      chatModel: (slug) => orClient.chat(slug),
      label: 'OpenRouter',
    });
  }

  // Ollama (always creates client if models are specified)
  if (benchModelsByProvider['ollama']?.length) {
    const ollamaClient = createOpenAI({
      baseURL: ollamaBaseUrl + '/v1/',
      apiKey: ollamaApiKey,
      fetch: globalThis.fetch,
    });
    providers.push({
      id: 'ollama',
      models: benchModelsByProvider['ollama'],
      chatModel: (slug) => ollamaClient.chat(slug),
      label: `Ollama (${ollamaBaseUrl})`,
    });
  }

  // ── Validation ──
  if (providers.length === 0) {
    return {
      providers: [],
      allModelSlugs: [],
      hasJudge: false,
      judgeModel: '',
      judgeProvider: undefined,
    };
  }

  const allModelSlugs = providers.flatMap(p => p.models);

  // Warn on model overlap between providers.
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

  // ── Judge resolution ──

  // Priority: CLI flag > JUDGE_PROVIDER/JUDGE_MODEL env vars > auto-detect
  let judgeProvider: ProviderConfig | undefined;
  let judgeModel: string;
  const effectiveJudgeProvider = judgeProviderOverride ?? process.env['JUDGE_PROVIDER'] ?? '';
  const effectiveJudgeModel = judgeModelOverride ?? process.env['JUDGE_MODEL'] ?? '';

  if (effectiveJudgeModel) {
    // Judge model explicitly set. Find which provider owns it.
    judgeModel = effectiveJudgeModel;
    if (effectiveJudgeProvider) {
      judgeProvider = providers.find(p => p.id === effectiveJudgeProvider);
    }
    if (!judgeProvider) {
      judgeProvider = providers.find(p => p.models.includes(effectiveJudgeModel));
    }
    // If still not found and we have a ZAI connection, create an ad-hoc provider.
    if (!judgeProvider && hasZaiConnection) {
      const zaiClient = createOpenAI({
        baseURL: zaiBaseUrl!.replace(/\/$/, '') + '/',
        apiKey: zaiApiKey!,
      });
      judgeProvider = {
        id: 'zai',
        models: [effectiveJudgeModel],
        chatModel: (slug) => zaiClient.chat(slug),
        label: `Z.AI (${zaiBaseUrl}) — judge only`,
      };
    }
    // Or if OpenRouter is connected
    if (!judgeProvider && hasOrConnection) {
      const orClient = createOpenRouter({ apiKey: openrouterApiKey! });
      judgeProvider = {
        id: 'openrouter',
        models: [effectiveJudgeModel],
        chatModel: (slug) => orClient.chat(slug),
        label: 'OpenRouter — judge only',
      };
    }
  } else if (effectiveJudgeProvider) {
    // Judge provider set but not model — use that provider's first model.
    judgeProvider = providers.find(p => p.id === effectiveJudgeProvider);
    judgeModel = judgeProvider?.models[0] ?? '';
  } else {
    // Auto-detect: prefer OpenRouter, then ZAI, then Ollama.
    judgeProvider = providers.find(p => p.id === 'openrouter')
      ?? providers.find(p => p.id === 'zai')
      ?? providers.find(p => p.id === 'ollama');
    judgeModel = judgeProvider?.models[0] ?? '';
  }

  const hasJudge = Boolean(judgeProvider && judgeModel);

  return { providers, allModelSlugs, hasJudge, judgeModel, judgeProvider };
}

/**
 * Get the first available judge model from the resolved providers.
 */
export function getJudgeModel(providers: ProviderConfig[], override?: string): string {
  if (override) return override;
  return providers.find(p => p.id === 'openrouter')?.models[0]
    ?? providers.find(p => p.id === 'zai')?.models[0]
    ?? '';
}
