import type { ChatTurn, ToolSpec } from '@brandspace/ai-gateway';

/**
 * PR A (smart Copilot, D-604) — THE MESSAGE'S INPUT BUDGET.
 *
 * Owner condition (2026-11-11): cap the worst case of ONE message so that its
 * margin at 4 credits is at least 50%. The loop may make `maxRounds` model
 * calls and each re-sends the conversation, so the cap is on the INPUT TOKENS
 * the whole message sends (`copilot.agent.maxInputTokensPerMessage`), counted
 * here CONSERVATIVELY — more than the provider will bill, never less:
 *
 *   - a non-Latin character (Arabic) at 1.5 characters a token, the rest at
 *     3 (both above what the provider's tokenizer averages);
 *   - an image at 3,000 tokens: the most gpt-5.4 bills one at `detail: high`
 *     (2,500 patches × 1.2), which the adapter always asks for;
 *   - a few tokens per message for the provider's own framing.
 *
 * The loop spends `max(estimate, billed)` per call, so a provider that counts
 * more than the estimate shrinks what is left rather than overrunning it.
 */

export const IMAGE_INPUT_TOKENS = 3_000;
const PER_MESSAGE_FRAMING = 4;
const SHORT_TOOL_RESULT = 800;

export function estimateTokens(text: string): number {
  let latin = 0;
  let other = 0;
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) < 128) latin += 1;
    else other += 1;
  }
  return Math.ceil(latin / 3 + other / 1.5);
}

export interface PromptParts {
  readonly instruction: string;
  readonly reference: readonly string[];
  readonly conversation: readonly ChatTurn[];
  readonly tools: readonly ToolSpec[];
}

export function estimatePrompt(parts: PromptParts): number {
  let tokens = estimateTokens(parts.instruction) + PER_MESSAGE_FRAMING;
  for (const block of parts.reference) tokens += estimateTokens(block) + PER_MESSAGE_FRAMING;
  for (const turn of parts.conversation) {
    tokens += estimateTokens(turn.text) + PER_MESSAGE_FRAMING;
    if (turn.role === 'user') tokens += (turn.images?.length ?? 0) * IMAGE_INPUT_TOKENS;
    if (turn.role === 'assistant') {
      for (const call of turn.toolCalls ?? []) {
        tokens += estimateTokens(call.name) + estimateTokens(call.arguments) + PER_MESSAGE_FRAMING;
      }
    }
  }
  if (parts.tools.length > 0) tokens += estimateTokens(JSON.stringify(parts.tools));
  return tokens;
}

/**
 * Trim a prompt until it fits `limit`, in this order: earlier conversation
 * turns (oldest first, never the person's current message or anything after
 * it), then the reference blocks (the longest is halved, then dropped), then
 * long tool results (cut to a short head). Null when even the irreducible
 * part — the instruction, the current message, its images, the tool calls
 * and short results — does not fit.
 */
export function fitPrompt(
  parts: PromptParts,
  limit: number,
  earlierTurns: number,
): { readonly parts: PromptParts; readonly earlierTurns: number } | null {
  let reference = [...parts.reference];
  let conversation = [...parts.conversation];
  let earlier = earlierTurns;
  const fits = () => estimatePrompt({ ...parts, reference, conversation }) <= limit;

  while (!fits() && earlier > 0) {
    conversation = conversation.slice(1);
    earlier -= 1;
  }
  while (!fits() && reference.length > 0) {
    const longest = reference.reduce(
      (best, block, index) => (block.length > (reference[best]?.length ?? 0) ? index : best),
      0,
    );
    const block = reference[longest] ?? '';
    reference =
      block.length > 400
        ? reference.map((entry, index) =>
            index === longest ? `${entry.slice(0, Math.floor(entry.length / 2))}…` : entry,
          )
        : reference.filter((_, index) => index !== longest);
  }
  if (!fits()) {
    conversation = conversation.map((turn) =>
      turn.role === 'tool' && turn.text.length > SHORT_TOOL_RESULT
        ? { ...turn, text: `${turn.text.slice(0, SHORT_TOOL_RESULT)}…` }
        : turn,
    );
  }
  return fits() ? { parts: { ...parts, reference, conversation }, earlierTurns: earlier } : null;
}
