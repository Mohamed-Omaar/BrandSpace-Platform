import { describe, expect, it } from 'vitest';
import {
  MAX_BODY_CHARS,
  MAX_TITLE_CHARS,
  chatMessageSchema,
  createKnowledgeItemSchema,
  itemKeySchema,
  localizedTextSchema,
  reviewCandidateSchema,
} from '@brandspace/brand-brain';

/**
 * The validation boundary. CLAUDE.md §5: parse, do not validate ad hoc.
 *
 * Brand Brain text reaches an AI context window, a Json column and a unique
 * index, so the cost of admitting a bad shape is paid three times.
 */

const uuid = '11111111-1111-4111-8111-111111111111';

describe('localized text', () => {
  it('accepts one locale', () => {
    expect(localizedTextSchema(100).safeParse({ en: 'Hello' }).success).toBe(true);
    expect(localizedTextSchema(100).safeParse({ ar: 'مرحبا' }).success).toBe(true);
  });

  it('REFUSES a body with neither locale', () => {
    // An empty item would otherwise count toward completion.
    expect(localizedTextSchema(100).safeParse({}).success).toBe(false);
    expect(localizedTextSchema(100).safeParse({ en: '', ar: '' }).success).toBe(false);
  });

  it('refuses whitespace masquerading as content', () => {
    expect(localizedTextSchema(100).safeParse({ en: '   ' }).success).toBe(false);
  });

  it('trims what it accepts', () => {
    const parsed = localizedTextSchema(100).parse({ en: '  Hello  ' });
    expect(parsed.en).toBe('Hello');
  });

  it('enforces the length ceiling', () => {
    expect(localizedTextSchema(10).safeParse({ en: 'x'.repeat(11) }).success).toBe(false);
    expect(localizedTextSchema(10).safeParse({ en: 'x'.repeat(10) }).success).toBe(true);
  });

  it('refuses a nested object that would render as [object Object]', () => {
    expect(localizedTextSchema(100).safeParse({ en: { nested: 'trouble' } }).success).toBe(false);
  });
});

describe('item keys', () => {
  it.each(['identity', 'identity.positioning', 'audience.segment_1', 'do-dont.rule1'])(
    'accepts %s',
    (key) => {
      expect(itemKeySchema.safeParse(key).success).toBe(true);
    },
  );

  it.each([
    ['a space', 'identity positioning'],
    ['uppercase', 'Identity'],
    ['a trailing dot', 'identity.'],
    ['a leading dot', '.identity'],
    ['a double dot', 'identity..positioning'],
    ['empty', ''],
    ['a slash that would break a URL', 'identity/positioning'],
  ])('refuses %s', (_label, key) => {
    expect(itemKeySchema.safeParse(key).success).toBe(false);
  });
});

describe('creating a knowledge item', () => {
  it('accepts a well-formed item', () => {
    const result = createKnowledgeItemSchema.safeParse({
      brandId: uuid,
      area: 'IDENTITY',
      itemKey: 'identity.positioning',
      title: { en: 'Positioning' },
      body: { en: 'We serve independent retailers.' },
    });
    expect(result.success).toBe(true);
  });

  it('refuses an unknown area', () => {
    const result = createKnowledgeItemSchema.safeParse({
      brandId: uuid,
      area: 'ASTROLOGY',
      itemKey: 'identity.positioning',
      title: { en: 'x' },
      body: { en: 'y' },
    });
    expect(result.success).toBe(false);
  });

  it('refuses a non-uuid brand id', () => {
    const result = createKnowledgeItemSchema.safeParse({
      brandId: 'not-a-uuid',
      area: 'IDENTITY',
      itemKey: 'identity.positioning',
      title: { en: 'x' },
      body: { en: 'y' },
    });
    expect(result.success).toBe(false);
  });

  it('bounds the body at the documented ceiling', () => {
    const tooLong = createKnowledgeItemSchema.safeParse({
      brandId: uuid,
      area: 'IDENTITY',
      itemKey: 'identity.positioning',
      title: { en: 'x'.repeat(MAX_TITLE_CHARS) },
      body: { en: 'y'.repeat(MAX_BODY_CHARS + 1) },
    });
    expect(tooLong.success).toBe(false);
  });
});

describe('reviewing a candidate', () => {
  it('accepts a plain acceptance', () => {
    expect(reviewCandidateSchema.safeParse({ candidateId: uuid, decision: 'accept' }).success).toBe(
      true,
    );
  });

  it('accepts an edited acceptance carrying the edit', () => {
    expect(
      reviewCandidateSchema.safeParse({
        candidateId: uuid,
        decision: 'accept_edited',
        title: { en: 'Edited' },
        body: { en: 'Edited body' },
      }).success,
    ).toBe(true);
  });

  it('refuses an edited acceptance with no edit', () => {
    expect(
      reviewCandidateSchema.safeParse({ candidateId: uuid, decision: 'accept_edited' }).success,
    ).toBe(false);
  });

  it('REFUSES an edit smuggled alongside a plain accept', () => {
    /*
     * Ignoring it would be worse than refusing: the review record would say
     * "accepted as extracted" about text the reviewer had changed, and the
     * candidate's preserved original would no longer describe what happened.
     */
    expect(
      reviewCandidateSchema.safeParse({
        candidateId: uuid,
        decision: 'accept',
        title: { en: 'Sneaky' },
        body: { en: 'Sneaky' },
      }).success,
    ).toBe(false);
  });

  it('refuses an unknown decision', () => {
    expect(reviewCandidateSchema.safeParse({ candidateId: uuid, decision: 'maybe' }).success).toBe(
      false,
    );
  });
});

describe('chat messages', () => {
  it('requires an idempotency key so a retry cannot bill twice', () => {
    expect(chatMessageSchema.safeParse({ brandId: uuid, message: 'hello' }).success).toBe(false);
  });

  it('refuses an idempotency key with characters a unique index should never see', () => {
    expect(
      chatMessageSchema.safeParse({
        brandId: uuid,
        message: 'hello',
        idempotencyKey: 'key with spaces',
      }).success,
    ).toBe(false);
  });

  it('refuses an empty message', () => {
    expect(
      chatMessageSchema.safeParse({
        brandId: uuid,
        message: '   ',
        idempotencyKey: 'abcdefgh',
      }).success,
    ).toBe(false);
  });

  it('accepts a well-formed send', () => {
    expect(
      chatMessageSchema.safeParse({
        brandId: uuid,
        message: 'What is our tone of voice?',
        idempotencyKey: 'chat-0001-abcd',
      }).success,
    ).toBe(true);
  });
});
