'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { isAppError } from '@brandspace/shared';
import type { AutomationActionType, AutomationTrigger } from '@brandspace/database';
import { requireWorkspace } from '../../../server/customer-context';
import { inAnalytics, callPhase7Api } from '../../../server/analytics-context';
import { conditionsFrom, triggerConfigFrom } from '../../../server/automation-form';

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
  return isAppError(error) ? error.code : 'INTERNAL';
}

export async function createAutomationAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const session = await requireWorkspace(locale, 'automation.manage');
  const brandId = String(formData.get('brandId') ?? '');
  const triggerType = String(formData.get('triggerType') ?? '');

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

    await inAnalytics(session.workspace.workspaceId, async (services) => {
      const engine = await services.automations();
      await engine.createRule({
        brandId,
        name: String(formData.get('name') ?? '').slice(0, 120),
        triggerType: triggerType as AutomationTrigger,
        triggerConfig,
        conditions: conditions as never,
        actionType: String(formData.get('actionType') ?? '') as AutomationActionType,
        // `NOTIFY` is the only action with a required parameter, and its value is
        // a template key from the closed catalogue rather than customer text.
        actionConfig:
          formData.get('actionType') === 'NOTIFY'
            ? { templateKey: 'automation.confirmation_required' }
            : formData.get('actionType') === 'PLACE_ON_CALENDAR'
              ? { offsetHours: 24 }
              : {},
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
