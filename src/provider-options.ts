import type { SharedV3ProviderOptions } from '@ai-sdk/provider';
import type { ToolPlan } from './types.ts';
import { STASH_KEY } from './types.ts';

/** Persist the tool plans across transformParams → wrap{Generate,Stream}. */
export function stashPlans(
  providerOptions: SharedV3ProviderOptions | undefined,
  plans: ToolPlan[],
): SharedV3ProviderOptions {
  const stash = {
    ...(providerOptions?.[STASH_KEY] ?? {}),
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

export function unstashPlans(
  providerOptions: SharedV3ProviderOptions | undefined,
): ToolPlan[] {
  const raw = (providerOptions?.[STASH_KEY] as { plans?: unknown } | undefined)?.plans as
    | Array<{
        name: string;
        description: string | null;
        signature: string;
        encoding: ToolPlan['encoding'];
        fields: ToolPlan['fields'];
        inputSchema: string;
      }>
    | undefined;
  if (!raw) return [];
  return raw.map(p => ({
    name: p.name,
    description: p.description ?? undefined,
    signature: p.signature,
    encoding: p.encoding,
    fields: p.fields,
    inputSchema: JSON.parse(p.inputSchema),
  }));
}
