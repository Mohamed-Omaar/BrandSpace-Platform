import { cookies } from 'next/headers';
import { colorTokens, spacingTokens } from '@brandspace/ui';
import {
  getSupportModeService,
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
  TableScroll,
  dangerButtonStyle,
  inputStyle,
  primaryButtonStyle,
  tableStyle,
  tdStyle,
  thStyle,
} from '../../../../components/console-ui';
import { endSupportAction, startSupportAction } from './actions';
import { SUPPORT_COOKIE } from '../../../../server/support-cookie';

export const dynamic = 'force-dynamic';

/**
 * Support Mode.
 *
 * Read-only, time-boxed, reason-tagged, and unmistakably labelled. The page
 * says in both languages that the operator is acting as platform staff and not
 * as the customer, because D-28 prohibits impersonation and a UI that is vague
 * about whose actions these are undermines that guarantee just as effectively
 * as a missing check would.
 */
export default async function SupportModePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const actor = await requirePageActor(locale, 'platform.support_mode.enter');
  const t = translator(locale);

  const support = getSupportModeService();
  const store = await cookies();
  const sessionId = store.get(SUPPORT_COOKIE)?.value;
  // Resolution re-checks owner AND expiry; a stale cookie yields null.
  const active = sessionId ? await support.resolve(sessionId, actor.platformUserId) : null;

  const workspaces = await getWorkspaceService().list(serviceActor(actor));

  const errorCode = typeof query['error'] === 'string' ? query['error'] : null;
  const okCode = typeof query['ok'] === 'string' ? query['ok'] : null;
  const ref = typeof query['ref'] === 'string' ? query['ref'] : undefined;

  const history = active ? await support.listForWorkspace(active.workspaceId) : [];

  return (
    <div>
      <h1 style={{ marginBlockStart: 0, fontSize: '1.35rem' }}>{t('support.title')}</h1>

      {errorCode && <Banner tone="error">{errorMessage(errorCode, locale, ref)}</Banner>}
      {okCode && successMessage(okCode, locale) && (
        <Banner tone="success">{successMessage(okCode, locale)}</Banner>
      )}

      {active ? (
        <Card testId="support-active">
          <p
            data-testid="support-impersonation-notice"
            style={{
              marginBlockStart: 0,
              fontWeight: 600,
              color: colorTokens.textPrimary,
            }}
          >
            {t('support.noImpersonation')}
          </p>
          <TableScroll>
            <table style={tableStyle()}>
              <tbody>
                <tr>
                  <th scope="row" style={thStyle()}>
                    {locale === 'ar' ? 'مساحة العمل' : 'Workspace'}
                  </th>
                  <td style={tdStyle()} data-testid="support-workspace">
                    {active.workspaceName}
                  </td>
                </tr>
                <tr>
                  <th scope="row" style={thStyle()}>
                    {locale === 'ar' ? 'الفاعل' : 'Actor'}
                  </th>
                  <td style={tdStyle()}>
                    {actor.email} · {actor.roleKey}
                  </td>
                </tr>
                <tr>
                  <th scope="row" style={thStyle()}>
                    {t('support.reason')}
                  </th>
                  <td style={tdStyle()} data-testid="support-reason">
                    {active.reason}
                  </td>
                </tr>
                <tr>
                  <th scope="row" style={thStyle()}>
                    {t('support.remaining')}
                  </th>
                  <td style={tdStyle()} data-testid="support-remaining">
                    {Math.floor(active.remainingSeconds / 60)}{' '}
                    {locale === 'ar' ? 'دقيقة' : 'minutes'}
                  </td>
                </tr>
                <tr>
                  <th scope="row" style={thStyle()}>
                    {locale === 'ar' ? 'الصلاحية' : 'Access'}
                  </th>
                  <td style={tdStyle()} data-testid="support-access-level">
                    {t('support.readOnly')}
                  </td>
                </tr>
              </tbody>
            </table>
          </TableScroll>

          <form action={endSupportAction} style={{ marginBlockStart: spacingTokens.md }}>
            <input type="hidden" name="locale" value={locale} />
            <button type="submit" data-testid="support-end" style={dangerButtonStyle()}>
              {t('support.end')}
            </button>
          </form>
        </Card>
      ) : (
        <Card
          title={t('support.start')}
          description={
            locale === 'ar'
              ? 'تُسجَّل كل جلسة في سجل نشاط العميل نفسه، مع السبب والمدة.'
              : "Every session appears in the customer's own Activity Log, with its reason and duration."
          }
          testId="support-start-card"
        >
          <p data-testid="support-none" style={{ marginBlockStart: 0 }}>
            {t('support.none')}
          </p>
          {workspaces.length === 0 ? (
            <EmptyState
              message={locale === 'ar' ? 'لا توجد مساحات عمل.' : 'There are no workspaces.'}
            />
          ) : (
            <form action={startSupportAction}>
              <input type="hidden" name="locale" value={locale} />
              <Field label={locale === 'ar' ? 'مساحة العمل' : 'Workspace'} htmlFor="workspaceId">
                <select id="workspaceId" name="workspaceId" style={inputStyle()}>
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} ({w.slug})
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label={t('support.reason')}
                htmlFor="support-reason-input"
                hint={locale === 'ar' ? '٨ أحرف على الأقل.' : 'At least 8 characters.'}
              >
                <input
                  id="support-reason-input"
                  name="reason"
                  required
                  minLength={8}
                  style={inputStyle()}
                />
              </Field>
              <Field label={t('support.ticket')} htmlFor="ticketRef">
                <input id="ticketRef" name="ticketRef" style={inputStyle()} />
              </Field>
              <button type="submit" data-testid="support-start" style={primaryButtonStyle()}>
                {t('support.start')}
              </button>
            </form>
          )}
        </Card>
      )}

      {history.length > 0 && (
        <Card
          title={
            locale === 'ar' ? 'جلسات الدعم على مساحة العمل' : 'Support sessions on this workspace'
          }
          testId="support-history"
        >
          <TableScroll>
            <table style={tableStyle()}>
              <thead>
                <tr>
                  <th style={thStyle()}>{locale === 'ar' ? 'الفاعل' : 'Actor'}</th>
                  <th style={thStyle()}>{t('support.reason')}</th>
                  <th style={thStyle()}>{locale === 'ar' ? 'بدأت' : 'Granted'}</th>
                  <th style={thStyle()}>{locale === 'ar' ? 'تنتهي' : 'Expires'}</th>
                </tr>
              </thead>
              <tbody>
                {history.map((s) => (
                  <tr key={s.id}>
                    <td style={tdStyle()}>{s.platformUserEmail}</td>
                    <td style={tdStyle()}>{s.reason}</td>
                    <td style={tdStyle()}>
                      {s.grantedAt.toISOString().slice(0, 16).replace('T', ' ')}
                    </td>
                    <td style={tdStyle()}>
                      {s.expiresAt.toISOString().slice(0, 16).replace('T', ' ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </Card>
      )}
    </div>
  );
}
