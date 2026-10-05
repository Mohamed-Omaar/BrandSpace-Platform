'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect, unstable_rethrow } from 'next/navigation';
import { TEMPLATES_MANAGE_PERMISSION } from '@brandspace/content';
import { createLogger, internalErrorFields } from '@brandspace/shared';
import { requireWorkspaceAction } from '../../../../server/customer-context';
import { inContentStudio } from '../../../../server/content-context';
import { actionErrorCode } from '../../../../server/denial';
import { savePublishingDefaults } from '../../../../server/publishing-defaults';
import { templateFieldsFrom } from '../../../../server/template-form';

const log = createLogger({ context: { component: 'dashboard.publishing-defaults' } });

/**
 * SETTINGS → PUBLISHING DEFAULTS (A8 / A10 / B2, Phase 2B-2).
 *
 * The defaults need `brand.manage` (the tab's key); every template action
 * needs `templates.manage` as well, and the template service checks it again.
 * BrandScope, the channel list and the audit events are the services'.
 */

const PAGE = '/settings/publishing';

function done(locale: string, ok: string): string {
  return `/${locale}${PAGE}?ok=${ok}`;
}

function failed(locale: string, error: unknown, what: string): string {
  unstable_rethrow(error);
  const correlationId = randomUUID();
  log.warn(`${what} failed`, { correlationId, ...internalErrorFields(error) });
  return `/${locale}${PAGE}?error=${actionErrorCode(error)}&ref=${correlationId}`;
}

function chosenPostTime(formData: FormData): string {
  const choice = formData.get('defaultPostTimeChoice');
  if (choice === null || String(choice) === 'other') {
    return String(formData.get('defaultPostTime') ?? '');
  }
  return String(choice);
}

export async function savePublishingDefaultsAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;
  try {
    const session = await requireWorkspaceAction(locale, 'brand.manage');
    await inContentStudio(session.workspace.workspaceId, async (services) => {
      const policy = await services.policy();
      await savePublishingDefaults(
        services.db,
        {
          workspaceId: session.workspace.workspaceId,
          actorUserId: session.customer.userId,
          brandScope: session.workspace.brandScope,
          knownPlatformKeys: policy.platforms.map((platform) => platform.key),
        },
        {
          brandId: String(formData.get('brandId') ?? ''),
          platformKeys: formData.getAll('platformKeys').map((value) => String(value)),
          /*
           * Round 4, Gate 2b — the prototype's time choices: a suggested time
           * chosen as a radio, or "Other" and the time field. The same one
           * value reaches the same service; an empty one is "no default".
           */
          defaultPostTime: chosenPostTime(formData),
          hashtagsInFirstComment: formData.get('hashtagsInFirstComment') === 'on',
        },
      );
    });
    destination = done(locale, 'SETTINGS_SAVED');
  } catch (error: unknown) {
    destination = failed(locale, error, 'publishing defaults save');
  }
  revalidatePath(`/${locale}${PAGE}`);
  redirect(destination);
}

/** New template, or a change to one (`templateId` present). */
export async function saveTemplateAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;
  try {
    const session = await requireWorkspaceAction(locale, TEMPLATES_MANAGE_PERMISSION);
    const templateId = String(formData.get('templateId') ?? '');
    const expected = Number(formData.get('expectedVersion') ?? '');
    const fields = templateFieldsFrom(formData);
    const actor = {
      userId: session.customer.userId,
      brandScope: session.workspace.brandScope,
      permissionKeys: session.workspace.permissionKeys,
    };
    await inContentStudio(session.workspace.workspaceId, async (services) => {
      const templates = await services.templates();
      if (templateId) {
        await templates.update({
          templateId,
          ...(Number.isInteger(expected) && expected > 0 ? { expectedVersion: expected } : {}),
          fields,
          actor,
        });
      } else {
        await templates.create({
          brandId: String(formData.get('brandId') ?? ''),
          fields,
          isDefault: formData.get('isDefault') === 'on',
          actor,
        });
      }
    });
    destination = done(locale, 'TEMPLATE_SAVED');
  } catch (error: unknown) {
    destination = failed(locale, error, 'template save');
  }
  revalidatePath(`/${locale}${PAGE}`);
  redirect(destination);
}

export async function deleteTemplateAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;
  try {
    const session = await requireWorkspaceAction(locale, TEMPLATES_MANAGE_PERMISSION);
    await inContentStudio(session.workspace.workspaceId, async (services) =>
      (await services.templates()).remove({
        templateId: String(formData.get('templateId') ?? ''),
        actor: {
          userId: session.customer.userId,
          brandScope: session.workspace.brandScope,
          permissionKeys: session.workspace.permissionKeys,
        },
      }),
    );
    destination = done(locale, 'TEMPLATE_DELETED');
  } catch (error: unknown) {
    destination = failed(locale, error, 'template delete');
  }
  revalidatePath(`/${locale}${PAGE}`);
  redirect(destination);
}

/** Make one template the brand's default, or clear it (`templateId` empty). */
export async function setDefaultTemplateAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;
  try {
    const session = await requireWorkspaceAction(locale, TEMPLATES_MANAGE_PERMISSION);
    const templateId = String(formData.get('templateId') ?? '');
    await inContentStudio(session.workspace.workspaceId, async (services) =>
      (await services.templates()).setDefault({
        brandId: String(formData.get('brandId') ?? ''),
        templateId: templateId === '' ? null : templateId,
        actor: {
          userId: session.customer.userId,
          brandScope: session.workspace.brandScope,
          permissionKeys: session.workspace.permissionKeys,
        },
      }),
    );
    destination = done(locale, 'TEMPLATE_DEFAULT_CHANGED');
  } catch (error: unknown) {
    destination = failed(locale, error, 'template default');
  }
  revalidatePath(`/${locale}${PAGE}`);
  redirect(destination);
}
