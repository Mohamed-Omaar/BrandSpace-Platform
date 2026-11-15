import { notFound } from 'next/navigation';
import { PageIntro } from '../../../../components/admin-shell';
import {
  currentEnvironment,
  getConfigService,
  requirePageActor,
} from '../../../../server/platform-context';
import { CompareForm } from './compare-form';

export const dynamic = 'force-dynamic';

/**
 * PR G (D-611) — THE IMAGE COMPARISON BENCH, for the Platform Owner only.
 * The same brief on two image models side by side: time, cost, images.
 * Changes nothing about routing; nothing is stored but the audit row.
 */
export default async function AiComparePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const actor = await requirePageActor(locale, 'platform.user.manage');
  if (actor.roleKey !== 'platform_owner') notFound();
  const isArabic = locale === 'ar';
  const environment = currentEnvironment();
  const config = getConfigService();
  const [models, providers] = await Promise.all([
    config.get('ai.models', environment),
    config.get('ai.providers', environment),
  ]);
  const adapterOf = new Map(
    providers.providers.map((provider) => [provider.key, provider.adapter ?? provider.key]),
  );
  const imageModels = models.models
    .filter((model) => model.modality === 'image')
    .map((model) => ({
      key: model.key,
      label: `${model.displayName ?? model.key} · ${model.providerKey}`,
      adapter: adapterOf.get(model.providerKey) ?? model.providerKey,
    }));
  // One of each provider when both exist (gpt-image-2 against Gemini), else the first two.
  const first = imageModels[0]?.key ?? '';
  const other =
    imageModels.find((model) => model.adapter !== imageModels[0]?.adapter)?.key ??
    imageModels[1]?.key ??
    first;

  return (
    <>
      <PageIntro
        description={
          isArabic
            ? 'الطلب نفسه على نموذجَي صور جنبًا إلى جنب: الوقت والتكلفة والصورة. لا يغيّر التوجيه، ولا يُحفظ شيء سوى سجل التدقيق (النماذج والوقت والتكلفة، دون الطلب أو الصور).'
            : 'The same brief on two image models side by side: time, cost and the image. It changes no routing, and nothing is kept but the audit row (models, time and cost — never the brief or the images).'
        }
      />
      <CompareForm
        locale={locale}
        models={imageModels.map(({ key, label }) => ({ key, label }))}
        defaults={{ modelA: first, modelB: other }}
      />
    </>
  );
}
