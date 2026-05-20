// Approximate token counting using @anthropic-ai/tokenizer.
//
// CAVEATS:
//   - The shipped tokenizer tracks the Claude 2 era. Claude 4 tokenization
//     is close but not identical. Expect ±5% error vs. Anthropic's actual
//     server-side count.
//   - We use this only to *estimate* the cost of content we have locally
//     (attachment payloads, settings.json snippets). For anything that has
//     already passed through the API, prefer message.usage from the session
//     jsonl — that is ground truth.
//   - Whenever we use estimates in UI, label them as such.

import { countTokens } from "@anthropic-ai/tokenizer";

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return countTokens(text);
}

/**
 * Per-tool overhead heuristic for an MCP-style tool definition. The full
 * schema (description + JSON-schema args) isn't visible in any single jsonl
 * line — it's injected by the runtime — so we estimate.
 *
 * Calibrated against Issue #29971 reports of "160 skills ≈ 25K tokens" and
 * deferred-tool counts observed in real sessions. Tools tend to be heavier
 * than skill descriptions because of the JSON-schema payload.
 */
export const TOOL_DEFINITION_TOKEN_ESTIMATE = 250;

export const STRUCTURAL_ATTACHMENT_TOKEN_ESTIMATE = 50;
