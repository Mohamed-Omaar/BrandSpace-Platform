import type { AutomationRule, Prisma } from '@prisma/client';
import type { TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import {
  conditionsSchema,
  findAction,
  findTrigger,
  parseAutomationPolicy,
} from '@brandspace/automation';

/**
 * PHASE 2B-3 PR 2 — A RULE AS IT IS STORED, WITHOUT THE AUTHORING DOOR.
 *
 * `createRule` asks whether a NEW rule may be written on this trigger and
 * action. After the G13 flip most of the pairs these suites exercise are no
 * longer authorable — and every rule already stored on them keeps running. So a
 * test about how a STORED rule behaves seeds it here, in the tenant's own
 * transaction (RLS applies), shaped exactly as `createRule` would have stored
 * it: the trigger's and the action's config schemas parse the settings, the
 * conditions schema parses the conditions, the daily ceiling is the
 * configured default and confirmation is required.
 *
 * It never decides authorability, and a test about authoring still goes
 * through `createRule`.
 */
const DEFAULT_MAX_RUNS_PER_DAY = parseAutomationPolicy(defaultPayload('automations')).limits
  .maxRunsPerRulePerDay;

export async function seedStoredRule(
  db: TenantScopedClient,
  input: {
    readonly workspaceId: string;
    readonly brandId: string;
    readonly name: string;
    readonly triggerType: string;
    readonly triggerConfig?: unknown;
    readonly conditions?: unknown;
    readonly actionType: string;
    readonly actionConfig?: unknown;
    readonly createdByUserId: string;
    readonly enabled?: boolean;
    readonly description?: string | null;
    readonly maxRunsPerDay?: number;
    readonly armedAt?: Date | null;
  },
): Promise<AutomationRule> {
  const trigger = findTrigger(input.triggerType);
  const action = findAction(input.actionType);
  if (!trigger) throw new Error(`seedStoredRule: unknown trigger ${input.triggerType}`);
  if (!action) throw new Error(`seedStoredRule: unknown action ${input.actionType}`);
  return db.automationRule.create({
    data: {
      workspaceId: input.workspaceId,
      brandId: input.brandId,
      name: input.name,
      description: input.description ?? null,
      enabled: input.enabled ?? false,
      triggerType: trigger.type,
      triggerConfig: trigger.config.parse(input.triggerConfig ?? {}) as Prisma.InputJsonValue,
      conditions: conditionsSchema.parse(input.conditions ?? []) as Prisma.InputJsonValue,
      actionType: action.type,
      actionConfig: action.config.parse(input.actionConfig ?? {}) as Prisma.InputJsonValue,
      maxRunsPerDay: input.maxRunsPerDay ?? DEFAULT_MAX_RUNS_PER_DAY,
      requiresConfirmationForExternal: true,
      createdByUserId: input.createdByUserId,
      armedAt: input.armedAt ?? null,
    },
  });
}
