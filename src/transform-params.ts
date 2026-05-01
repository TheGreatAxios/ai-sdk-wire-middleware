import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Message,
} from '@ai-sdk/provider';
import type { CompactToolsOptions, FunctionTool, ToolPlan } from './types.ts';
import { planTools } from './signature.ts';
import { buildSystemPrompt, injectSystemPrompt } from './system-prompt.ts';
import { serializeCall, serializeToolResult } from './serialize.ts';
import { stashPlans } from './provider-options.ts';

/** Implements the transformParams hook. */
export async function transformParams(
  params: LanguageModelV3CallOptions,
  options: Required<Pick<CompactToolsOptions, 'syntax' | 'fallbackToJson' | 'placement'>> &
    Pick<CompactToolsOptions, 'manualHeader' | 'debug'>,
): Promise<LanguageModelV3CallOptions> {
  const functionTools = (params.tools ?? []).filter(
    (t): t is FunctionTool => (t as { type?: string }).type === 'function',
  );

  // No tools? Nothing to do — return params untouched.
  if (functionTools.length === 0 && !hasStashedPlans(params)) {
    return params;
  }

  // toolChoice handling: 'none' is fine (skip injection); 'auto'/'required'/'tool' all behave
  // similarly here since we always inject the manual when tools are present. We do NOT use
  // responseFormat tricks — the contract is purely text-based.
  const choice = params.toolChoice;
  if (choice?.type === 'none' && functionTools.length === 0) {
    return params;
  }

  const plans: ToolPlan[] = planTools(functionTools, {
    syntax: options.syntax,
    fallbackToJson: options.fallbackToJson,
  });

  const manual = buildSystemPrompt(plans, {
    syntax: options.syntax,
    fallbackToJson: options.fallbackToJson,
    placement: options.placement,
    manualHeader: options.manualHeader,
  });

  if (options.debug) {
    process.stderr.write(`[tool-reduce] injecting manual for ${plans.length} tool(s)\n`);
  }

  const rewrittenPrompt = rewriteHistory(params.prompt, plans);
  const finalPrompt = injectSystemPrompt(rewrittenPrompt, manual, options.placement);

  return {
    ...params,
    prompt: finalPrompt,
    tools: undefined,
    toolChoice: undefined,
    providerOptions: stashPlans(params.providerOptions, plans),
  };
}

function hasStashedPlans(params: LanguageModelV3CallOptions): boolean {
  const stash = params.providerOptions?.['toolReduce'] as { plans?: unknown } | undefined;
  return Boolean(stash?.plans);
}

/**
 * Walk the conversation history and rewrite tool-call/tool-result parts so the model
 * sees a self-consistent compact-call transcript instead of native JSON.
 */
function rewriteHistory(
  prompt: LanguageModelV3Message[],
  plans: ToolPlan[],
): LanguageModelV3Message[] {
  const planByName = new Map(plans.map(p => [p.name, p]));
  const out: LanguageModelV3Message[] = [];
  for (const msg of prompt) {
    if (msg.role === 'assistant') {
      const collapsed = collapseAssistantContent(msg.content, planByName);
      out.push({ ...msg, content: collapsed });
      continue;
    }
    if (msg.role === 'tool') {
      // Convert each tool-result part into a user-role text message so the model can read it.
      for (const part of msg.content) {
        if (part.type === 'tool-result') {
          const { value, isError } = extractToolOutput(part.output);
          out.push({
            role: 'user',
            content: [
              {
                type: 'text',
                text: serializeToolResult(part.toolName, value, isError),
              },
            ],
          } as LanguageModelV3Message);
        }
      }
      continue;
    }
    out.push(msg);
  }
  return mergeConsecutiveUsers(out);
}

function collapseAssistantContent(
  content: Array<unknown>,
  planByName: Map<string, ToolPlan>,
): Array<{ type: 'text'; text: string }> {
  const buf: string[] = [];
  for (const part of content) {
    const p = part as { type: string; text?: string; toolName?: string; input?: string };
    if (p.type === 'text') {
      buf.push(p.text ?? '');
    } else if (p.type === 'tool-call') {
      buf.push(serializeCall(p.toolName!, p.input ?? '{}', planByName.get(p.toolName!)));
    }
    // reasoning, file, source, tool-approval-* are dropped from the rewritten history.
  }
  return [{ type: 'text', text: buf.join('\n').trim() || ' ' }];
}

function extractToolOutput(
  output: { type: string; value?: unknown; reason?: string },
): { value: unknown; isError: boolean } {
  switch (output.type) {
    case 'text':
    case 'json':
      return { value: output.value, isError: false };
    case 'execution-denied':
      return { value: output.reason ?? 'execution denied', isError: true };
    case 'error-text':
      return { value: output.value, isError: true };
    case 'error-json':
      return { value: output.value, isError: true };
    default:
      return { value: output.value ?? null, isError: false };
  }
}

function mergeConsecutiveUsers(prompt: LanguageModelV3Message[]): LanguageModelV3Message[] {
  const out: LanguageModelV3Message[] = [];
  for (const msg of prompt) {
    const last = out[out.length - 1];
    if (last && last.role === 'user' && msg.role === 'user') {
      const lastTexts = (last.content as Array<{ type: string; text?: string }>)
        .filter(p => p.type === 'text')
        .map(p => p.text ?? '');
      const newTexts = (msg.content as Array<{ type: string; text?: string }>)
        .filter(p => p.type === 'text')
        .map(p => p.text ?? '');
      out[out.length - 1] = {
        ...last,
        content: [{ type: 'text', text: [...lastTexts, ...newTexts].join('\n') }],
      } as LanguageModelV3Message;
      continue;
    }
    out.push(msg);
  }
  return out;
}
