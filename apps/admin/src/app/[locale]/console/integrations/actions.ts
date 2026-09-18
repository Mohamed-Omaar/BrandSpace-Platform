'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  findIntegration,
  findIntegrationCategory,
  selectionRefusal,
  type IntegrationEnvironment,
} from '@brandspace/integrations';
import { AppError, createLogger, internalErrorFields, toPublicErrorCode } from '@brandspace/shared';
import { withSpan } from '@brandspace/observability';
import {
  currentEnvironment,
  getConfigService,
  getIntegrationsService,
  requirePlatformActor,
  serviceActor,
} from '../../../../server/platform-context';
import { integrationTester } from '../../../../server/integration-tester';

const log = createLogger({ context: { component: 'admin.integrations' } });

/**
 * Integrations server actions — Phase 10 §2, §3, §10.
 *
 * TWO KINDS OF ACTION, AND THEY ARE DELIBERATELY DIFFERENT SHAPES.
 *
 * TESTING is an observation. It writes an `integration_health_check` row and
 * changes nothing about what serves traffic, so it needs the configuration READ
 * authority and no more.
 *
 * ACTIVATING is a configuration change, and it goes through
 * `ConfigurationService` like every other one — draft, validate, activate —
 * rather than writing a provider key somewhere directly. That is not ceremony:
 * it is what gives an activation an author, a change reason, a validation pass,
 * an audit event, a version history and a rollback. A second write path would
 * have had none of those, and §3's requirement that integration changes obey
 * the existing Platform Admin security model would have been a comment rather
 * than a fact.
 *
 * NOTHING USER-SUPPLIED IS EVER REFLECTED BACK IN A URL. Failures redirect with
 * a stable CODE and a correlation id; the detail is logged once, redacted.
 */

function backTo(
  locale: string,
  category: string,
  providerKey: string,
  params: Record<string, string>,
): string {
  const query = new URLSearchParams(params).toString();
  return `/${locale}/console/integrations/${category}/${encodeURIComponent(providerKey)}${query ? `?${query}` : ''}`;
}

function failure(locale: string, category: string, providerKey: string, error: unknown): string {
  const correlationId = randomUUID();
  log.error('integration action failed', { correlationId, ...internalErrorFields(error) });
  return backTo(locale, category, providerKey, {
    error: toPublicErrorCode(error),
    ref: correlationId,
  });
}

/** Read the three fields every action needs, refusing anything unregistered. */
function target(formData: FormData): {
  locale: string;
  category: string;
  providerKey: string;
  environment: IntegrationEnvironment;
} {
  const locale = String(formData.get('locale') ?? 'ar');
  const category = String(formData.get('category') ?? '');
  const providerKey = String(formData.get('providerKey') ?? '');
  if (!findIntegration(category, providerKey)) {
    // Attacker-controllable input never reaches a lookup or a redirect.
    throw new AppError('NOT_FOUND', 'Unknown integration.');
  }
  return { locale, category, providerKey, environment: currentEnvironment() };
}

export async function testIntegrationAction(formData: FormData): Promise<void> {
  const { locale, category, providerKey, environment } = target(formData);
  let destination: string;
  try {
    const actor = await requirePlatformActor('platform.configuration.read');
    await withSpan(
      'integration.test',
      { 'integration.category': category, 'integration.provider': providerKey },
      async () =>
        getIntegrationsService().testConnection({
          actor: serviceActor(actor),
          category,
          providerKey,
          environment,
          tester: integrationTester(),
          requestedByPlatformUserId: actor.platformUserId,
        }),
    );
    destination = backTo(locale, category, providerKey, { ok: 'CONNECTION_TESTED' });
  } catch (error: unknown) {
    destination = failure(locale, category, providerKey, error);
  }
  revalidatePath(`/${locale}/console/integrations`);
  redirect(destination);
}

/**
 * Activate or disable a provider for this category and environment.
 *
 * ONE ACTION FOR BOTH, because they are the same configuration edit with a
 * different value, and two actions would be two places to forget the
 * development-only refusal below.
 */
export async function setIntegrationStateAction(formData: FormData): Promise<void> {
  const { locale, category, providerKey, environment } = target(formData);
  const enable = String(formData.get('enable') ?? '') === 'true';
  const reason = String(formData.get('reason') ?? '').trim();
  let destination: string;

  try {
    /*
     * THE ACTIVATE AUTHORITY, not the read one, and not the manage one either:
     * this changes what serves live traffic. `ConfigurationService.activate`
     * re-checks it, so this is a fast refusal rather than the only one.
     */
    const actor = await requirePlatformActor('platform.configuration.activate');
    const definition = findIntegration(category, providerKey);
    const categoryDefinition = findIntegrationCategory(category);
    /* c8 ignore next -- `target` already refused an unknown pair. */
    if (!definition || !categoryDefinition) throw new AppError('NOT_FOUND', 'Unknown integration.');

    if (enable) {
      const refusal = selectionRefusal(definition, environment);
      if (refusal) {
        /*
         * THE REFUSAL LIVES IN THE REGISTRY, not here. A development double
         * must be impossible to activate in production whichever screen or
         * script asks, so the rule is one function and this is one of its
         * callers.
         */
        throw new AppError('VALIDATION_FAILED', refusal);
      }
    }

    if (reason.length < 8) {
      throw new AppError(
        'VALIDATION_FAILED',
        'A change reason of at least eight characters is required.',
      );
    }

    await withSpan(
      'integration.state',
      {
        'integration.category': category,
        'integration.provider': providerKey,
        'integration.enable': enable,
      },
      async () => applyState({ actor, category, providerKey, environment, enable, reason }),
    );

    destination = backTo(locale, category, providerKey, {
      ok: enable ? 'INTEGRATION_ACTIVATED' : 'INTEGRATION_DISABLED',
    });
  } catch (error: unknown) {
    destination = failure(locale, category, providerKey, error);
  }
  revalidatePath(`/${locale}/console/integrations`);
  redirect(destination);
}

/**
 * Edit the category's configuration document and activate the result.
 *
 * DRAFT, THEN ACTIVATE — the same two steps the Configuration page performs,
 * because that is where validation, the impact preview, the audit event and the
 * version history live. The Hub is a friendlier door onto the same room, never
 * a second room.
 */
async function applyState(input: {
  actor: Awaited<ReturnType<typeof requirePlatformActor>>;
  category: string;
  providerKey: string;
  environment: IntegrationEnvironment;
  enable: boolean;
  reason: string;
}): Promise<void> {
  const configuration = getConfigService();
  const categoryDefinition = findIntegrationCategory(input.category);
  /* c8 ignore next -- checked by the caller. */
  if (!categoryDefinition) throw new AppError('NOT_FOUND', 'Unknown integration category.');

  const domain = categoryDefinition.configDomain as
    | 'ai.providers'
    | 'integrations.social-apps'
    | 'integrations.email'
    | 'integrations.storage'
    | 'integrations.payment'
    | 'integrations.observability';

  const active = (await configuration.get(domain, input.environment)) as Record<string, unknown>;
  const next = structuredClone(active) as Record<string, unknown>;
  const status = input.enable ? 'active' : 'disabled';

  if (domain === 'ai.providers') {
    const providers = (next['providers'] ?? []) as Record<string, unknown>[];
    const existing = providers.find((p) => p['key'] === input.providerKey);
    if (!existing) {
      throw new AppError(
        'VALIDATION_FAILED',
        'This provider has no record in ai.providers yet. Create it on the Configuration page first, ' +
          'where its base URL and eligibility gates are entered.',
      );
    }
    existing['status'] = status;
  } else if (domain === 'integrations.social-apps') {
    const applications = (next['applications'] ?? []) as Record<string, unknown>[];
    const existing = applications.find((a) => a['providerKey'] === input.providerKey);
    if (!existing) {
      throw new AppError(
        'VALIDATION_FAILED',
        'This platform has no registered application yet. Add it on the Configuration page first, ' +
          'where the app id, redirect URI and secret references are entered.',
      );
    }
    existing['status'] = status;
  } else {
    const providers = (next['providers'] ?? []) as Record<string, unknown>[];
    const existing = providers.find((p) => p['key'] === input.providerKey);
    if (existing) {
      existing['status'] = status;
    } else if (input.enable) {
      /*
       * A provider the registry knows about but the document has never
       * mentioned. Creating the record here is safe because the REGISTRY, not
       * the form, supplies the key and the name: nothing a caller typed becomes
       * a provider.
       */
      const definition = findIntegration(input.category, input.providerKey);
      /* c8 ignore next -- checked by the caller. */
      if (!definition) throw new AppError('NOT_FOUND', 'Unknown integration.');
      providers.push({
        key: definition.providerKey,
        name: definition.displayNameEn,
        status,
        settings: {},
        secretRefs: {},
      });
      next['providers'] = providers;
    }
    next['activeProviderKey'] = input.enable ? input.providerKey : null;
  }

  const draft = await configuration.createDraft(
    serviceActor(input.actor),
    domain,
    input.environment,
    input.reason,
    next,
  );
  await configuration.activate(serviceActor(input.actor), draft.id);
}
