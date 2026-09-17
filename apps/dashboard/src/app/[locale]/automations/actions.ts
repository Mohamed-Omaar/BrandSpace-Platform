'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { isAppError } from '@brandspace/shared';
import type { AutomationActionType, AutomationTrigger } from '@brandspace/database';
import { CONDITION_FIELD_CONTRACTS, type ConditionField } from '@brandspace/automation';
import { requireWorkspace } from '../../../server/customer-context';
import { inAnalytics, callPhase7Api } from '../../../server/analytics-context';

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

/**
 * THE TRIGGER'S OWN CONFIGURATION, READ FROM THE FORM THE CUSTOMER FILLED IN.
 *
 * IT USED TO BE `{}` — ALWAYS (R3-1). So a scheduled rule carried no hour and a
 * threshold rule carried no metric, no direction and no number, and
 * `createRule` refused both with a validation error naming fields the screen had
 * never rendered. Two of the six authorable triggers could not, in fact, be
 * authored.
 *
 * THE SHAPES ARE THE ENGINE'S. Parsing happens in `createRule` against the
 * registry's own Zod schema; this only reads the named inputs the form posts, so
 * there is still no path from a text box to behaviour.
 */
function triggerConfigFrom(formData: FormData, triggerType: string): Record<string, unknown> {
  if (triggerType === 'SCHEDULED_TIME') {
    return {
      hourLocal: Number(formData.get('hourLocal') ?? 0),
      // EMPTY MEANS EVERY DAY, which is what an untouched set of checkboxes
      // means to the person who left them alone.
      daysOfWeek: formData.getAll('daysOfWeek').map((day) => Number(day)),
    };
  }
  if (triggerType === 'METRIC_THRESHOLD_CROSSED') {
    return {
      metricKey: String(formData.get('metricKey') ?? ''),
      direction: String(formData.get('direction') ?? 'above'),
      threshold: Number(formData.get('threshold') ?? Number.NaN),
      windowDays: Number(formData.get('windowDays') ?? 7),
    };
  }
  return {};
}

/**
 * The one optional condition the authoring screen offers.
 *
 * IT USED TO BE `[]` UNCONDITIONALLY, so the condition half of the engine was
 * unreachable from the product. The field list the form offers is derived from
 * `CONDITION_FIELD_TRIGGERS`, so a customer can only choose something the
 * runtime actually produces for the trigger they picked.
 *
 * AND THE VALUE USED TO BE GUESSED (R4-1). Whatever was typed became a number
 * if it parsed as one and a string otherwise — so `content.hasCampaign equals`
 * posted the STRING `"true"` against a real boolean fact, and `in` posted a
 * lone string where the engine requires `string[]`. Both stored a rule that
 * looked configured and could never match.
 *
 * THE KIND NOW COMES FROM THE SAME CONTRACT THE FORM RENDERED AND THE ENGINE
 * REFUSES AGAINST — `CONDITION_FIELD_CONTRACTS` — so the three cannot disagree.
 * This is still not the check: `createRule` and `updateRule` validate the
 * field, the operator and the value kind independently, because a server that
 * trusts a form is a server with no validation.
 */
function conditionsFrom(formData: FormData): readonly Record<string, unknown>[] {
  const field = String(formData.get('conditionField') ?? '');
  if (!field) return [];
  const contract = CONDITION_FIELD_CONTRACTS[field as ConditionField];
  // An unknown field is dropped rather than forwarded: the engine would refuse
  // it, and forwarding it would turn a tampered form into an error banner about
  // a field nobody chose.
  if (!contract) return [];

  const operator = String(formData.get('conditionOperator') ?? '');
  // THESE TAKE NO VALUE AT ALL, and sending one would be a rule whose text says
  // one thing and whose behaviour does another.
  if (operator === 'is_true' || operator === 'is_false') return [{ field, operator }];

  if (operator === 'in' || operator === 'not_in') {
    /*
     * A REAL `string[]`. A `<select multiple>` posts one entry per choice; a
     * free-text field (a pillar has no enum to close it against) posts one
     * entry the customer separated with commas. Both end up here as the same
     * de-duplicated list, and an empty one is refused by the engine rather
     * than stored as a condition that is false for ever.
     */
    const members = formData
      .getAll('conditionValue')
      .flatMap((entry) => String(entry).split(','))
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
    return [{ field, operator, value: [...new Set(members)] }];
  }

  const raw = String(formData.get('conditionValue') ?? '').trim();
  if (contract.kind === 'number') return [{ field, operator, value: Number(raw) }];
  return [{ field, operator, value: raw }];
}

export async function createAutomationAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const session = await requireWorkspace(locale, 'automation.manage');
  const brandId = String(formData.get('brandId') ?? '');
  const triggerType = String(formData.get('triggerType') ?? '');

  try {
    await inAnalytics(session.workspace.workspaceId, async (services) => {
      const engine = await services.automations();
      await engine.createRule({
        brandId,
        name: String(formData.get('name') ?? '').slice(0, 120),
        triggerType: triggerType as AutomationTrigger,
        triggerConfig: triggerConfigFrom(formData, triggerType),
        conditions: conditionsFrom(formData) as never,
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
