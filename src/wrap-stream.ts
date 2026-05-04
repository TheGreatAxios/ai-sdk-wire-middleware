import type {
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider';
import { CALL_CLOSE, CALL_OPEN, encodeArgs, splitNameAndBody, ToolReduceParseError } from './parser.ts';
import { unstashPlans } from './provider-options.ts';
import type { ToolPlan } from './types.ts';

let _idCounter = 0;
function genId(prefix = 'tr'): string {
  return `${prefix}_${Date.now().toString(36)}_${(_idCounter++).toString(36)}`;
}

type State =
  | { kind: 'OUTSIDE' }
  | { kind: 'IN_HEAD'; bodyAcc: string }
  | { kind: 'IN_BODY'; toolName: string; toolPlan: ToolPlan | undefined; argsAcc: string; toolInputId: string; nameEmitted: boolean };

export async function wrapStream(
  params: LanguageModelV3CallOptions,
  doStream: () => PromiseLike<LanguageModelV3StreamResult>,
): Promise<LanguageModelV3StreamResult> {
  const { plans } = unstashPlans(params.providerOptions);
  const result = await doStream();
  if (plans.length === 0) return result;

  const planByName = new Map(plans.map(p => [p.name, p]));
  const stream = result.stream.pipeThrough(makeParser(planByName));
  return { ...result, stream };
}

function makeParser(planByName: Map<string, ToolPlan>): TransformStream<
  LanguageModelV3StreamPart,
  LanguageModelV3StreamPart
> {
  let buffer = '';
  let state: State = { kind: 'OUTSIDE' };
  let textBlockId: string | null = null;
  let toolCallEmitted = false;

  function openTextBlock(controller: TransformStreamDefaultController<LanguageModelV3StreamPart>) {
    if (textBlockId == null) {
      textBlockId = genId('txt');
      controller.enqueue({ type: 'text-start', id: textBlockId });
    }
  }
  function closeTextBlock(
    controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
  ) {
    if (textBlockId != null) {
      controller.enqueue({ type: 'text-end', id: textBlockId });
      textBlockId = null;
    }
  }
  function emitText(
    controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
    text: string,
  ) {
    if (text.length === 0) return;
    openTextBlock(controller);
    controller.enqueue({ type: 'text-delta', id: textBlockId!, delta: text });
  }

  /** Length of the longest suffix of `s` that is a strict prefix of `needle`. */
  function pendingPrefix(s: string, needle: string): number {
    const max = Math.min(s.length, needle.length - 1);
    for (let n = max; n > 0; n--) {
      if (s.endsWith(needle.slice(0, n))) return n;
    }
    return 0;
  }

  function processBuffer(
    controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
    flushAll: boolean,
  ) {
    while (buffer.length > 0) {
      if (state.kind === 'OUTSIDE') {
        const idx = buffer.indexOf(CALL_OPEN);
        if (idx === -1) {
          // No full open tag in buffer. Hold back any partial open prefix at the end.
          const hold = flushAll ? 0 : pendingPrefix(buffer, CALL_OPEN);
          const cut = buffer.length - hold;
          if (cut > 0) {
            emitText(controller, buffer.slice(0, cut));
            buffer = buffer.slice(cut);
          }
          return;
        }
        // Emit text up to the call, switch state.
        if (idx > 0) emitText(controller, buffer.slice(0, idx));
        closeTextBlock(controller);
        buffer = buffer.slice(idx + CALL_OPEN.length);
        state = { kind: 'IN_HEAD', bodyAcc: '' };
        continue;
      }

      if (state.kind === 'IN_HEAD') {
        // We need to read the tool name (first whitespace-delimited token after optional leading whitespace).
        // Strip leading whitespace.
        let i = 0;
        while (i < buffer.length && /\s/.test(buffer[i]!)) i++;
        const wsConsumed = i;
        // Find boundary: whitespace or close tag start.
        let j = i;
        while (j < buffer.length && !/\s/.test(buffer[j]!) && buffer[j] !== '<') j++;
        const reachedBoundary =
          j < buffer.length && (/\s/.test(buffer[j]!) || buffer[j] === '<');
        if (!reachedBoundary && !flushAll) {
          // Not enough to know name yet.
          buffer = buffer.slice(wsConsumed);
          return;
        }
        const name = buffer.slice(i, j);
        if (name.length === 0) {
          // Edge case: just whitespace then close? Treat as parse error after flush.
          if (flushAll) {
            emitText(controller, CALL_OPEN + buffer);
            buffer = '';
            state = { kind: 'OUTSIDE' };
            return;
          }
          buffer = buffer.slice(wsConsumed);
          return;
        }
        const plan = planByName.get(name);
        const toolInputId = genId('ti');
        controller.enqueue({
          type: 'tool-input-start',
          id: toolInputId,
          toolName: name,
        });
        state = {
          kind: 'IN_BODY',
          toolName: name,
          toolPlan: plan,
          argsAcc: '',
          toolInputId,
          nameEmitted: true,
        };
        buffer = buffer.slice(j);
        continue;
      }

      if (state.kind === 'IN_BODY') {
        const idx = buffer.indexOf(CALL_CLOSE);
        if (idx === -1) {
          // Hold back potential partial close-tag suffix.
          const hold = flushAll ? 0 : pendingPrefix(buffer, CALL_CLOSE);
          const cut = buffer.length - hold;
          if (cut > 0) {
            const chunk = buffer.slice(0, cut);
            state.argsAcc += chunk;
            controller.enqueue({
              type: 'tool-input-delta',
              id: state.toolInputId,
              delta: chunk,
            });
            buffer = buffer.slice(cut);
          }
          if (flushAll && buffer.length === 0) {
            // Stream ended mid-call. Emit a tool-input-end and try a best-effort parse.
            controller.enqueue({ type: 'tool-input-end', id: state.toolInputId });
            tryEmitToolCall(controller, state, /*partial*/ true);
            state = { kind: 'OUTSIDE' };
          }
          return;
        }
        // Found close.
        const finalChunk = buffer.slice(0, idx);
        if (finalChunk.length > 0) {
          state.argsAcc += finalChunk;
          controller.enqueue({
            type: 'tool-input-delta',
            id: state.toolInputId,
            delta: finalChunk,
          });
        }
        controller.enqueue({ type: 'tool-input-end', id: state.toolInputId });
        tryEmitToolCall(controller, state, /*partial*/ false);
        toolCallEmitted = true;
        buffer = buffer.slice(idx + CALL_CLOSE.length);
        state = { kind: 'OUTSIDE' };
        continue;
      }
    }
  }

  function tryEmitToolCall(
    controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
    body: { toolName: string; toolPlan: ToolPlan | undefined; argsAcc: string },
    partial: boolean,
  ) {
    if (!body.toolPlan) {
      // Unknown tool — emit as text fallback.
      controller.enqueue({
        type: 'error',
        error: new ToolReduceParseError(`Unknown tool "${body.toolName}"`),
      });
      return;
    }
    try {
      const argsBody = body.argsAcc.trim();
      const input = encodeArgs(argsBody, body.toolPlan);
      controller.enqueue({
        type: 'tool-call',
        toolCallId: genId('tc'),
        toolName: body.toolName,
        input,
      });
    } catch (err) {
      controller.enqueue({
        type: 'error',
        error: err instanceof Error ? err : new Error(String(err)),
      });
      if (partial) {
        // Re-emit the partial buffer as plain text so the user still sees something.
        emitText(controller, `${CALL_OPEN}${body.toolName} ${body.argsAcc}`);
      }
    }
  }

  return new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
    transform(chunk, controller) {
      switch (chunk.type) {
        case 'text-start':
        case 'text-end':
          // Suppress upstream framing; we manage our own.
          return;
        case 'text-delta':
          buffer += chunk.delta;
          processBuffer(controller, /*flushAll*/ false);
          return;
        case 'finish': {
          // Flush any remaining text/tool buffer.
          processBuffer(controller, /*flushAll*/ true);
          closeTextBlock(controller);
          if (toolCallEmitted) {
            controller.enqueue({
              ...chunk,
              finishReason: { ...chunk.finishReason, unified: 'tool-calls' },
            });
          } else {
            controller.enqueue(chunk);
          }
          return;
        }
        default:
          controller.enqueue(chunk);
          return;
      }
    },
    flush(controller) {
      processBuffer(controller, /*flushAll*/ true);
      closeTextBlock(controller);
    },
  });
}
