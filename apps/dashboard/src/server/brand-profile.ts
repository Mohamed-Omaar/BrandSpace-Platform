import { AppError } from '@brandspace/shared';

/**
 * THE BRAND PROFILE DECODER.
 *
 * IN ITS OWN MODULE, NOT IN THE `'use server'` ACTION — the Phase 7 round-5
 * lesson, applied before it costs anything. A `'use server'` module may export
 * only async server actions, so anything living there can be reached by a test
 * only through a browser; and every rule below is about a request THE SCREEN
 * CANNOT PRODUCE.
 *
 * THE RULE IT KEEPS: A BLANK FIELD CLEARS, AND A MISSING FIELD IS A REFUSAL.
 *
 * They are not the same request. Every control this form renders is submitted
 * by every real submission, so a field that is ABSENT came from something that
 * never went through the screen — a truncated post, a stale tab, a hand-made
 * request — and the safe answer is to refuse the whole thing rather than to
 * guess which half of somebody's brand identity they meant to keep.
 *
 * A field that is PRESENT AND EMPTY is a person deleting a value, which is an
 * ordinary thing to want and is stored as `null`.
 */

export interface BrandProfileInput {
  readonly name: string;
  readonly industry: string | null;
  readonly description: string | null;
  readonly websiteUrl: string | null;
  readonly defaultLocale: 'AR' | 'EN';
  readonly supportedLocales: readonly ('AR' | 'EN')[];
  readonly colorPalette: readonly string[];
  readonly typography: { readonly heading: string | null; readonly body: string | null };
  readonly primaryLogoAssetId: string | null;
  readonly secondaryLogoAssetId: string | null;
}

const LOCALES = ['AR', 'EN'] as const;
/** `#rgb` or `#rrggbb`, and nothing else. */
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function required(formData: FormData, field: string): string {
  const raw = formData.get(field);
  if (raw === null) throw new AppError('VALIDATION_FAILED', `The ${field} field is missing.`);
  return String(raw);
}

/** Present-and-empty becomes `null`; absent is a refusal. */
function optionalText(formData: FormData, field: string, max: number): string | null {
  const value = required(formData, field).trim();
  if (value === '') return null;
  if (value.length > max) {
    throw new AppError('VALIDATION_FAILED', `The ${field} field is too long.`);
  }
  return value;
}

/** An id the form carried, or null. Shape-checked only — scope is the database's job. */
function optionalAssetId(formData: FormData, field: string): string | null {
  const value = required(formData, field).trim();
  if (value === '') return null;
  /*
   * A SHAPE CHECK, NOT AN AUTHORIZATION CHECK, and the difference matters.
   * Whether this asset may be named is settled where it cannot be forgotten:
   * the composite foreign key refuses another workspace's asset, and the
   * `brand_canonical_asset_scope` trigger refuses another brand's (D-193).
   * Rejecting a malformed uuid here only keeps a nonsense value out of a
   * query.
   */
  if (!UUID.test(value)) throw new AppError('VALIDATION_FAILED', 'That is not an asset.');
  return value;
}

export function brandProfileFrom(formData: FormData): BrandProfileInput {
  const name = required(formData, 'name').trim();
  if (name.length < 2) throw new AppError('VALIDATION_FAILED', 'A brand name is required.');
  if (name.length > 120) throw new AppError('VALIDATION_FAILED', 'That brand name is too long.');

  const defaultLocale = required(formData, 'defaultLocale').trim();
  if (defaultLocale !== 'AR' && defaultLocale !== 'EN') {
    throw new AppError('VALIDATION_FAILED', 'Unsupported locale.');
  }

  /*
   * THE SUPPORTED LOCALES ALWAYS CONTAIN THE DEFAULT ONE. A brand whose default
   * language is not among the ones it supports is a contradiction the rest of
   * the product would have to keep resolving — the composer, the calendar and
   * every generation prompt each read both.
   */
  const supported = new Set(
    formData
      .getAll('supportedLocales')
      .map((value) => String(value))
      .filter((value): value is 'AR' | 'EN' => (LOCALES as readonly string[]).includes(value)),
  );
  supported.add(defaultLocale);

  const websiteUrl = optionalText(formData, 'websiteUrl', 2_048);
  if (websiteUrl !== null && !/^https?:\/\/\S+$/i.test(websiteUrl)) {
    /*
     * HTTP(S) ONLY. A `javascript:` or `data:` URL stored here would be
     * rendered as a link on a page somebody else in the workspace opens, which
     * turns a profile field into a way to run script in a colleague's session.
     */
    throw new AppError('VALIDATION_FAILED', 'A website must be an http(s) address.');
  }

  const colorPalette = [
    ...new Set(
      formData
        .getAll('colorPalette')
        .flatMap((value) => String(value).split(','))
        .map((value) => value.trim())
        .filter((value) => value !== ''),
    ),
  ];
  for (const colour of colorPalette) {
    if (!HEX.test(colour)) {
      throw new AppError('VALIDATION_FAILED', `"${colour}" is not a colour.`);
    }
  }
  if (colorPalette.length > 12) {
    throw new AppError('VALIDATION_FAILED', 'A palette holds at most twelve colours.');
  }

  return {
    name,
    industry: optionalText(formData, 'industry', 120),
    description: optionalText(formData, 'description', 2_000),
    websiteUrl,
    defaultLocale,
    supportedLocales: [...supported],
    colorPalette,
    typography: {
      heading: optionalText(formData, 'headingFont', 120),
      body: optionalText(formData, 'bodyFont', 120),
    },
    primaryLogoAssetId: optionalAssetId(formData, 'primaryLogoAssetId'),
    secondaryLogoAssetId: optionalAssetId(formData, 'secondaryLogoAssetId'),
  };
}

/** The stored JSON shapes, read defensively — the column is `Json?`. */
export function paletteFrom(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && HEX.test(entry));
}

export function typographyFrom(value: unknown): { heading: string | null; body: string | null } {
  if (typeof value !== 'object' || value === null) return { heading: null, body: null };
  const record = value as Record<string, unknown>;
  const read = (key: string): string | null =>
    typeof record[key] === 'string' && record[key] !== '' ? (record[key] as string) : null;
  return { heading: read('heading'), body: read('body') };
}
