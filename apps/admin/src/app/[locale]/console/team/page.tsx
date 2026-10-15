import { Card, ContentGrid, StatusBadge, colorTokens, spacingTokens, typographyTokens } from '@brandspace/ui';
import { areaCopy } from '../../../../i18n/simple-areas';
import { formatWhen } from '../../../../components/simple-ui';
import { getPlatformPrisma, requirePageActor } from '../../../../server/platform-context';

export const dynamic = 'force-dynamic';

/**
 * /team — who can sign in to the Control Center, as cards (owner decision,
 * Control Center Simple mode). READ-ONLY: adding, removing or changing a
 * person's role is `platform.user.manage`, which this page does not offer; it
 * says so. No secret, hash or MFA material is read — only whether MFA is set.
 */
export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  await requirePageActor(locale, 'platform.user.read');
  const t = areaCopy(locale);
  const users = await getPlatformPrisma().platformUser.findMany({
    orderBy: [{ createdAt: 'asc' }],
    select: {
      id: true,
      email: true,
      name: true,
      status: true,
      mfaEnabled: true,
      lastLoginAt: true,
      role: { select: { nameEn: true, nameAr: true } },
    },
    take: 200,
  });
  return (
    <div style={{ display: 'grid', gap: spacingTokens.md }}>
      <p style={{ margin: 0, ...typographyTokens.bodySm, color: colorTokens.textSecondary, maxInlineSize: '68ch' }} data-testid="team-intro">
        {t('tm.intro')}
      </p>
      <ContentGrid min="16rem" testId="team-cards">
        {users.map((user) => (
          <Card key={user.id} testId="team-card">
            <div style={{ display: 'grid', gap: spacingTokens.xs }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens.xs, justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0, ...typographyTokens.h3 }}>{user.name ?? user.email}</h3>
                <StatusBadge label={user.status === 'ACTIVE' ? t('tm.active') : t('tm.inactive')} tone={user.status === 'ACTIVE' ? 'success' : 'neutral'} dot />
              </div>
              <span dir="ltr" style={{ ...typographyTokens.caption, color: colorTokens.textMuted, textAlign: 'start' }}>
                {user.email}
              </span>
              <span style={{ ...typographyTokens.bodySm }}>
                {t('tm.role')}: {locale === 'ar' ? user.role.nameAr : user.role.nameEn}
              </span>
              <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
                {t('tm.mfa')}: {t(user.mfaEnabled ? 'w.yes' : 'w.no')}
              </span>
              <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
                {t('tm.lastSignIn')}: {user.lastLoginAt ? formatWhen(locale, user.lastLoginAt) : t('tm.never')}
              </span>
            </div>
          </Card>
        ))}
      </ContentGrid>
    </div>
  );
}
