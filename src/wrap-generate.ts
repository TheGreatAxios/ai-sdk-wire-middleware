import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3GenerateResult,
  LanguageModelV3Text,
  LanguageModelV3ToolCall,
} from '@ai-sdk/provider';
import { findCallSpans, splitNameAndBody, encodeArgs, ToolReduceParseError } from './parser.ts';
import { unstashPlans } from './provider-options.ts';

let _idCounter = 0;
function genId(): string {
  return `tr_${Date.now().toString(36)}_${(_idCounter++).toString(36)}`;
}

export async function wrapGenerate(
  params: LanguageModelV3CallOptions,
  doGenerate: () => PromiseLike<LanguageModelV3GenerateResult>,
): Promise<LanguageModelV3GenerateResult> {
  const plans = unstashPlans(params.providerOptions);
  const result = await doGenerate();
  if (plans.length === 0) return result;

  const planByName = new Map(plans.map(p => [p.name, p]));
  const newContent: LanguageModelV3Content[] = [];
  let toolCallEmitted = false;

  for (const part of result.content) {
    if (part.type !== 'text') {
      newContent.push(part);
      continue;
    }
    const text = part.text;
    const spans = findCallSpans(text);
    if (spans.length === 0) {
      newContent.push(part);
      continue;
    }
    let cursor = 0;
    for (const span of spans) {
      // Emit any leading text before the call.
      if (span.start > cursor) {
        const leading = text.slice(cursor, span.start);
        if (leading.trim().length > 0) {
          newContent.push({ type: 'text', text: leading } as LanguageModelV3Text);
        }
      }
      const { toolName, argsBody } = splitNameAndBody(span.body);
      const plan = planByName.get(toolName);
      if (!plan) {
        // Pass through as text and let the orchestrator notice / model self-correct.
        newContent.push({
          type: 'text',
          text: text.slice(span.start, span.end),
        } as LanguageModelV3Text);
        cursor = span.end;
        continue;
      }
      try {
        const input = encodeArgs(argsBody, plan);
        newContent.push({
          type: 'tool-call',
          toolCallId: genId(),
          toolName,
          input,
        } as LanguageModelV3ToolCall);
        toolCallEmitted = true;
      } catch (err) {
        // Surface the error back to the model as text so it can correct itself.
        const message =
          err instanceof ToolReduceParseError ? err.message : (err as Error).message;
        newContent.push({
          type: 'text',
          text:
            text.slice(span.start, span.end) +
            `\n<tool-error name="${toolName}">${message}</tool-error>`,
        } as LanguageModelV3Text);
      }
      cursor = span.end;
    }
    // Trailing text after the last call.
    if (cursor < text.length) {
      const trailing = text.slice(cursor);
      if (trailing.trim().length > 0) {
        newContent.push({ type: 'text', text: trailing } as LanguageModelV3Text);
      }
    }
  }

  return {
    ...result,
    content: newContent,
    finishReason: toolCallEmitted
      ? { ...result.finishReason, unified: 'tool-calls' }
      : result.finishReason,
  };
}
