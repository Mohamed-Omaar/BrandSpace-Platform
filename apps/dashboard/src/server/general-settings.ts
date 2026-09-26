import { isKnownTimeZone } from '@brandspace/content';
import { writeAuditEvent, type TenantScopedClient } from '@brandspace/database';
import {
  AppError,
  CITY_COUNTRY,
  assertBrandInScope,
  isEgyptCityCode,
  isIsoCountryCode,
} from '@brandspace/shared';
import { industryFrom, websiteUrlFrom } from './brand-profile';
import { multiBrandEnabled, type FeatureGate } from './multi-brand';

/**
 * SETTINGS → GENERAL (A9, prototype v94 Phase 2B-1, D-330).
 *
 * The decoder and the save, in a module of their own so the isolation suite
 * runs them against PostgreSQL rather than through a browser (the Phase 7
 * round-5 lesson, as `brand-profile.ts` states it).
 *
 * WHAT IS THE WORKSPACE'S AND WHAT IS THE BRAND'S. Name, language, country,
 * time zone, city and week start are the workspace's. Industry and website
 * stay on the BRAND — one source, already written by the setup wizard and read
 * by Creative and the calendar's observances — and are edited from here only
 * while multi-brand is off, when the workspace has exactly one brand. With
 * multi-brand on they are edited on each brand's own profile.
 */

export interface GeneralSettingsInput {
  readonly name: string;
  readonly defaultLocale: 'AR' | 'EN';
  readonly country: string;
  readonly timezone: string;
  /** An ISO 3166-2:EG code, and only when the country is Egypt; otherwise null. */
  readonly city: string | null;
  readonly weekStartsOn: number;
  /** Present only when the form carried the sole brand's fields. */
  readonly brand: {
    readonly brandId: string;
    readonly industry: string | null;
    readonly websiteUrl: string | null;
  } | null;
}

function field(formData: FormData, name: string): string {
  const raw = formData.get(name);
  if (raw === null) throw new AppError('VALIDATION_FAILED', `The ${name} field is missing.`);
  return String(raw).trim();
}

export function generalSettingsFrom(formData: FormData): GeneralSettingsInput {
  const name = field(formData, 'name');
  if (name.length < 2) throw new AppError('VALIDATION_FAILED', 'A workspace name is required.');
  if (name.length > 120) throw new AppError('VALIDATION_FAILED', 'That name is too long.');

  const defaultLocale = field(formData, 'defaultLocale');
  if (defaultLocale !== 'AR' && defaultLocale !== 'EN') {
    throw new AppError('VALIDATION_FAILED', 'Unsupported locale.');
  }

  const country = field(formData, 'country').toUpperCase();
  if (!isIsoCountryCode(country)) throw new AppError('VALIDATION_FAILED', 'Choose a country.');

  // A zone the runtime does not know would schedule every post against UTC
  // without saying so; it is refused rather than stored.
  const timezone = field(formData, 'timezone');
  if (!isKnownTimeZone(timezone)) throw new AppError('VALIDATION_FAILED', 'Choose a time zone.');

  // EGYPT ONLY. For any other country the city is cleared, whatever was sent.
  const rawCity = formData.get('city');
  const cityValue = rawCity === null ? '' : String(rawCity).trim();
  let city: string | null = null;
  if (country === CITY_COUNTRY && cityValue !== '') {
    if (!isEgyptCityCode(cityValue)) throw new AppError('VALIDATION_FAILED', 'Choose a city.');
    city = cityValue;
  }

  const weekStartsOn = Number(field(formData, 'weekStartsOn'));
  if (!Number.isInteger(weekStartsOn) || weekStartsOn < 0 || weekStartsOn > 6) {
    throw new AppError('VALIDATION_FAILED', 'Choose the first day of the week.');
  }

  const brandId = formData.get('brandId');
  const brand =
    brandId === null
      ? null
      : {
          brandId: String(brandId),
          industry: industryFrom(formData),
          websiteUrl: websiteUrlFrom(formData),
        };

  return {
    name,
    defaultLocale,
    country,
    timezone,
    city,
    weekStartsOn,
    brand,
  };
}

/**
 * Save it — inside the caller's `withWorkspace` transaction, so RLS applies to
 * every statement and the workspace and brand change together or not at all.
 *
 * `workspace.update` is the caller's gate. The brand's fields need more, each
 * checked HERE and before the brand is read: `brand.manage`, the member's
 * BrandScope, and multi-brand being off.
 */
export async function saveGeneralSettings(
  db: TenantScopedClient,
  gate: FeatureGate,
  context: {
    readonly workspaceId: string;
    readonly actorUserId: string;
    readonly permissionKeys: readonly string[];
    readonly brandScope: readonly string[];
  },
  input: GeneralSettingsInput,
): Promise<void> {
  const { workspaceId, actorUserId } = context;

  if (input.brand) {
    if (!context.permissionKeys.includes('brand.manage')) {
      throw new AppError('FORBIDDEN', 'Only a member who manages the brand may change it here.');
    }
    assertBrandInScope(context.brandScope, input.brand.brandId);
    if (await multiBrandEnabled(gate, workspaceId)) {
      throw new AppError('FORBIDDEN', "Each brand's industry and website are on its profile.", {
        reason: 'MULTI_BRAND_ON',
      });
    }
  }

  const before = await db.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: {
      name: true,
      defaultLocale: true,
      timezone: true,
      country: true,
      city: true,
      weekStartsOn: true,
    },
  });
  const after = {
    name: input.name,
    defaultLocale: input.defaultLocale,
    timezone: input.timezone,
    country: input.country,
    city: input.city,
    weekStartsOn: input.weekStartsOn,
  };
  await db.workspace.update({ where: { id: workspaceId }, data: after });
  await writeAuditEvent(db, workspaceId, {
    action: 'workspace.settings.updated',
    actorType: 'USER',
    actorId: actorUserId,
    resourceType: 'workspace',
    resourceId: workspaceId,
    severity: 'NOTICE',
    before,
    after,
  });

  if (input.brand) {
    const { brandId, industry, websiteUrl } = input.brand;
    const brandBefore = await db.brand.findFirst({
      where: { id: brandId, deletedAt: null },
      select: { industry: true, websiteUrl: true },
    });
    // Another workspace's brand, a deleted one and a made-up id are the same
    // answer: RLS hides the first, so none of the three can be told apart.
    if (!brandBefore) throw new AppError('NOT_FOUND', 'Brand not found.');
    if (brandBefore.industry !== industry || brandBefore.websiteUrl !== websiteUrl) {
      await db.brand.update({ where: { id: brandId }, data: { industry, websiteUrl } });
      await writeAuditEvent(db, workspaceId, {
        action: 'brand.profile.updated',
        actorType: 'USER',
        actorId: actorUserId,
        resourceType: 'brand',
        resourceId: brandId,
        brandId,
        severity: 'NOTICE',
        before: brandBefore,
        after: { industry, websiteUrl },
      });
    }
  }
}
