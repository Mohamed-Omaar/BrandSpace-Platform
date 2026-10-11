import type {
  BrandKnowledgeService,
  KnowledgeActor,
  StalenessPolicy,
} from '@brandspace/brand-brain';
import { writeAuditEvent, type TenantScopedClient } from '@brandspace/database';
import { AppError, assertBrandInScope } from '@brandspace/shared';
import {
  GOAL_ITEM_KEY,
  SETUP_GOAL_CHANGE_KIND,
  goalKnowledge,
  ownGoalKnowledge,
  type SetupGoal,
} from './setup-wizard-state';

/**
 * THE FIRST GOAL CHOSEN IN SETUP (D-278, D-335) — in a module of its own so the
 * isolation suite runs it against PostgreSQL, as `general-settings.ts` does.
 *
 * TWO WRITES, ONE TRANSACTION (the caller's `withWorkspace`, so RLS applies to
 * both):
 *
 *   1. The goal as knowledge — the STRATEGY item `goal.primary`, origin SETUP,
 *      through `BrandKnowledgeService`: versioned, audited, editable in Brand
 *      Brain. That item is the goal; nothing else is a second copy of it.
 *   2. The goal's KEY on the brand (`primaryGoalKey`), so every reader shows it
 *      in its own language instead of matching an English title. A reader
 *      trusts the key only while setup wrote the item's latest version
 *      (`storedGoal`).
 */
export async function saveSetupGoal(
  db: TenantScopedClient,
  knowledge: BrandKnowledgeService,
  input: {
    readonly workspaceId: string;
    readonly brandId: string;
    /**
     * One of ours, or — D-496 (Auth 8) — the person's own words, stored as the
     * same STRATEGY item with no goal key on the brand (a typed goal is not
     * one of the keys, so the brand carries none).
     */
    readonly goal: SetupGoal | { readonly own: string };
    readonly actor: KnowledgeActor;
    readonly staleness: StalenessPolicy;
  },
): Promise<void> {
  const { workspaceId, brandId, actor } = input;
  // The key the brand carries: the chosen goal's, or none for a typed one.
  const goal = typeof input.goal === 'string' ? input.goal : null;
  // BEFORE any read (docs/SECURITY.md §4.2). Out of scope is a 404.
  assertBrandInScope(actor.brandScope, brandId);

  const brand = await db.brand.findFirst({
    where: { id: brandId, deletedAt: null },
    select: { primaryGoalKey: true },
  });
  // Another workspace's brand (hidden by RLS), a deleted one and a made-up id
  // are the same answer.
  if (!brand) throw new AppError('NOT_FOUND', 'Brand not found.');

  const { title, body } =
    typeof input.goal === 'string' ? goalKnowledge(input.goal) : ownGoalKnowledge(input.goal.own);
  const existing = await db.brandKnowledgeItem.findFirst({
    where: {
      brandId,
      area: 'STRATEGY',
      itemKey: GOAL_ITEM_KEY,
      status: { in: ['ACTIVE', 'STALE'] },
    },
    select: { id: true },
  });
  if (existing) {
    await knowledge.updateItem({
      itemId: existing.id,
      title,
      body,
      changeReason: 'First goal chosen in setup',
      actor,
      policy: input.staleness,
      // SETUP ranks below HUMAN (D-335): a goal a person wrote in Brand Brain
      // is theirs, and choosing again in setup is refused rather than
      // overwriting it (`mayOverwrite`), with the transaction rolled back.
      incomingOrigin: 'SETUP',
      // What tells a reader the goal key still describes this item.
      changeKind: SETUP_GOAL_CHANGE_KIND,
    });
  } else {
    await knowledge.createItem({
      brandId,
      area: 'STRATEGY',
      itemKey: GOAL_ITEM_KEY,
      title,
      body,
      actor,
      policy: input.staleness,
      origin: 'SETUP',
    });
  }

  if (brand.primaryGoalKey !== goal) {
    await db.brand.update({ where: { id: brandId }, data: { primaryGoalKey: goal } });
    await writeAuditEvent(db, workspaceId, {
      action: 'brand.profile.updated',
      actorType: 'USER',
      actorId: actor.userId,
      resourceType: 'brand',
      resourceId: brandId,
      brandId,
      severity: 'NOTICE',
      before: { primaryGoalKey: brand.primaryGoalKey },
      after: { primaryGoalKey: goal },
    });
  }
}
