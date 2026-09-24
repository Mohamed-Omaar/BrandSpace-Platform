import { describe, expect, it } from 'vitest';
import {
  AI_OUTPUT_RETENTION_REGISTRY,
  RETENTION_EXCLUDED_TABLES,
  countCharacters,
  parseContentPolicy,
  parseGeneratedContent,
  resolveContentExpiry,
  resolveDialect,
  validateVariant,
  type ContentPolicy,
} from '@brandspace/content';
import { CONFIG_DOMAINS } from '@brandspace/config';

/**
 * Pure logic for the AI Content Studio — the parts that must be right before a
 * database or a provider is involved at all.
 *
 * The integration behaviour lives in `tests/isolation/content-studio-lifecycle`
 * against a real PostgreSQL and the real gateway. What is here is the arithmetic
 * and the decision logic: dialect resolution (D-115), retention windows (D-116,
 * D-117), output parsing (AC-11.9) and character counting.
 */

const POLICY: ContentPolicy = {
  dialects: {
    defaultKey: 'msa',
    supported: [
      { key: 'msa', labelKey: 'content.dialect.msa', bcp47: 'ar' },
      { key: 'gulf', labelKey: 'content.dialect.gulf', bcp47: 'ar-SA' },
      { key: 'egyptian', labelKey: 'content.dialect.egyptian', bcp47: 'ar-EG' },
      { key: 'levantine', labelKey: 'content.dialect.levantine', bcp47: 'ar-LB' },
    ],
  },
  platforms: [
    {
      key: 'instagram',
      labelKey: 'content.platform.instagram',
      maxBodyChars: 2_200,
      maxHashtags: 30,
      allowsFirstComment: true,
      maxMediaItems: 10,
    },
    {
      key: 'x',
      labelKey: 'content.platform.x',
      maxBodyChars: 280,
      maxHashtags: 5,
      allowsFirstComment: false,
      maxMediaItems: 10,
    },
  ],
  generation: {
    maxVariantsPerRequest: 4,
    maxDraftsPerBrand: 500,
    maxContextItems: 12,
    maxContextChunks: 8,
    maxContextChars: 12_000,
    maxBriefChars: 2_000,
  },
  retention: { cancellationGraceDays: 30, minCustomerRetentionDays: 7 },
  calendar: {
    weekStartsOn: 0,
    maxDaysAhead: 365,
    minLeadMinutes: 5,
    maxSlotsPerDay: 25,
    requireApprovalBeforeScheduling: false,
  },
  learning: {
    preferenceMinObservations: 4,
    preferenceMinPosts: 3,
    workflowMinRepeats: 4,
    windowDays: 90,
    snoozeDays: 30,
  },
  approvals: {
    requireApprovalBeforeScheduling: false,
    allowSelfApproval: false,
    clientApprovalEnabled: false,
    maxNoteLength: 1_000,
    maxCyclesPerItem: 25,
  },
};

const clockAt = (iso: string) => ({ now: () => new Date(iso) });

// ---------------------------------------------------------------------------

describe('D-115 — Arabic dialect resolution', () => {
  it('prefers the brand over the workspace', () => {
    expect(
      resolveDialect(POLICY, { brandDialect: 'levantine', workspaceDialect: 'egyptian' }).key,
    ).toBe('levantine');
  });

  it('falls back to the workspace when the brand has none', () => {
    expect(resolveDialect(POLICY, { brandDialect: null, workspaceDialect: 'gulf' }).key).toBe(
      'gulf',
    );
  });

  it('defaults to MSA when nothing is configured', () => {
    expect(resolveDialect(POLICY, {}).key).toBe('msa');
  });

  it('NEVER defaults to Saudi or Gulf — the decision is explicit about this', () => {
    /*
     * The owner's decision says in as many words: "Do not hard-code Saudi
     * dialect as the global default." The platform is sold from Saudi Arabia
     * and its default workspace country is SA, so this is exactly the
     * assumption that would creep in unnoticed. Asserted so it cannot.
     */
    const resolved = resolveDialect(POLICY, {});
    expect(resolved.key).not.toBe('gulf');
    expect(resolved.bcp47).toBe('ar');
  });

  it('falls back rather than throwing when a configured dialect was retired', () => {
    // An operator removed `emirati` after a brand had chosen it. The brand
    // should keep writing readable Arabic, not stop writing.
    expect(resolveDialect(POLICY, { brandDialect: 'emirati' }).key).toBe('msa');
  });

  it('the shipped configuration default is MSA and is a supported dialect', () => {
    // The two schemas must agree: the SERVICE policy and what an OPERATOR can
    // save. A drift here is how the default quietly becomes something else.
    const parsed = CONFIG_DOMAINS.content.schema.parse({});
    expect(parsed.dialects.defaultKey).toBe('msa');
    expect(parsed.dialects.supported.map((d) => d.key)).toEqual(
      expect.arrayContaining(['msa', 'gulf', 'egyptian', 'levantine']),
    );
    // And it parses as a service policy, which is what keeps the two in step.
    expect(() => parseContentPolicy(parsed)).not.toThrow();
  });

  it('configuration refuses a default that is not one of the supported dialects', () => {
    expect(() =>
      CONFIG_DOMAINS.content.schema.parse({
        dialects: {
          defaultKey: 'klingon',
          supported: [{ key: 'msa', labelKey: 'content.dialect.msa', bcp47: 'ar' }],
        },
      }),
    ).toThrow();
  });
});

describe('D-116 and D-117 — retention windows', () => {
  const clock = clockAt('2026-09-15T00:00:00.000Z');

  it('an active subscription with no customer setting never expires', () => {
    expect(resolveContentExpiry(POLICY, { subscriptionActive: true }, clock)).toBeNull();
  });

  it('a cancelled subscription expires after the configured grace window', () => {
    const expiry = resolveContentExpiry(
      POLICY,
      { subscriptionActive: false, cancelledAt: new Date('2026-09-01T00:00:00.000Z') },
      clock,
    );
    // 1 September + 30 days.
    expect(expiry?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it("the customer's control shortens retention even while subscribed", () => {
    const expiry = resolveContentExpiry(
      POLICY,
      { subscriptionActive: true, workspaceRetentionDays: 14 },
      clock,
    );
    expect(expiry?.toISOString()).toBe('2026-09-29T00:00:00.000Z');
  });

  it('the control is floored, so it cannot delete work the same afternoon', () => {
    const expiry = resolveContentExpiry(
      POLICY,
      { subscriptionActive: true, workspaceRetentionDays: 1 },
      clock,
    );
    // Floored at 7, not honoured at 1.
    expect(expiry?.toISOString()).toBe('2026-09-22T00:00:00.000Z');
  });

  it('the control can SHORTEN but never LENGTHEN a cancelled account', () => {
    /*
     * A customer asking for ten years must not thereby extend a cancelled
     * account's grace period past what the owner approved. Retention is a
     * promise the platform makes and a limit the customer may tighten — not a
     * dial for making the platform store their content for ever.
     */
    const expiry = resolveContentExpiry(
      POLICY,
      {
        subscriptionActive: false,
        cancelledAt: new Date('2026-09-01T00:00:00.000Z'),
        workspaceRetentionDays: 3_650,
      },
      clock,
    );
    expect(expiry?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });
});

describe('D-117 — the retention registry', () => {
  it('every feature that persists AI output declares an owner and a behaviour', () => {
    expect(AI_OUTPUT_RETENTION_REGISTRY.length).toBeGreaterThan(0);
    for (const entry of AI_OUTPUT_RETENTION_REGISTRY) {
      expect(entry.featureKey, 'featureKey').toBeTruthy();
      expect(entry.retentionOwner, `${entry.featureKey} retentionOwner`).toMatch(/^@brandspace\//);
      expect(entry.persists.length, `${entry.featureKey} persists`).toBeGreaterThan(0);
      expect(entry.behaviour.configPath, `${entry.featureKey} configPath`).toBeTruthy();
    }
  });

  it('every feature that persists output today is registered', () => {
    /*
     * THE FAILURE MODE THIS GUARDS IS SILENT. A future feature that persists
     * generated output and forgets to declare an owner leaves customer content
     * on disk with nobody responsible for deleting it, and nothing else in the
     * system would notice. This list is what makes that a build failure.
     */
    expect(AI_OUTPUT_RETENTION_REGISTRY.map((e) => e.featureKey).sort()).toEqual([
      'ai.copilot',
      'analytics',
      'analytics.insights',
      'brand-brain.chat',
      'content-studio',
    ]);
  });

  it('the Content Studio honours the workspace control and Brand Brain chat does not yet', () => {
    // Recorded honestly rather than claimed: Phase 5A predates the control.
    const byKey = Object.fromEntries(AI_OUTPUT_RETENTION_REGISTRY.map((e) => [e.featureKey, e]));
    expect(byKey['content-studio']?.honoursWorkspaceControl).toBe(true);
    expect(byKey['brand-brain.chat']?.honoursWorkspaceControl).toBe(false);
  });

  it('records with their own retention are named as out of reach', () => {
    for (const table of ['audit_event', 'credit_transaction', 'ai_usage_ledger']) {
      expect(RETENTION_EXCLUDED_TABLES).toContain(table);
    }
    // And no registered feature claims to persist into one of them.
    for (const entry of AI_OUTPUT_RETENTION_REGISTRY) {
      for (const target of entry.persists) {
        const table = target.split('.')[0] ?? '';
        expect(RETENTION_EXCLUDED_TABLES, `${entry.featureKey} → ${target}`).not.toContain(table);
      }
    }
  });
});

describe('AC-11.9 — parsing a model response', () => {
  const options = { platformKeys: ['instagram', 'x'], maxVariants: 4 };

  it('parses clean JSON', () => {
    const parsed = parseGeneratedContent(
      JSON.stringify({
        title: 'T',
        variants: [{ platformKey: 'instagram', body: 'B', hashtags: ['h'] }],
      }),
      options,
    );
    expect(parsed.title).toBe('T');
    expect(parsed.variants[0]?.body).toBe('B');
  });

  it('parses JSON inside a code fence', () => {
    const parsed = parseGeneratedContent(
      '```json\n{"title":"T","variants":[{"platformKey":"x","body":"B"}]}\n```',
      options,
    );
    expect(parsed.variants[0]?.platformKey).toBe('x');
  });

  it('parses JSON padded with a sentence', () => {
    const parsed = parseGeneratedContent(
      'Here you go! {"title":"T","variants":[{"platformKey":"x","body":"B"}]} Hope that helps.',
      options,
    );
    expect(parsed.variants[0]?.body).toBe('B');
  });

  it('refuses prose', () => {
    expect(() => parseGeneratedContent('I cannot help with that.', options)).toThrow();
  });

  it('refuses JSON of the wrong shape', () => {
    expect(() => parseGeneratedContent('{"foo":"bar"}', options)).toThrow();
  });

  it('drops a platform nobody asked for', () => {
    const parsed = parseGeneratedContent(
      JSON.stringify({
        title: 'T',
        variants: [
          { platformKey: 'instagram', body: 'wanted' },
          { platformKey: 'myspace', body: 'invented' },
        ],
      }),
      options,
    );
    expect(parsed.variants).toHaveLength(1);
    expect(parsed.variants[0]?.platformKey).toBe('instagram');
  });

  it('refuses when nothing requested survives', () => {
    expect(() =>
      parseGeneratedContent(
        JSON.stringify({ title: 'T', variants: [{ platformKey: 'myspace', body: 'B' }] }),
        options,
      ),
    ).toThrow();
  });

  it('keeps one variant per platform, so a duplicate cannot violate the unique index', () => {
    const parsed = parseGeneratedContent(
      JSON.stringify({
        title: 'T',
        variants: [
          { platformKey: 'x', body: 'first' },
          { platformKey: 'x', body: 'second' },
        ],
      }),
      options,
    );
    expect(parsed.variants).toHaveLength(1);
    expect(parsed.variants[0]?.body).toBe('first');
  });

  it('bounds the fan-out a single response can cause', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      platformKey: 'instagram',
      body: `b${i}`,
    }));
    const parsed = parseGeneratedContent(JSON.stringify({ title: 'T', variants: many }), {
      platformKeys: ['instagram'],
      maxVariants: 2,
    });
    expect(parsed.variants.length).toBeLessThanOrEqual(2);
  });

  it('accepts the single-body shape the editing tools ask for', () => {
    const parsed = parseGeneratedContent(JSON.stringify({ body: 'edited', hashtags: ['a'] }), {
      platformKeys: ['x'],
      maxVariants: 1,
      singleBody: true,
    });
    expect(parsed.variants[0]).toEqual({ platformKey: 'x', body: 'edited', hashtags: ['a'] });
  });

  it('names no provider, model or shape in the failure a customer sees', () => {
    // AC-11.6. "The model returned invalid JSON" would leak that there is a
    // model and invite someone to find out which.
    try {
      parseGeneratedContent('not json', options);
      throw new Error('should have thrown');
    } catch (error) {
      const message = (error as Error).message.toLowerCase();
      for (const leak of ['json', 'model', 'provider', 'schema', 'parse']) {
        expect(message, `leaks "${leak}"`).not.toContain(leak);
      }
    }
  });
});

describe('character counting and variant validation', () => {
  it('counts what a person means by a character, not UTF-16 code units', () => {
    /*
     * THE BUG THIS PREVENTS IS INVISIBLE UNTIL IT IS ARABIC OR AN EMOJI.
     * `"👍".length` is 2 and `"👍"` is one character; Arabic with combining
     * marks counts differently again. A limit shown to a person has to be
     * checked in the unit that person counts in.
     */
    expect('👍'.length).toBe(2);
    expect(countCharacters('👍')).toBe(1);
    expect(countCharacters('مرحبا')).toBe(5);
    expect(countCharacters('👨‍👩‍👧‍👦')).toBe(1);
  });

  it('flags a caption over the platform limit', () => {
    const platform = POLICY.platforms[1]!; // x, 280
    const result = validateVariant(platform, { body: 'a'.repeat(300) });
    expect(result.state).toBe('INVALID');
    expect(result.characterCount).toBe(300);
    expect(result.errors[0]?.key).toBe('content.validation.bodyTooLong');
    expect(result.errors[0]?.limit).toBe(280);
  });

  it('flags too many hashtags', () => {
    const platform = POLICY.platforms[1]!;
    const result = validateVariant(platform, {
      body: 'short',
      hashtags: ['a', 'b', 'c', 'd', 'e', 'f'],
    });
    expect(result.state).toBe('INVALID');
    expect(result.errors.some((e) => e.key === 'content.validation.tooManyHashtags')).toBe(true);
  });

  it('flags a first comment on a platform that has none', () => {
    const platform = POLICY.platforms[1]!;
    const result = validateVariant(platform, { body: 'short', firstComment: 'hello' });
    expect(result.errors.some((e) => e.key === 'content.validation.firstCommentUnsupported')).toBe(
      true,
    );
  });

  it('treats an empty draft as a warning, not an error', () => {
    // A draft in progress is a normal thing to save; calling it invalid would
    // put a red state on every new post the moment it is created.
    const result = validateVariant(POLICY.platforms[0]!, { body: '   ' });
    expect(result.state).toBe('WARNINGS');
  });

  it('returns VALID with no errors for a caption that fits', () => {
    const result = validateVariant(POLICY.platforms[0]!, { body: 'Just right.', hashtags: ['x'] });
    expect(result.state).toBe('VALID');
    expect(result.errors).toEqual([]);
  });

  it('every validation error is a translation KEY, never prose', () => {
    // CLAUDE.md §4: the customer reads this in Arabic or English, and the
    // service must not decide which.
    const result = validateVariant(POLICY.platforms[1]!, {
      body: 'a'.repeat(300),
      hashtags: ['a', 'b', 'c', 'd', 'e', 'f'],
      firstComment: 'x',
    });
    for (const error of result.errors) {
      expect(error.key).toMatch(/^content\.validation\.[a-zA-Z]+$/);
      expect(error.key).not.toMatch(/\s/);
    }
  });
});
