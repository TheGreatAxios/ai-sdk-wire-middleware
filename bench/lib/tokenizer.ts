/**
 * Real BPE tokenizer for offline cost estimation.
 *
 * We pin a single canonical encoding — `o200k_base` (GPT-4o / GPT-5 family) —
 * for cross-model fairness. This is NOT the tokenizer Anthropic / Gemini /
 * Qwen / DeepSeek use; per-model billed token counts are reported separately
 * via the live benchmark's `usage.outputTokens`. The role of this module is to
 * give us a stable common ruler when comparing two encodings of the same
 * content.
 *
 * Methodology note (also surfaced in REPORT.md):
 *   o200k_base ≈ tokenizer used by OpenAI's `gpt-4o` and `gpt-5` lines.
 *   For Anthropic and others, observed cl100k / proprietary tokenization is
 *   typically within ±10% of o200k for English-heavy tool-call text.
 */
import { getEncoding, type Tiktoken, type TiktokenEncoding } from 'js-tiktoken';

export const DEFAULT_ENCODING: TiktokenEncoding = 'o200k_base';
export const TOKENIZER_NAME = `js-tiktoken/${DEFAULT_ENCODING}`;

const cache = new Map<TiktokenEncoding, Tiktoken>();

function getEnc(encoding: TiktokenEncoding): Tiktoken {
  let enc = cache.get(encoding);
  if (!enc) {
    enc = getEncoding(encoding);
    cache.set(encoding, enc);
  }
  return enc;
}

/** Count tokens with the canonical encoding. */
export function countTokens(text: string, encoding: TiktokenEncoding = DEFAULT_ENCODING): number {
  if (!text) return 0;
  return getEnc(encoding).encode(text, 'all', []).length;
}

/** Count tokens across many strings (sum). */
export function countTokensMany(texts: string[], encoding: TiktokenEncoding = DEFAULT_ENCODING): number {
  let n = 0;
  const enc = getEnc(encoding);
  for (const t of texts) {
    if (t) n += enc.encode(t, 'all', []).length;
  }
  return n;
}
