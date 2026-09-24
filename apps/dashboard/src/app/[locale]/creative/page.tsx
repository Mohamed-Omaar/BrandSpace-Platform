import { StateMessage } from '@brandspace/ui';
import { CREATIVE_FORMATS } from '@brandspace/creative';
import '@brandspace/ui/content-studio.css';
import { requireWorkspace } from '../../../server/customer-context';
import { brandContextFor, requiredBrand } from '../../../server/brand-context';
import { translator, type MessageKey } from '../../../i18n/messages';
import { WorkspaceShell } from '../../../components/workspace-shell';
import { CreativeStudioView, type CreativeStudioLabels } from './creative-studio-view';

import { EmptyAction } from '../../../components/empty-action';

export const dynamic = 'force-dynamic';

/**
 * THE AI CREATIVE STUDIO (D-195, AC-28).
 *
 * BRAND-SCOPED, AND IT ASKS RATHER THAN GUESSING (D-191). An image is generated
 * on ONE brand's identity — its palette, its description, its approved
 * knowledge — so a studio that picked a brand for the author would produce
 * something that looks like a brand they did not choose.
 *
 * THE SCREEN IS BUILT FROM THE DESIGN SYSTEM, NOT DRAWN (CLAUDE.md §4.2). The
 * approved demo carries a `DesignStudio` shell for a canvas editor, which this
 * is not: this is a brief, a format and a result. So it composes `Card`,
 * `Field` and the existing control tokens, the same way the Brand Profile
 * screen does, and introduces no new visual language.
 *
 * `assets.upload` GATES IT, matching the API route exactly, because a
 * generation writes a file into the library. A member who may only read the
 * library sees no entry and gets a 404 if they type the path.
 */
const FORMAT_KEYS: Readonly<Record<string, MessageKey>> = {
  square: 'creative.format.square',
  portrait: 'creative.format.portrait',
  story: 'creative.format.story',
  landscape: 'creative.format.landscape',
};

export default async function CreativeStudioPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const t = translator(locale);
  const { customer, workspace } = await requireWorkspace(locale, 'assets.upload');

  const single = (key: string): string | undefined => {
    const value = query[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  };

  const brandContext = await brandContextFor(workspace, '/creative', single('brand'));
  const brand = requiredBrand(brandContext);

  const labels: CreativeStudioLabels = {
    brief: t('creative.brief'),
    briefHint: t('creative.briefHint'),
    briefPlaceholder: t('creative.briefPlaceholder'),
    format: t('creative.format'),
    formatHint: t('creative.formatHint'),
    generate: t('creative.generate'),
    generating: t('creative.generating'),
    cost: t('creative.cost'),
    costUnit: t('creative.costUnit'),
    result: t('creative.result'),
    resultEmpty: t('creative.resultEmpty'),
    saved: t('creative.saved'),
    openInLibrary: t('creative.openInLibrary'),
    useInContent: t('creative.useInContent'),
    regenerate: t('creative.regenerate'),
    adapt: t('creative.adapt'),
    adaptHint: t('creative.adaptHint'),
    noLogoNotice: t('creative.noLogoNotice'),
    generatedBadge: t('creative.generatedBadge'),
    scanning: t('creative.scanning'),
    failed: t('creative.failed'),
    insufficientCredits: t('creative.insufficientCredits'),
  };

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      heading={t('creative.title')}
      description={t('creative.subtitle')}
      activePath="/creative"
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      {brand === null ? (
        <StateMessage
          kind="empty"
          title={
            brandContext.resolution.kind === 'empty'
              ? t('brand.emptyTitle')
              : t('creative.noBrandTitle')
          }
          description={
            brandContext.resolution.kind === 'empty'
              ? t('brand.emptyBody')
              : t('creative.noBrandBody')
          }
          testId="creative-no-brand"
          action={
            brandContext.resolution.kind === 'empty' &&
            workspace.permissionKeys.includes('brand.manage') ? (
              <EmptyAction
                href={`/${locale}/brand-brain`}
                label={t('bb.createBrand')}
                testId="no-brand-create"
              />
            ) : undefined
          }
        />
      ) : (
        <CreativeStudioView
          locale={locale}
          brandId={brand.id}
          formats={CREATIVE_FORMATS.map((format) => ({
            key: format.key,
            label: t(FORMAT_KEYS[format.key] ?? 'creative.format.square'),
            size: format.size,
            aspect: format.aspect,
          }))}
          labels={labels}
          initialResult={null}
        />
      )}
    </WorkspaceShell>
  );
}
