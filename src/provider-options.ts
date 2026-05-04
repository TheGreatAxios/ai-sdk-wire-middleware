import type { SharedV3ProviderOptions } from '@ai-sdk/provider';
import type { ToolPlan } from './types.ts';
import { STASH_KEY } from './types.ts';

/** Persist the tool plans across transformParams → wrap{Generate,Stream}. */
export function stashPlans(
  providerOptions: SharedV3ProviderOptions | undefined,
  plans: ToolPlan[],
  stripPreamble?: boolean,
): SharedV3ProviderOptions {
  const existing = (providerOptions?.[STASH_KEY] ?? {}) as Record<string, unknown>;
  const stash = {
    ...existing,
    stripPreamble,
    plans: plans.map(p => ({
      name: p.name,
      description: p.description ?? null,
      signature: p.signature,
      encoding: p.encoding,
      fields: p.fields.map(f => ({ ...f })),
      inputSchema: JSON.stringify(p.inputSchema),
    })),
  };
  return {
    ...(providerOptions ?? {}),
    [STASH_KEY]: stash as unknown as Record<string, never>,
  } as SharedV3ProviderOptions;
}

interface StashShape {
  stripPreamble?: boolean;
  plans?: Array<{
    name: string;
    description: string | null;
    signature: string;
    encoding: ToolPlan['encoding'];
    fields: ToolPlan['fields'];
    inputSchema: string;
  }>;
}

export function unstashPlans(
  providerOptions: SharedV3ProviderOptions | undefined,
): { plans: ToolPlan[]; stripPreamble: boolean } {
  const stash = (providerOptions?.[STASH_KEY] ?? {}) as StashShape;
  const raw = stash.plans;
  if (!raw) return { plans: [], stripPreamble: false };
  return {
    stripPreamble: stash.stripPreamble ?? false,
    plans: raw.map(p => ({
      name: p.name,
      description: p.description ?? undefined,
      signature: p.signature,
      encoding: p.encoding,
      fields: p.fields,
      inputSchema: JSON.parse(p.inputSchema),
    })),
  };
}
