import { describe, expect, it } from 'vitest';
import {
  FORMAT_POST_KINDS,
  mediaRuleViolation,
  observationMismatches,
  postKindFor,
  refreshIsDue,
} from '@brandspace/social-connectors';
import { socialApplicationFor } from '../../apps/api/src/routes/social';

/**
 * CONNECTORS A — the pure rules behind W2, W3, R8, W6 and D-505 O3. Each is
 * decided before or after a provider call and never by one, so each is a
 * function of its inputs and is proven here without a database.
 */

const rule = (overrides: Record<string, unknown> = {}) => ({
  mimeTypes: [] as string[],
  maxBytes: null,
  minWidth: null,
  maxWidth: null,
  minHeight: null,
  maxHeight: null,
  minAspectRatio: null,
  maxAspectRatio: null,
  minDurationSeconds: null,
  maxDurationSeconds: null,
  minItems: null,
  maxItems: null,
  ...overrides,
});
const image = (overrides: Record<string, unknown> = {}) => ({
  mimeType: 'image/jpeg',
  sizeBytes: 1_000,
  width: 1_080,
  height: 1_350,
  durationMs: null as number | null,
  ...overrides,
});

describe('W2 — the post kind', () => {
  it('a plain post is `text` without media and `image` with it', () => {
    expect(postKindFor('POST', [])).toBe('text');
    expect(postKindFor('POST', [{ mimeType: 'image/png' }])).toBe('image');
  });

  it('every other format is its own kind, and an unknown format is none', () => {
    expect(postKindFor('REEL', [{ mimeType: 'video/mp4' }])).toBe('reel');
    expect(postKindFor('CAROUSEL', [])).toBe('carousel');
    expect(postKindFor('STORY', [])).toBe('story');
    expect(postKindFor('NOT_A_FORMAT', [])).toBeNull();
  });

  it('the map the composer reads is the map the pipeline reads', () => {
    expect(FORMAT_POST_KINDS['POST']).toEqual(['text', 'image']);
    expect(Object.keys(FORMAT_POST_KINDS).sort()).toEqual(
      ['ARTICLE', 'CAROUSEL', 'POST', 'REEL', 'STORY', 'THREAD', 'VIDEO'].sort(),
    );
  });
});

describe('W3 — media rules from configuration', () => {
  it('no rule, or a rule of nulls, refuses nothing', () => {
    expect(mediaRuleViolation(undefined, [image()])).toBeNull();
    expect(mediaRuleViolation(rule(), [image()])).toBeNull();
  });

  it('names the first rule a file breaks', () => {
    expect(mediaRuleViolation(rule({ mimeTypes: ['image/png'] }), [image()])).toBe('mime_type');
    expect(mediaRuleViolation(rule({ maxBytes: 999 }), [image()])).toBe('max_bytes');
    expect(mediaRuleViolation(rule({ minWidth: 2_000 }), [image()])).toBe('min_width');
    expect(mediaRuleViolation(rule({ maxHeight: 1_000 }), [image()])).toBe('max_height');
    expect(mediaRuleViolation(rule({ maxAspectRatio: 0.7 }), [image()])).toBe('max_aspect_ratio');
    expect(mediaRuleViolation(rule({ minAspectRatio: 0.9 }), [image()])).toBe('min_aspect_ratio');
    expect(mediaRuleViolation(rule({ minItems: 2 }), [image()])).toBe('min_items');
    expect(mediaRuleViolation(rule({ maxItems: 1 }), [image(), image()])).toBe('max_items');
  });

  it('a size rule cannot be met by a file whose size the library does not know', () => {
    expect(mediaRuleViolation(rule({ minWidth: 1 }), [image({ width: null })])).toBe(
      'dimensions_unknown',
    );
  });

  it('duration applies to video only, and an unknown duration is refused', () => {
    const video = image({ mimeType: 'video/mp4', durationMs: 95_000 });
    expect(mediaRuleViolation(rule({ maxDurationSeconds: 90 }), [video])).toBe('max_duration');
    expect(mediaRuleViolation(rule({ minDurationSeconds: 100 }), [video])).toBe('min_duration');
    expect(mediaRuleViolation(rule({ maxDurationSeconds: 120 }), [video])).toBeNull();
    expect(
      mediaRuleViolation(rule({ maxDurationSeconds: 90 }), [{ ...video, durationMs: null }]),
    ).toBe('duration_unknown');
    expect(mediaRuleViolation(rule({ maxDurationSeconds: 1 }), [image()])).toBeNull();
  });
});

describe('R8 — the published copy against the preview', () => {
  const request = { postKind: 'image' as const, media: [{}, {}] as never[], body: 'Hello  World' };

  it('nothing read back, nothing compared', () => {
    expect(observationMismatches(request, undefined)).toEqual([]);
  });

  it('a caption that CONTAINS the author’s words matches — spacing and case aside', () => {
    expect(
      observationMismatches(request, { caption: 'hello world #launch', mediaCount: 2 }),
    ).toEqual([]);
  });

  it('names every field that differs', () => {
    expect(
      observationMismatches(request, { postKind: 'carousel', mediaCount: 1, caption: 'Hi' }),
    ).toEqual(['postKind', 'mediaCount', 'caption']);
  });
});

describe('W6 — when a token is refreshed ahead of expiry', () => {
  const issuedAt = new Date('2026-01-01T00:00:00Z');
  const expiresAt = new Date('2026-01-02T00:00:00Z');
  const at = (hours: number) => new Date(issuedAt.getTime() + hours * 3_600_000);

  it('at the configured share of its life, not before', () => {
    expect(refreshIsDue({ issuedAt, expiresAt, ratio: 0.75, now: at(17.9) })).toBe(false);
    expect(refreshIsDue({ issuedAt, expiresAt, ratio: 0.75, now: at(18) })).toBe(true);
  });

  it('a token with no expiry is never due; an empty life is due at once', () => {
    expect(refreshIsDue({ issuedAt, expiresAt: null, ratio: 0.75, now: at(1_000) })).toBe(false);
    expect(refreshIsDue({ issuedAt, expiresAt: issuedAt, ratio: 0.75, now: issuedAt })).toBe(true);
  });
});

describe('D-505 O3 — one Meta app, one secret', () => {
  const document = {
    applications: [
      { providerKey: 'facebook', appId: 'meta', clientSecretRef: 'ref-meta', status: 'active' },
      {
        providerKey: 'instagram',
        appId: 'meta',
        clientSecretRef: null,
        status: 'active',
        sharesCredentialWith: 'facebook',
        settings: { apiVersion: 'v1' },
      },
    ],
  };

  it('instagram resolves facebook’s secret reference, and keeps its own settings', () => {
    const { application, clientSecretRef } = socialApplicationFor(document, 'INSTAGRAM');
    expect(clientSecretRef).toBe('ref-meta');
    expect(application.settings).toEqual({ apiVersion: 'v1' });
  });

  it('an inactive or missing application is refused', () => {
    expect(() => socialApplicationFor(document, 'TIKTOK')).toThrow(/No active/);
    expect(() =>
      socialApplicationFor(
        { applications: [{ ...document.applications[0]!, clientSecretRef: null }] },
        'FACEBOOK',
      ),
    ).toThrow(/no client secret/);
  });
});
