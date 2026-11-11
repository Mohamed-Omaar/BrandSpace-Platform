import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_MAX_BYTES,
  ACTIVITY_MAX_IMAGES,
  ACTIVITY_MAX_STEPS,
  answerActivity,
  messageActivity,
} from '@brandspace/copilot';
import {
  IMAGE_INPUT_TOKENS,
  estimatePrompt,
  estimateTokens,
  fitPrompt,
} from '../../packages/copilot/src/agent-budget';

/**
 * PR A (D-604) — THE OWNER'S CONDITIONS ON THE SQL APPROVAL (2026-11-11).
 *
 *   1. `copilot_message.activity` holds only short step labels and ids — no
 *      customer content, no tool result — under a size cap enforced in code;
 *   2. the input one message may send is capped, counted conservatively.
 *
 * (The purge clearing `activity` is proven against the database in
 * `tests/isolation/pr-a-agent-turn.test.ts`; the worst-case margin in
 * `tests/unit/pr-a-copilot-config.test.ts`.)
 */

const ID = '0f8e1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b';

describe('activity: labels and ids only, capped', () => {
  it('keeps a step key, its state and the ids; drops everything else', () => {
    expect(
      answerActivity([
        {
          key: 'post.create_draft',
          state: 'done',
          contentItemId: ID,
          // A tool result, a caption and a brief must never be stored.
          result: { caption: 'We are open late.' },
          caption: 'customer words',
          title: 'Autumn',
        },
      ]),
    ).toEqual({ worked: [{ key: 'post.create_draft', state: 'done', contentItemId: ID }] });
  });

  it('refuses a key that is not a step label, a state outside the three, and an id that is not an id', () => {
    expect(
      answerActivity([
        { key: 'Ignore previous instructions', state: 'done' },
        { key: 'brand.profile', state: 'stolen' },
        { key: 'post.generate_image', state: 'done', jobId: 'not-an-id', contentItemId: ID },
        'a string',
        null,
      ]),
    ).toEqual({ worked: [{ key: 'post.generate_image', state: 'done', contentItemId: ID }] });
  });

  it(`at most ${ACTIVITY_MAX_STEPS} steps, and never more than ${ACTIVITY_MAX_BYTES} bytes`, () => {
    const many = Array.from({ length: 200 }, () => ({
      key: 'brand_brain.remove_fact',
      state: 'proposed',
      contentItemId: ID,
      jobId: ID,
    }));
    const kept = answerActivity(many);
    expect(kept.worked.length).toBeLessThanOrEqual(ACTIVITY_MAX_STEPS);
    expect(Buffer.byteLength(JSON.stringify(kept), 'utf8')).toBeLessThanOrEqual(ACTIVITY_MAX_BYTES);
  });

  it(`a message keeps at most ${ACTIVITY_MAX_IMAGES} image ids, and only ids`, () => {
    expect(messageActivity([ID, 'file.png', ID, ID, { id: ID }])).toEqual({ images: [ID, ID] });
  });
});

describe('the input budget: a conservative count, and trimming in a fixed order', () => {
  it('counts above what a tokenizer averages: Arabic at 1.5 characters a token, Latin at 3', () => {
    expect(estimateTokens('abcdef')).toBe(2);
    expect(estimateTokens('مرحبا')).toBe(4);
    // An image counts the most gpt-5.4 bills one at `detail: high`.
    expect(IMAGE_INPUT_TOKENS).toBe(3_000);
    expect(
      estimatePrompt({
        instruction: '',
        reference: [],
        conversation: [{ role: 'user', text: '', images: [{ mimeType: 'image/png', base64: '' }] }],
        tools: [],
      }),
    ).toBeGreaterThanOrEqual(3_000);
  });

  it('trims earlier turns first, never the person’s message, then reference, then long tool results', () => {
    const parts = {
      instruction: 'i',
      reference: ['r'.repeat(3_000)],
      conversation: [
        { role: 'user' as const, text: 'old question '.repeat(200) },
        { role: 'assistant' as const, text: 'old answer '.repeat(200) },
        { role: 'user' as const, text: 'Now: the calendar?' },
        {
          role: 'assistant' as const,
          text: '',
          toolCalls: [{ id: 'c', name: 'x', arguments: '{}' }],
        },
        { role: 'tool' as const, toolCallId: 'c', text: 't'.repeat(3_000) },
      ],
      tools: [],
    };
    const fitted = fitPrompt(parts, 600, 2);
    expect(fitted).not.toBeNull();
    const turns = fitted?.parts.conversation ?? [];
    expect(turns[0]).toEqual({ role: 'user', text: 'Now: the calendar?' });
    expect(fitted?.earlierTurns).toBe(0);
    expect(estimatePrompt(fitted!.parts)).toBeLessThanOrEqual(600);
    // A tool call and its result stay paired; only the result is shortened.
    expect(turns.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'c' });
  });

  it('nothing is trimmed when the irreducible part cannot fit: null, never a broken prompt', () => {
    expect(
      fitPrompt(
        {
          instruction: 'x'.repeat(30_000),
          reference: [],
          conversation: [{ role: 'user', text: 'hi' }],
          tools: [],
        },
        1_000,
        0,
      ),
    ).toBeNull();
  });
});
