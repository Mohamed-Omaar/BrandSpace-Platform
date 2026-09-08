import Link from 'next/link';
import {
  Avatar,
  Cell,
  DataTable,
  PageHeader,
  Pagination,
  RecordList,
  SearchField,
  Stack,
  StatusBadge,
  Toolbar,
  buttonStyle,
  colorTokens,
  initialsFrom,
  statusTone,
  typographyTokens,
  type MediaSeed,
} from '@brandspace/ui';
import { DEFAULT_WORKSPACE_PAGE_SIZE } from '@brandspace/auth';
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
  inputStyle,
  primaryButtonStyle,
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
/**
 * A stable palette per workspace, keyed by its slug — the deterministic-artwork
 * rule (D-57) applied to identity tiles, so a directory looks the same twice.
 */
function avatarSeed(slug: string): MediaSeed {
  const index = [...slug].reduce((total, character) => total + character.charCodeAt(0), 0) % 6;
  return index as MediaSeed;
}

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
  /*
   * A-11. PAGED, WITH A TRUTHFUL TOTAL.
   *
   * This listing used to take 200 rows and render them as the answer — no
   * total, no navigation, nothing on screen to say more existed. An operator
   * with 201 customers stopped seeing one and had no way to know. Same
   * contract as the secrets page (docs/ADMIN-CONTROL-CENTER.md §7.1): state in
   * the URL, an honest range, and every record reachable by paging.
   */
  const requestedPage = Number.parseInt(String(query['page'] ?? '1'), 10);
  const requestedSize = Number.parseInt(String(query['size'] ?? ''), 10);
  const workspaces = await service.list(serviceActor(actor), {
    ...(search ? { query: search } : {}),
    page: Number.isNaN(requestedPage) ? 1 : requestedPage,
    pageSize: Number.isNaN(requestedSize) ? DEFAULT_WORKSPACE_PAGE_SIZE : requestedSize,
  });

  /** A link back to this page with one thing changed. */
  const hrefWith = (changes: Record<string, string | number | undefined>): string => {
    const next = new URLSearchParams();
    if (search) next.set('q', search);
    next.set('page', String(workspaces.page));
    next.set('size', String(workspaces.pageSize));
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined || value === '') next.delete(key);
      else next.set(key, String(value));
    }
    const queryString = next.toString();
    return queryString
      ? `/${locale}/console/workspaces?${queryString}`
      : `/${locale}/console/workspaces`;
  };

  const mayCreate = actor.permissionKeys.includes('platform.workspace.create');
  const showForm = query['view'] === 'new' && mayCreate;

  // Plans come from the ACTIVE configuration version. When the owner has not
  // configured any, the selector is empty and says so — no plan is invented.
  const plans = mayCreate ? await getEntitlementService().plans() : [];

  const errorCode = typeof query['error'] === 'string' ? query['error'] : null;
  const okCode = typeof query['ok'] === 'string' ? query['ok'] : null;
  const ref = typeof query['ref'] === 'string' ? query['ref'] : undefined;

  const workspaceLink = (id: string, name: string) => (
    <Link
      href={`/${locale}/console/workspaces/${id}`}
      style={{
        color: colorTokens.brandPurple,
        fontWeight: 600,
        display: 'inline-block',
        minBlockSize: '24px',
        paddingBlock: '2px',
      }}
    >
      {name}
    </Link>
  );

  return (
    <div>
      <PageHeader
        title={t('ws.title')}
        description={
          locale === 'ar'
            ? 'كل مساحات عمل العملاء في هذه البيئة.'
            : 'Every customer workspace in this environment.'
        }
        actions={
          mayCreate ? (
            <Link
              href={`/${locale}/console/workspaces?view=new`}
              data-testid="open-create-workspace"
              style={{ ...buttonStyle('primary'), textDecoration: 'none' }}
            >
              {t('ws.create')}
            </Link>
          ) : undefined
        }
      />

      {errorCode && <Banner tone="error">{errorMessage(errorCode, locale, ref)}</Banner>}
      {okCode && successMessage(okCode, locale) && (
        <Banner tone="success">{successMessage(okCode, locale)}</Banner>
      )}

      <Stack>
        <Card testId="workspace-directory">
          <form method="get">
            <Toolbar>
              <SearchField
                id="q"
                name="q"
                label={locale === 'ar' ? 'بحث' : 'Search'}
                placeholder={locale === 'ar' ? 'الاسم أو المُعرّف' : 'Name or slug'}
                defaultValue={search ?? ''}
              />
              <button type="submit" data-testid="search-submit" style={buttonStyle('neutral')}>
                {locale === 'ar' ? 'بحث' : 'Search'}
              </button>
            </Toolbar>
          </form>

          {workspaces.total === 0 ? (
            search ? (
              /* No RESULTS is not the same message as no workspaces: one asks
                 you to change the query, the other to create a customer. */
              <EmptyState
                message={
                  locale === 'ar'
                    ? 'لا توجد نتائج مطابقة لبحثك.'
                    : 'No workspaces match your search.'
                }
              />
            ) : (
              <EmptyState
                message={
                  locale === 'ar'
                    ? 'لا توجد مساحات عمل بعد. أنشئ أول عميل للبدء.'
                    : 'No workspaces yet. Create the first customer to begin.'
                }
              />
            )
          ) : (
            <>
              <div className="bs-wide-only">
                <DataTable
                  headers={[
                    t('ws.name'),
                    t('ws.slug'),
                    t('ws.status'),
                    t('ws.plan'),
                    t('ws.members'),
                    t('ws.lastActivity'),
                  ]}
                  caption={t('ws.title')}
                  testId="workspace-table"
                >
                  {workspaces.items.map((w) => (
                    <tr key={w.id} data-testid={`workspace-row-${w.slug}`}>
                      <Cell>
                        {/*
                          `.record-main { display: flex; gap: 9px;
                           align-items: center }` with a squared-off
                          `.record-main .avatar { border-radius: 11px }` — the
                          demo's directory rows lead with an identity tile,
                          which is what makes a long list scannable. The
                          initials come from the workspace's own name.
                        */}
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.5625rem',
                            minInlineSize: 0,
                          }}
                        >
                          <Avatar
                            initials={initialsFrom(w.name)}
                            seed={avatarSeed(w.slug)}
                            shape="tile"
                          />
                          {workspaceLink(w.id, w.name)}
                        </span>
                      </Cell>
                      <Cell>{w.slug}</Cell>
                      <Cell>
                        <StatusBadge
                          label={w.status}
                          tone={statusTone(w.status)}
                          testId={`status-${w.status}`}
                        />
                      </Cell>
                      <Cell>{w.planKey ?? t('ws.noPlan')}</Cell>
                      <Cell>{w.memberCount}</Cell>
                      <Cell>
                        {w.lastActivityAt
                          ? w.lastActivityAt.toISOString().slice(0, 10)
                          : t('ws.never')}
                      </Cell>
                    </tr>
                  ))}
                </DataTable>
              </div>

              <div className="bs-narrow-only">
                <RecordList
                  testId="workspace-list"
                  records={workspaces.items.map((w) => ({
                    id: w.id,
                    title: workspaceLink(w.id, w.name),
                    fields: [
                      { label: t('ws.slug'), value: w.slug },
                      {
                        label: t('ws.status'),
                        value: <StatusBadge label={w.status} tone={statusTone(w.status)} />,
                      },
                      { label: t('ws.plan'), value: w.planKey ?? t('ws.noPlan') },
                      { label: t('ws.members'), value: String(w.memberCount) },
                      {
                        label: t('ws.lastActivity'),
                        value: w.lastActivityAt
                          ? w.lastActivityAt.toISOString().slice(0, 10)
                          : t('ws.never'),
                      },
                    ],
                  }))}
                />
              </div>
            </>
          )}

          {/*
            THE RANGE, ALWAYS — even on a single page, and even when empty.
            The pagination nav disappears when there is only one page, but "how
            many are there" is the assurance that nothing is being hidden, and
            its absence is exactly what made the old 200-row cap silent.
          */}
          <p
            data-testid="workspace-range"
            role="status"
            style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}
          >
            {locale === 'ar'
              ? `عرض ${workspaces.from}–${workspaces.to} من ${workspaces.total}`
              : `Showing ${workspaces.from}–${workspaces.to} of ${workspaces.total}`}
          </p>

          <Pagination
            page={workspaces.page}
            pageCount={workspaces.totalPages}
            hrefForPage={(target) => hrefWith({ page: target })}
            labels={{
              navigation: locale === 'ar' ? 'تنقل الصفحات' : 'Pagination',
              previous: locale === 'ar' ? 'السابق' : 'Previous',
              next: locale === 'ar' ? 'التالي' : 'Next',
              summary:
                locale === 'ar'
                  ? `صفحة ${workspaces.page} من ${workspaces.totalPages}`
                  : `Page ${workspaces.page} of ${workspaces.totalPages}`,
            }}
            testId="workspace-pagination"
          />
        </Card>
      </Stack>

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
              <input className="bs-control" id="name" name="name" required style={inputStyle()} />
            </Field>
            <Field
              label={t('ws.slug')}
              htmlFor="slug"
              hint={
                locale === 'ar'
                  ? '3 إلى 50 حرفًا صغيرًا أو رقمًا أو شرطة.'
                  : '3–50 lower-case letters, digits or hyphens.'
              }
            >
              <input className="bs-control" id="slug" name="slug" required style={inputStyle()} />
            </Field>
            <Field label={t('ws.ownerEmail')} htmlFor="ownerEmail">
              <input
                className="bs-control"
                id="ownerEmail"
                name="ownerEmail"
                type="email"
                required
                style={inputStyle()}
              />
            </Field>
            <Field label={t('ws.ownerName')} htmlFor="ownerName">
              <input className="bs-control" id="ownerName" name="ownerName" style={inputStyle()} />
            </Field>
            <Field label={t('ws.type')} htmlFor="type">
              <select
                className="bs-control"
                id="type"
                name="type"
                defaultValue="STARTUP"
                style={inputStyle()}
              >
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
                className="bs-control"
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
                className="bs-control"
                id="country"
                name="country"
                defaultValue="SA"
                maxLength={2}
                style={inputStyle()}
              />
            </Field>
            <Field label={t('ws.timezone')} htmlFor="timezone">
              <input
                className="bs-control"
                id="timezone"
                name="timezone"
                defaultValue="Asia/Riyadh"
                style={inputStyle()}
              />
            </Field>
            <Field label={t('ws.currency')} htmlFor="currency">
              <input
                className="bs-control"
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
              <select
                className="bs-control"
                id="planKey"
                name="planKey"
                defaultValue=""
                style={inputStyle()}
              >
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
                className="bs-control"
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
