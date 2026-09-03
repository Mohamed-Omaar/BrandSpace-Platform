import Link from 'next/link';
import { colorTokens, spacingTokens } from '@brandspace/ui';
import {
  getEntitlementService,
  getWorkspaceService,
  requirePageActor,
  serviceActor,
} from '../../../../server/platform-context';
import { translator } from '../../../../i18n/messages';
import { errorMessage, successMessage } from '../../../../i18n/status-messages';
import {
  Banner,
  Card,
  EmptyState,
  Field,
  StatusPill,
  TableScroll,
  inputStyle,
  primaryButtonStyle,
  tableStyle,
  tdStyle,
  thStyle,
} from '../../../../components/console-ui';
import { createWorkspaceAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * Customers and workspaces — the directory.
 *
 * Real rows from the database. Where later-phase data does not exist yet (MRR,
 * connected accounts, health score) the column is simply absent rather than
 * filled with a plausible-looking zero: a fabricated number in an admin console
 * is worse than a missing one, because somebody will act on it.
 */
export default async function WorkspacesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const actor = await requirePageActor(locale, 'platform.workspace.read');
  const t = translator(locale);

  const service = getWorkspaceService();
  const search = typeof query['q'] === 'string' ? query['q'] : undefined;
  const workspaces = await service.list(serviceActor(actor), search ? { query: search } : {});

  const mayCreate = actor.permissionKeys.includes('platform.workspace.create');
  const showForm = query['view'] === 'new' && mayCreate;

  // Plans come from the ACTIVE configuration version. When the owner has not
  // configured any, the selector is empty and says so — no plan is invented.
  const plans = mayCreate ? await getEntitlementService().plans() : [];

  const errorCode = typeof query['error'] === 'string' ? query['error'] : null;
  const okCode = typeof query['ok'] === 'string' ? query['ok'] : null;
  const ref = typeof query['ref'] === 'string' ? query['ref'] : undefined;

  return (
    <div>
      <h1 style={{ marginBlockStart: 0, fontSize: '1.35rem' }}>{t('ws.title')}</h1>

      {errorCode && <Banner tone="error">{errorMessage(errorCode, locale, ref)}</Banner>}
      {okCode && successMessage(okCode, locale) && (
        <Banner tone="success">{successMessage(okCode, locale)}</Banner>
      )}

      <Card testId="workspace-directory">
        <form
          method="get"
          style={{
            display: 'flex',
            gap: spacingTokens.sm,
            flexWrap: 'wrap',
            alignItems: 'end',
            marginBlockEnd: spacingTokens.md,
          }}
        >
          <div style={{ flex: '1 1 16rem' }}>
            <label htmlFor="q" style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600 }}>
              {locale === 'ar' ? 'بحث' : 'Search'}
            </label>
            <input id="q" name="q" defaultValue={search ?? ''} style={inputStyle()} />
          </div>
          <button type="submit" data-testid="search-submit" style={primaryButtonStyle()}>
            {locale === 'ar' ? 'بحث' : 'Search'}
          </button>
          {mayCreate && (
            <Link
              href={`/${locale}/console/workspaces?view=new`}
              data-testid="open-create-workspace"
              style={{ ...primaryButtonStyle(), textDecoration: 'none', display: 'inline-block' }}
            >
              {t('ws.create')}
            </Link>
          )}
        </form>

        {workspaces.length === 0 ? (
          <EmptyState
            message={
              locale === 'ar'
                ? 'لا توجد مساحات عمل بعد. أنشئ أول عميل للبدء.'
                : 'No workspaces yet. Create the first customer to begin.'
            }
          />
        ) : (
          <TableScroll>
            <table style={tableStyle()} data-testid="workspace-table">
              <thead>
                <tr>
                  <th style={thStyle()}>{t('ws.name')}</th>
                  <th style={thStyle()}>{t('ws.slug')}</th>
                  <th style={thStyle()}>{t('ws.status')}</th>
                  <th style={thStyle()}>{t('ws.plan')}</th>
                  <th style={thStyle()}>{t('ws.members')}</th>
                  <th style={thStyle()}>{t('ws.lastActivity')}</th>
                </tr>
              </thead>
              <tbody>
                {workspaces.map((w) => (
                  <tr key={w.id} data-testid={`workspace-row-${w.slug}`}>
                    <td style={tdStyle()}>
                      <Link
                        href={`/${locale}/console/workspaces/${w.id}`}
                        style={{
                          color: colorTokens.brandPurple,
                          fontWeight: 600,
                          display: 'inline-block',
                          minBlockSize: '24px',
                          paddingBlock: '2px',
                        }}
                      >
                        {w.name}
                      </Link>
                    </td>
                    <td style={tdStyle()}>{w.slug}</td>
                    <td style={tdStyle()}>
                      <StatusPill status={w.status} />
                    </td>
                    <td style={tdStyle()}>{w.planKey ?? t('ws.noPlan')}</td>
                    <td style={tdStyle()}>{w.memberCount}</td>
                    <td style={tdStyle()}>
                      {w.lastActivityAt
                        ? w.lastActivityAt.toISOString().slice(0, 10)
                        : t('ws.never')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Card>

      {showForm && (
        <Card
          title={t('ws.create')}
          description={
            locale === 'ar'
              ? 'يُنشأ حساب المالك بدون كلمة مرور: يصل عبر دعوة. لا تُنشأ أي بيانات اعتماد افتراضية.'
              : 'The owner account is created without a password — they arrive by invitation. No default credential is ever minted.'
          }
          testId="create-workspace-card"
        >
          <form action={createWorkspaceAction}>
            <input type="hidden" name="locale" value={locale} />
            <Field label={t('ws.name')} htmlFor="name">
              <input id="name" name="name" required style={inputStyle()} />
            </Field>
            <Field
              label={t('ws.slug')}
              htmlFor="slug"
              hint={
                locale === 'ar'
                  ? '٣ إلى ٥٠ حرفًا صغيرًا أو رقمًا أو شرطة.'
                  : '3–50 lower-case letters, digits or hyphens.'
              }
            >
              <input id="slug" name="slug" required style={inputStyle()} />
            </Field>
            <Field label={t('ws.ownerEmail')} htmlFor="ownerEmail">
              <input id="ownerEmail" name="ownerEmail" type="email" required style={inputStyle()} />
            </Field>
            <Field label={t('ws.ownerName')} htmlFor="ownerName">
              <input id="ownerName" name="ownerName" style={inputStyle()} />
            </Field>
            <Field label={t('ws.type')} htmlFor="type">
              <select id="type" name="type" defaultValue="STARTUP" style={inputStyle()}>
                {['INDIVIDUAL', 'STARTUP', 'COMPANY', 'CREATOR', 'AGENCY', 'ENTERPRISE'].map(
                  (v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ),
                )}
              </select>
            </Field>
            <Field label={t('ws.locale')} htmlFor="defaultLocale">
              <select
                id="defaultLocale"
                name="defaultLocale"
                defaultValue="AR"
                style={inputStyle()}
              >
                <option value="AR">AR</option>
                <option value="EN">EN</option>
              </select>
            </Field>
            <Field label={t('ws.country')} htmlFor="country">
              <input
                id="country"
                name="country"
                defaultValue="SA"
                maxLength={2}
                style={inputStyle()}
              />
            </Field>
            <Field label={t('ws.timezone')} htmlFor="timezone">
              <input
                id="timezone"
                name="timezone"
                defaultValue="Asia/Riyadh"
                style={inputStyle()}
              />
            </Field>
            <Field label={t('ws.currency')} htmlFor="currency">
              <input
                id="currency"
                name="currency"
                defaultValue="SAR"
                maxLength={3}
                style={inputStyle()}
              />
            </Field>
            <Field
              label={t('ws.plan')}
              htmlFor="planKey"
              hint={
                plans.length === 0
                  ? locale === 'ar'
                    ? 'لم يُعتمد أي خطة بعد — تُدار الخطط من إعدادات المنصة.'
                    : 'No plan has been configured yet — plans are managed in platform configuration.'
                  : undefined
              }
            >
              <select id="planKey" name="planKey" defaultValue="" style={inputStyle()}>
                <option value="">{t('ws.noPlan')}</option>
                {plans.map((p) => (
                  <option key={p.key} value={p.key}>
                    {locale === 'ar' ? p.nameAr : p.nameEn}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('ws.trialDays')} htmlFor="trialDays">
              <input
                id="trialDays"
                name="trialDays"
                type="number"
                min={0}
                defaultValue={0}
                style={inputStyle()}
              />
            </Field>
            <button
              type="submit"
              data-testid="create-workspace-submit"
              style={primaryButtonStyle()}
            >
              {t('common.save')}
            </button>
          </form>
        </Card>
      )}
    </div>
  );
}
