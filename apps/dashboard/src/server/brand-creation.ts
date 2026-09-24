import 'server-only';
import { randomUUID } from 'node:crypto';
import { writeAuditEvent } from '@brandspace/database';
import { QUOTA_FEATURES, TOTAL_RESOURCE_DIMENSIONS } from '@brandspace/entitlements';
import { inBrandBrain } from './brand-brain-context';
import type { WorkspaceSession } from './customer-context';

/**
 * CREATING A BRAND — the one path, shared by Brand Brain's "create a brand"
 * and the first-run Setup Wizard (Phase 6 final, D-277 §6).
 *
 * It used to live inside `createBrandAction`, and the wizard needs the same
 * thing with a few more of the brand's own fields. Two copies would be two
 * quota checks and two idempotency rules waiting to disagree, so there is one:
 *
 *   - IDEMPOTENT ON THE NAME (case-insensitive): a replayed submit, or the
 *     wizard walked twice, returns the brand that exists instead of a second
 *     one with a different slug;
 *   - COUNTED AGAINST THE PLAN'S BRAND QUOTA through the entitlements engine,
 *     keyed so a retry is not charged twice;
 *   - AUDITED (`brand.created`) — CLAUDE.md §5 asks every mutation of tenant
 *     state for an AuditEvent, and brand creation had none.
 *
 * The profile fields are OPTIONAL and already validated by the caller
 * (`brandProfileFrom`'s rules): http(s) websites only, hex colours only, the
 * default language always among the supported ones.
 */
export interface NewBrandInput {
  readonly name: string;
  readonly defaultLocale: 'AR' | 'EN';
  readonly supportedLocales: readonly ('AR' | 'EN')[];
  readonly industry?: string | null;
  readonly websiteUrl?: string | null;
  readonly colorPalette?: readonly string[];
}

export async function createBrandFor(
  session: WorkspaceSession,
  input: NewBrandInput,
): Promise<{ readonly brandId: string; readonly created: boolean }> {
  const workspaceId = session.workspace.workspaceId;
  const name = input.name.trim();

  return inBrandBrain(workspaceId, async ({ db, entitlements, usage }) => {
    const existing = await db.brand.findFirst({
      where: { workspaceId, deletedAt: null, name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    });
    if (existing) return { brandId: existing.id, created: false };

    await usage.consume({
      workspaceId,
      featureKey: QUOTA_FEATURES.brands,
      limitValue: await entitlements.limit(workspaceId, QUOTA_FEATURES.brands),
      period: 'total',
      idempotencyKey: `brand:${workspaceId}:${name.toLowerCase()}`,
      baselineCount: (scoped) => TOTAL_RESOURCE_DIMENSIONS.brands.live(scoped, workspaceId),
    });

    // A slug from the name, with a short suffix so two brands called the same
    // thing never collide and a soft-deleted brand never holds its slug.
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'brand';
    const supported = new Set(input.supportedLocales);
    supported.add(input.defaultLocale);

    const brand = await db.brand.create({
      data: {
        workspaceId,
        slug: `${base}-${randomUUID().slice(0, 6)}`,
        name,
        status: 'ACTIVE',
        defaultLocale: input.defaultLocale,
        supportedLocales: [...supported],
        industry: input.industry ?? null,
        websiteUrl: input.websiteUrl ?? null,
        ...(input.colorPalette && input.colorPalette.length > 0
          ? { colorPalette: [...input.colorPalette] }
          : {}),
      },
      select: { id: true },
    });

    await writeAuditEvent(db, workspaceId, {
      action: 'brand.created',
      actorType: 'USER',
      actorId: session.customer.userId,
      resourceType: 'brand',
      resourceId: brand.id,
      brandId: brand.id,
      severity: 'NOTICE',
      after: {
        name,
        defaultLocale: input.defaultLocale,
        supportedLocales: [...supported],
      },
    });

    return { brandId: brand.id, created: true };
  });
}
