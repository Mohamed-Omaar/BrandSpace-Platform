'use server';

import { randomUUID } from 'node:crypto';
import { aiAdapterRegistry } from '@brandspace/ai-gateway/adapters';
import { asPlatform } from '@brandspace/database';
import { createLogger, currentEnvironment, internalErrorFields } from '@brandspace/shared';
import {
  getConfigService,
  getSecretService,
  requirePlatformActor,
} from '../../../../server/platform-context';
import {
  COMPARE_BRIEF_MAX,
  compareImageModels,
  comparisonAuditReason,
  type CompareModelRow,
  type CompareProviderRow,
} from '../../../../server/image-compare';
import { COMPARE_FORMATS, type CompareState } from './shared';

const log = createLogger({ context: { component: 'admin.ai-compare' } });

/**
 * PR G (D-611) — run one brief on two image models. The Platform Owner only
 * (`platform.user.manage`, held by that role alone, and the role itself is
 * checked). Each run is audited (`platform.ai.image_comparison`) with the
 * models, time and cost — never the brief or the images.
 */
export async function compareImagesAction(
  _previous: CompareState,
  formData: FormData,
): Promise<CompareState> {
  const actor = await requirePlatformActor('platform.user.manage').catch(() => null);
  if (!actor || actor.roleKey !== 'platform_owner') return { error: 'FORBIDDEN' };

  const brief = String(formData.get('brief') ?? '').trim();
  const format = String(formData.get('format') ?? '');
  const quality = String(formData.get('quality') ?? '');
  const modelA = String(formData.get('modelA') ?? '');
  const modelB = String(formData.get('modelB') ?? '');
  if (brief.length === 0 || brief.length > COMPARE_BRIEF_MAX) return { error: 'BRIEF' };
  if (!COMPARE_FORMATS.includes(format)) return { error: 'INVALID' };
  if (quality !== 'low' && quality !== 'medium' && quality !== 'high') return { error: 'INVALID' };
  if (!modelA || !modelB) return { error: 'INVALID' };

  const environment = currentEnvironment();
  const config = getConfigService();
  const [models, providers] = await Promise.all([
    config.get('ai.models', environment),
    config.get('ai.providers', environment),
  ]);
  const requestId = randomUUID();
  try {
    const sides = await compareImageModels(
      { brief, format, quality, modelKeys: [modelA, modelB] },
      {
        environment,
        models: models.models as unknown as readonly CompareModelRow[],
        providers: providers.providers as unknown as readonly CompareProviderRow[],
        allowedHosts: providers.allowedHosts ?? [],
        registry: aiAdapterRegistry(environment),
        resolveKey: (ref) => getSecretService().resolveSecret(ref, environment),
        requestId,
      },
    );
    await asPlatform(
      {
        platformUserId: actor.platformUserId,
        roleKey: actor.roleKey,
        mfaVerified: actor.mfaVerified,
      },
      {
        action: 'platform.ai.image_comparison',
        reason: comparisonAuditReason({ format, quality }, sides),
        requestId,
        resourceType: 'AiModel',
      },
      async () => undefined,
    );
    return {
      format,
      quality,
      sides: sides.map((side) => ({
        ...side,
        costMicroMinor: side.costMicroMinor === null ? null : side.costMicroMinor.toString(),
      })),
    };
  } catch (error: unknown) {
    log.warn('image comparison failed', { requestId, ...internalErrorFields(error) });
    return { error: 'FAILED' };
  }
}
