'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { AppError, isAppError } from '@brandspace/shared';
import {
  AUTOMATION_RULE_NAME_TAKEN_REASON,
  AUTOMATION_RULE_VERSION_CONFLICT_REASON,
} from '@brandspace/automation';
import type { AutomationActionType, AutomationTrigger } from '@brandspace/database';
import { requireWorkspace } from '../../../server/customer-context';
import { inAnalytics, callPhase7Api } from '../../../server/analytics-context';
import {
  actionConfigFrom,
  conditionsFrom,
  triggerConfigFrom,
} from '../../../server/automation-form';

/**
 * Automation authoring actions.
 *
 * EVERY ACTION RE-CHECKS `automation.manage` INDEPENDENTLY, and the engine
 * re-checks the ACTION's own permission on top of it: holding
 * `automation.manage` is not a way to acquire `publishing.manage` by writing a
 * rule that uses it. The screen hiding a control is tidiness; these two checks
 * are the control.
 *
 * A NEW RULE IS CREATED DISABLED. Enabling is a second, deliberate act — and one
 * the engine gates on the action's permission separately — because a rule that
 * started running the moment it was saved would act before anybody had read it
 * back.
 *
 * CONFIRMING AN EXTERNAL ACTION GOES THROUGH `apps/api`, where the publish port
 * is wired. Nothing in the dashboard can publish.
 */

function codeFrom(error: unknown): string {
  if (
    isAppError(error) &&
    error.publicDetails['reason'] === AUTOMATION_RULE_VERSION_CONFLICT_REASON
  ) {
    return 'AUTOMATION_RULE_CHANGED';
  }
  if (isAppError(error) && error.publicDetails['reason'] === AUTOMATION_RULE_NAME_TAKEN_REASON) {
    return 'AUTOMATION_RULE_NAME_TAKEN';
  }
  return isAppError(error) ? error.code : 'INTERNAL';
}

export async function createAutomationAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const session = await requireWorkspace(locale, 'automation.manage');
  const brandId = String(formData.get('brandId') ?? '');
  const triggerType = String(formData.get('triggerType') ?? '');
  const actionType = String(formData.get('actionType') ?? '');

  try {
    /*
     * DECODED BEFORE THE ENGINE IS REACHED, AND INSIDE THE TRY (R5).
     *
     * Both decoders REFUSE rather than default, so they throw — and a throw
     * here has to land on the screen's error banner like any other refusal
     * rather than as an unhandled server-action rejection. Nothing is created
     * when either of them refuses: the engine is never called.
     */
    const triggerConfig = triggerConfigFrom(formData, triggerType);
    const conditions = conditionsFrom(formData);
    // Phase 2B-3 PR 2 — the person or campaign the action names, from its picker.
    const actionConfig = actionConfigFrom(formData, actionType);

    await inAnalytics(session.workspace.workspaceId, async (services) => {
      const engine = await services.automations();
      await engine.createRule({
        brandId,
        name: String(formData.get('name') ?? '').slice(0, 120),
        triggerType: triggerType as AutomationTrigger,
        triggerConfig,
        conditions: conditions as never,
        actionType: actionType as AutomationActionType,
        actionConfig,
        // DISABLED. Enabling is a separate, deliberate act.
        enabled: false,
        actor: {
          userId: session.customer.userId,
          roleKey: session.workspace.roleKey,
          permissionKeys: session.workspace.permissionKeys,
          brandScope: session.workspace.brandScope,
        },
      });
    });
  } catch (error: unknown) {
    redirect(`/${locale}/automations?error=${codeFrom(error)}`);
  }

  revalidatePath(`/${locale}/automations`);
  redirect(`/${locale}/automations?ok=AUTOMATION_CREATED`);
}

/**
 * B12 (Phase 2B-2b) — SAVE AN EDITED RULE.
 *
 * `updateEditableRule`, which never touches `enabled` and refuses a stale
 * version. The trigger and the action are the STORED ones — read here, never
 * taken from the form — so the settings are decoded for the trigger the rule
 * really has. Every decoder refuses rather than defaults (D-183): a blank
 * number is not zero, a missing condition field is not "no condition".
 *
 * TWO THINGS ARE LEFT EXACTLY AS THEY ARE unless the form really shows them:
 * conditions the one-condition control cannot display (`conditionsMode=keep`),
 * and action settings nobody can choose on this screen. `PLACE_ON_CALENDAR`'s
 * offset, and (Phase 2B-3 PR 2) the person `NOTIFY_PERSON` notifies and the
 * campaign `ADD_TO_CAMPAIGN` adds to, are settings a person chooses; the rest
 * of the stored action settings are carried over untouched.
 */
export async function updateAutomationAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const session = await requireWorkspace(locale, 'automation.manage');
  const ruleId = String(formData.get('ruleId') ?? '');

  try {
    await inAnalytics(session.workspace.workspaceId, async (services) => {
      const engine = await services.automations();
      const rule = await engine.getRule(ruleId, session.workspace.brandScope);
      const triggerConfig = triggerConfigFrom(formData, rule.triggerType);
      const conditions =
        formData.get('conditionsMode') === 'keep' ? undefined : conditionsFrom(formData);
      const actionConfig =
        rule.actionType === 'PLACE_ON_CALENDAR'
          ? {
              ...(rule.actionConfig as Record<string, unknown>),
              offsetHours: offsetHoursFrom(formData),
            }
          : rule.actionType === 'NOTIFY_PERSON' || rule.actionType === 'ADD_TO_CAMPAIGN'
            ? actionConfigFrom(formData, rule.actionType)
            : undefined;
      await engine.updateEditableRule({
        ruleId: rule.id,
        expectedVersion: Number(formData.get('version')),
        name: String(formData.get('name') ?? ''),
        description: String(formData.get('description') ?? ''),
        conditions,
        triggerConfig,
        actionConfig,
        actor: {
          userId: session.customer.userId,
          roleKey: session.workspace.roleKey,
          permissionKeys: session.workspace.permissionKeys,
          brandScope: session.workspace.brandScope,
        },
      });
    });
  } catch (error: unknown) {
    redirect(`/${locale}/automations?edit=${encodeURIComponent(ruleId)}&error=${codeFrom(error)}`);
  }

  revalidatePath(`/${locale}/automations`);
  redirect(`/${locale}/automations?ok=AUTOMATION_UPDATED`);
}

/** A whole number of hours, 0–720, or a refusal — never a default. */
function offsetHoursFrom(formData: FormData): number {
  const raw = String(formData.get('offsetHours') ?? '').trim();
  const value = raw === '' ? Number.NaN : Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 720) {
    throw new AppError('VALIDATION_FAILED', 'The offset must be a whole number of hours.');
  }
  return value;
}

/**
 * B12 (Phase 2B-2b) — SKIP an asks-first run.
 *
 * The engine applies the gate — the ACTION's own permission and the run's brand
 * against this person's live scope, the same checks Confirm makes — and records
 * a refusal on its own connection. This action only requires that the person
 * may see automations at all.
 */
export async function skipAutomationRunAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const session = await requireWorkspace(locale, 'automation.read');
  const runId = String(formData.get('runId') ?? '');

  try {
    await inAnalytics(session.workspace.workspaceId, async (services) => {
      const engine = await services.automations();
      await engine.skipRun({
        runId,
        actor: {
          userId: session.customer.userId,
          roleKey: session.workspace.roleKey,
          permissionKeys: session.workspace.permissionKeys,
          brandScope: session.workspace.brandScope,
        },
      });
    });
  } catch (error: unknown) {
    redirect(`/${locale}/automations?error=${codeFrom(error)}`);
  }

  revalidatePath(`/${locale}/automations`);
  redirect(`/${locale}/automations?ok=AUTOMATION_SKIPPED`);
}

export async function toggleAutomationAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const session = await requireWorkspace(locale, 'automation.manage');
  const ruleId = String(formData.get('ruleId') ?? '');
  const enabled = formData.get('enabled') === '1';

  try {
    await inAnalytics(session.workspace.workspaceId, async (services) => {
      const engine = await services.automations();
      await engine.updateRule({
        ruleId,
        enabled,
        actor: {
          userId: session.customer.userId,
          roleKey: session.workspace.roleKey,
          permissionKeys: session.workspace.permissionKeys,
          brandScope: session.workspace.brandScope,
        },
      });
    });
  } catch (error: unknown) {
    redirect(`/${locale}/automations?error=${codeFrom(error)}`);
  }

  revalidatePath(`/${locale}/automations`);
  redirect(`/${locale}/automations?ok=AUTOMATION_UPDATED`);
}

export async function deleteAutomationAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const session = await requireWorkspace(locale, 'automation.manage');
  const ruleId = String(formData.get('ruleId') ?? '');

  try {
    await inAnalytics(session.workspace.workspaceId, async (services) => {
      const engine = await services.automations();
      await engine.deleteRule({
        ruleId,
        actor: {
          userId: session.customer.userId,
          roleKey: session.workspace.roleKey,
          permissionKeys: session.workspace.permissionKeys,
          brandScope: session.workspace.brandScope,
        },
      });
    });
  } catch (error: unknown) {
    redirect(`/${locale}/automations?error=${codeFrom(error)}`);
  }

  revalidatePath(`/${locale}/automations`);
  redirect(`/${locale}/automations?ok=AUTOMATION_DELETED`);
}

/**
 * Confirm an automation's proposed external action.
 *
 * THE TOKEN IS FETCHED HERE, SERVER-SIDE, AND NEVER REACHES THE BROWSER.
 *
 * It used to be read off the submitted form, under a comment saying it "arrives
 * from the run's notification link". It did not, and it could not: the token is
 * minted in the worker, stored only as a hash, and the notification carries no
 * payload by design. Nothing anywhere held the raw value, so this action posted
 * an empty string and every confirmation was refused — and there was no button
 * that called it either.
 *
 * TWO CALLS, ONE PERSON, CHECKED TWICE. The first asks the API to issue a
 * credential for this run; the second spends it. Both carry this person's own
 * session, and the engine re-checks `publishing.manage` and the run's brand
 * against their LIVE membership on each — so the round trip is not ceremony, it
 * is the confirmation boundary being crossed by somebody who may cross it.
 *
 * `publishing.manage` IS CHECKED HERE AND AGAIN IN THE ENGINE, against the
 * CONFIRMER rather than the rule's creator — otherwise a rule written by an admin
 * would let anyone holding the link authorize a publish.
 */
export async function confirmAutomationRunAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  await requireWorkspace(locale, 'publishing.manage');
  const runId = String(formData.get('runId') ?? '');

  const issued = await callPhase7Api('/v1/automations/confirmation-token', { runId });
  if (!issued.ok) {
    const payload = issued.payload as { error?: { code?: string } };
    redirect(`/${locale}/automations?error=${payload.error?.code ?? 'INTERNAL'}`);
  }

  const response = await callPhase7Api('/v1/automations/confirm', {
    runId,
    token: (issued.payload as { token?: string }).token ?? '',
  });
  if (!response.ok) {
    const payload = response.payload as { error?: { code?: string } };
    redirect(`/${locale}/automations?error=${payload.error?.code ?? 'INTERNAL'}`);
  }

  revalidatePath(`/${locale}/automations`);
  redirect(`/${locale}/automations?ok=AUTOMATION_CONFIRMED`);
}
