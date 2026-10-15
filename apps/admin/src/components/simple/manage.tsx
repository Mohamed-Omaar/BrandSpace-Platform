import type { AuthenticatedPlatformActor } from '@brandspace/auth';
import { Card, ContentGrid, colorTokens, spacingTokens, typographyTokens } from '@brandspace/ui';
import { areaCopy, type AreaCopyKey } from '../../i18n/simple-areas';
import { AREAS } from '../../server/simple-areas/registry';
import { ActionLink, SimpleSection } from '../simple-ui';

/**
 * "MANAGE YOUR PLATFORM" — one card per Simple area, plus Features, AI, the
 * team and the change history: the owner's everyday control panel (owner
 * decision, Control Center Simple mode). A card is listed only when the
 * reader may open the page behind it; the page checks again (D-307).
 */

interface Entry {
  readonly key: string;
  readonly title: AreaCopyKey;
  readonly intro: AreaCopyKey;
  readonly href: string;
  readonly permission: string;
}

export function manageEntries(locale: string): readonly Entry[] {
  return [
    ...AREAS.map((area) => ({ key: area.key, title: area.title, intro: area.intro, href: area.href(locale), permission: 'platform.configuration.read' })),
    { key: 'features', title: 'mg.features', intro: 'mg.features.intro', href: `/${locale}/console/features`, permission: 'platform.configuration.read' },
    { key: 'ai', title: 'mg.ai', intro: 'mg.ai.intro', href: `/${locale}/console/ai`, permission: 'platform.configuration.read' },
    { key: 'team', title: 'mg.team', intro: 'mg.team.intro', href: `/${locale}/console/team`, permission: 'platform.user.read' },
    { key: 'changes', title: 'mg.changes', intro: 'mg.changes.intro', href: `/${locale}/console/changes`, permission: 'platform.audit.read' },
  ];
}

export function ManageGrid({ locale, actor }: { readonly locale: string; readonly actor: AuthenticatedPlatformActor }) {
  const t = areaCopy(locale);
  const entries = manageEntries(locale).filter((entry) => actor.permissionKeys.includes(entry.permission));
  if (entries.length === 0) return null;
  return (
    <SimpleSection title={t('ui.manageTitle')} description={t('ui.manageIntro')} testId="manage-grid">
      <ContentGrid min="15rem">
        {entries.map((entry) => (
          <Card key={entry.key} testId={`manage-${entry.key}`}>
            <div style={{ display: 'grid', gap: spacingTokens.xs, alignContent: 'start', blockSize: '100%' }}>
              <h3 style={{ margin: 0, ...typographyTokens.h3 }}>{t(entry.title)}</h3>
              <p style={{ margin: 0, ...typographyTokens.caption, color: colorTokens.textSecondary }}>{t(entry.intro)}</p>
              <div style={{ marginBlockStart: 'auto' }}>
                <ActionLink href={entry.href} testId={`manage-${entry.key}-open`}>
                  {t('a.open')}
                </ActionLink>
              </div>
            </div>
          </Card>
        ))}
      </ContentGrid>
    </SimpleSection>
  );
}
