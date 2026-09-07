import { SectionHeader, colorTokens, spacingTokens, typographyTokens } from '@brandspace/ui';
import { rolloutBucket } from '@brandspace/entitlements';
import { errorMessage, successMessage } from '../../../../i18n/status-messages';
import { Cell, DataTable, EmptyState, PageIntro } from '../../../../components/admin-shell';
import {
  Banner,
  Card,
  Field,
  StatusPill,
  dangerButtonStyle,
  inputStyle,
  primaryButtonStyle,
  secondaryButtonStyle,
} from '../../../../components/console-ui';
import { requirePageActor } from '../../../../server/platform-context';
import { loadDomainEditor } from '../../../../server/config-draft';
import {
  activateFlagsAction,
  removeFlagAction,
  rollbackFlagsAction,
  saveFlagAction,
  toggleKillSwitchAction,
  validateFlagsAction,
} from './actions';

export const dynamic = 'force-dynamic';

/**
 * Feature flag targeting — §5.2 and §5.3.
 *
 * All eight dimensions are editable, in the precedence order the engine
 * evaluates them, and the order is printed on the page. An operator who cannot
 * see the precedence cannot reason about why a flag did what it did.
 *
 * The KILL SWITCH sits at the top of each row with its own one-press control
 * that validates and activates in the same action. Containment during an
 * incident must not depend on remembering a second step.
 */

interface FlagRow {
  readonly featureKey: string;
  readonly killSwitch: boolean;
  readonly globalEnabled: boolean | null;
  readonly enabledForPlans: readonly string[];
  readonly enabledForWorkspaces: readonly string[];
  readonly disabledForWorkspaces: readonly string[];
  readonly betaGroups: readonly string[];
  readonly countries: readonly string[];
  readonly activeFrom: string | null;
  readonly activeUntil: string | null;
  readonly percentageRollout: number | null;
}

function readFlags(payload: Record<string, unknown>): FlagRow[] {
  return ((payload['flags'] ?? []) as Record<string, unknown>[]).map((f) => ({
    featureKey: String(f['featureKey'] ?? ''),
    killSwitch: f['killSwitch'] === true,
    globalEnabled:
      f['globalEnabled'] === null || f['globalEnabled'] === undefined
        ? null
        : f['globalEnabled'] === true,
    enabledForPlans: (f['enabledForPlans'] ?? []) as string[],
    enabledForWorkspaces: (f['enabledForWorkspaces'] ?? []) as string[],
    disabledForWorkspaces: (f['disabledForWorkspaces'] ?? []) as string[],
    betaGroups: (f['betaGroups'] ?? []) as string[],
    countries: (f['countries'] ?? []) as string[],
    activeFrom: (f['activeFrom'] as string | null) ?? null,
    activeUntil: (f['activeUntil'] as string | null) ?? null,
    percentageRollout:
      f['percentageRollout'] === null || f['percentageRollout'] === undefined
        ? null
        : Number(f['percentageRollout']),
  }));
}

/** The precedence the engine actually applies, highest first. */
const PRECEDENCE = [
  ['Kill switch', 'مفتاح الإيقاف'],
  ['Workspace override', 'استثناء مساحة العمل'],
  ['Explicit allow / deny list', 'قائمة السماح/المنع الصريحة'],
  ['Beta cohort', 'مجموعة التجربة'],
  ['Country', 'الدولة'],
  ['Date range', 'النطاق الزمني'],
  ['Percentage rollout', 'النشر التدريجي'],
  ['Plan entitlement', 'استحقاق الخطة'],
  ['Feature default', 'الافتراضي'],
] as const;

export default async function FlagsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{
    error?: string;
    ok?: string;
    ref?: string;
    errors?: string;
    edit?: string;
    probe?: string;
  }>;
}) {
  const { locale } = await params;
  const search = await searchParams;
  const isArabic = locale === 'ar';

  const actor = await requirePageActor(locale, 'platform.configuration.read');
  const mayEdit = actor.permissionKeys.includes('platform.configuration.manage');
  const mayActivate = actor.permissionKeys.includes('platform.configuration.activate');

  const state = await loadDomainEditor(actor, 'feature-flags');
  const activeFlags = readFlags(state.activePayload);
  const draftFlags = state.draft ? readFlags(state.draft.payload) : [];
  const editing = search.edit
    ? (draftFlags.find((f) => f.featureKey === search.edit) ??
      activeFlags.find((f) => f.featureKey === search.edit) ??
      null)
    : null;

  return (
    <>
      <PageIntro
        description={
          isArabic
            ? 'كل أبعاد الاستهداف الثمانية، بترتيب الأسبقية الذي يطبّقه المحرك فعلًا.'
            : 'All eight targeting dimensions, in the precedence order the engine actually applies.'
        }
      />

      {search.error ? (
        <Banner tone="error">
          {errorMessage(search.error, locale)}
          {search.ref ? ` (${search.ref})` : ''}
        </Banner>
      ) : null}
      {search.ok ? (
        <Banner tone={search.ok === 'VALIDATION_FAILED' ? 'error' : 'success'}>
          {successMessage(
            search.ok,
            locale,
            new URLSearchParams(search.errors ? { errors: search.errors } : {}),
          )}
        </Banner>
      ) : null}

      <Card>
        <SectionHeader
          title={isArabic ? 'ترتيب الأسبقية' : 'Precedence order'}
          description={
            isArabic
              ? 'أول قاعدة تُنتج قرارًا هي التي تفوز. مفتاح الإيقاف أولًا ولا يمكن لأي استثناء تجاوزه.'
              : 'The first rule that produces a decision wins. The kill switch is first and no override can outrank it.'
          }
        />
        <ol
          data-testid="precedence-order"
          style={{
            margin: 0,
            paddingInlineStart: spacingTokens.lg,
            color: colorTokens.textSecondary,
            fontSize: typographyTokens.bodySm.fontSize,
          }}
        >
          {PRECEDENCE.map(([en, ar]) => (
            <li key={en}>{isArabic ? ar : en}</li>
          ))}
        </ol>
      </Card>

      <Card>
        <SectionHeader
          title={isArabic ? 'المفاتيح المُفعّلة' : 'Active flags'}
          description={
            isArabic ? 'ما يُطبَّق على العملاء الآن.' : 'What is applied to customers right now.'
          }
        />
        {activeFlags.length === 0 ? (
          <EmptyState message={isArabic ? 'لا توجد مفاتيح مُفعّلة.' : 'No flags are active.'} />
        ) : (
          <FlagTable
            flags={activeFlags}
            locale={locale}
            mayEdit={mayEdit}
            mayActivate={mayActivate}
          />
        )}
      </Card>

      {state.draft ? (
        <Card>
          <SectionHeader
            title={isArabic ? 'المسودة' : 'Draft'}
            description={
              isArabic
                ? `الإصدار ${state.draft.versionNumber} — ${state.draft.status}`
                : `Version ${state.draft.versionNumber} — ${state.draft.status}`
            }
          />
          <FlagTable flags={draftFlags} locale={locale} mayEdit={mayEdit} mayActivate={false} />
          <div
            style={{ display: 'flex', gap: spacingTokens.sm, marginBlockStart: spacingTokens.md }}
          >
            {mayEdit ? (
              <form action={validateFlagsAction}>
                <input className="bs-control" type="hidden" name="locale" value={locale} />
                <input
                  className="bs-control"
                  type="hidden"
                  name="versionId"
                  value={state.draft.id}
                />
                <button type="submit" style={secondaryButtonStyle()} data-testid="validate-flags">
                  {isArabic ? 'تحقق' : 'Validate'}
                </button>
              </form>
            ) : null}
            {mayActivate ? (
              <form action={activateFlagsAction}>
                <input className="bs-control" type="hidden" name="locale" value={locale} />
                <input
                  className="bs-control"
                  type="hidden"
                  name="versionId"
                  value={state.draft.id}
                />
                <label
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: spacingTokens.xs,
                    fontSize: typographyTokens.caption.fontSize,
                    marginInlineEnd: spacingTokens.sm,
                  }}
                >
                  <input className="bs-control" type="checkbox" name="acknowledge" value="yes" />
                  {isArabic ? 'أقرّ بالتغييرات عالية الأثر' : 'Acknowledge high-impact changes'}
                </label>
                <button type="submit" style={primaryButtonStyle()} data-testid="activate-flags">
                  {isArabic ? 'تفعيل' : 'Activate'}
                </button>
              </form>
            ) : null}
          </div>
        </Card>
      ) : null}

      {mayEdit ? (
        <Card>
          <SectionHeader
            title={
              editing
                ? isArabic
                  ? `تحرير «${editing.featureKey}»`
                  : `Edit "${editing.featureKey}"`
                : isArabic
                  ? 'مفتاح جديد'
                  : 'New flag'
            }
            description={
              isArabic
                ? 'اترك حقلًا فارغًا ليعني «لا رأي لهذا المفتاح» — فتقرر القاعدة الأدنى في الترتيب.'
                : 'Leave a field blank to mean "this flag has no opinion" — the next rule down then decides.'
            }
          />
          <FlagForm flag={editing} locale={locale} />
        </Card>
      ) : null}

      {/* The rollout is a stable hash. Showing the bucket for a workspace makes
          "why is this customer in the rollout?" answerable without guessing. */}
      {search.probe ? (
        <Card>
          <SectionHeader title={isArabic ? 'فحص النشر التدريجي' : 'Rollout probe'} />
          <DataTable
            headers={
              isArabic ? ['الميزة', 'مساحة العمل', 'الحصّة'] : ['Feature', 'Workspace', 'Bucket']
            }
          >
            {activeFlags
              .filter((flag) => flag.percentageRollout !== null)
              .map((flag) => (
                <tr key={flag.featureKey} data-testid={`probe-${flag.featureKey}`}>
                  <Cell>{flag.featureKey}</Cell>
                  <Cell>{search.probe}</Cell>
                  <Cell>
                    {rolloutBucket(flag.featureKey, search.probe!)} / {flag.percentageRollout}
                  </Cell>
                </tr>
              ))}
          </DataTable>
        </Card>
      ) : null}

      <Card>
        <SectionHeader title={isArabic ? 'سجل الإصدارات' : 'Version history'} />
        {state.versions.length === 0 ? (
          <EmptyState message={isArabic ? 'لا توجد إصدارات بعد.' : 'No versions yet.'} />
        ) : (
          <DataTable
            headers={
              isArabic
                ? ['الإصدار', 'الحالة', 'فُعِّل', '']
                : ['Version', 'Status', 'Activated', '']
            }
          >
            {state.versions.map((version) => (
              <tr key={version.id} data-testid={`flag-version-${version.versionNumber}`}>
                <Cell>{version.versionNumber}</Cell>
                <Cell>
                  <StatusPill status={version.status} />
                </Cell>
                <Cell>{version.activatedAt?.toISOString().slice(0, 10) ?? '—'}</Cell>
                <Cell>
                  {mayActivate && version.status === 'SUPERSEDED' ? (
                    <form action={rollbackFlagsAction}>
                      <input className="bs-control" type="hidden" name="locale" value={locale} />
                      <input
                        className="bs-control"
                        type="hidden"
                        name="versionId"
                        value={version.id}
                      />
                      <input
                        className="bs-control"
                        type="hidden"
                        name="reason"
                        value="Rolled back from the Control Center."
                      />
                      <button
                        type="submit"
                        style={secondaryButtonStyle()}
                        data-testid={`rollback-flag-${version.versionNumber}`}
                      >
                        {isArabic ? 'استرجاع' : 'Roll back'}
                      </button>
                    </form>
                  ) : (
                    '—'
                  )}
                </Cell>
              </tr>
            ))}
          </DataTable>
        )}
      </Card>
    </>
  );
}

function FlagTable({
  flags,
  locale,
  mayEdit,
  mayActivate,
}: {
  readonly flags: readonly FlagRow[];
  readonly locale: string;
  readonly mayEdit: boolean;
  readonly mayActivate: boolean;
}) {
  const isArabic = locale === 'ar';
  return (
    <DataTable
      headers={
        isArabic
          ? [
              'الميزة',
              'الإيقاف',
              'عام',
              'الخطط',
              'المجموعات',
              'الدول',
              'النطاق الزمني',
              'النشر',
              '',
            ]
          : ['Feature', 'Kill', 'Global', 'Plans', 'Cohorts', 'Countries', 'Dates', 'Rollout', '']
      }
    >
      {flags.map((flag) => (
        <tr key={flag.featureKey} data-testid={`flag-${flag.featureKey}`}>
          <Cell>
            <code>{flag.featureKey}</code>
          </Cell>
          <Cell>
            <span data-testid={`kill-${flag.featureKey}`}>
              {flag.killSwitch ? (isArabic ? 'مُفعّل' : 'ENGAGED') : '—'}
            </span>
          </Cell>
          <Cell>
            {flag.globalEnabled === null
              ? '—'
              : flag.globalEnabled
                ? isArabic
                  ? 'نعم'
                  : 'on'
                : isArabic
                  ? 'لا'
                  : 'off'}
          </Cell>
          <Cell>{flag.enabledForPlans.join(', ') || '—'}</Cell>
          <Cell>{flag.betaGroups.join(', ') || '—'}</Cell>
          <Cell>{flag.countries.join(', ') || '—'}</Cell>
          <Cell>
            {flag.activeFrom || flag.activeUntil
              ? `${flag.activeFrom?.slice(0, 10) ?? '…'} → ${flag.activeUntil?.slice(0, 10) ?? '…'}`
              : '—'}
          </Cell>
          <Cell>{flag.percentageRollout === null ? '—' : `${flag.percentageRollout}%`}</Cell>
          <Cell>
            <div style={{ display: 'flex', gap: spacingTokens.xs, flexWrap: 'wrap' }}>
              {mayActivate ? (
                <form action={toggleKillSwitchAction}>
                  <input className="bs-control" type="hidden" name="locale" value={locale} />
                  <input
                    className="bs-control"
                    type="hidden"
                    name="featureKey"
                    value={flag.featureKey}
                  />
                  <input
                    className="bs-control"
                    type="hidden"
                    name="engage"
                    value={flag.killSwitch ? 'no' : 'yes'}
                  />
                  <button
                    type="submit"
                    style={flag.killSwitch ? secondaryButtonStyle() : dangerButtonStyle()}
                    data-testid={`kill-toggle-${flag.featureKey}`}
                  >
                    {flag.killSwitch
                      ? isArabic
                        ? 'تحرير الإيقاف'
                        : 'Release'
                      : isArabic
                        ? 'إيقاف فوري'
                        : 'Kill'}
                  </button>
                </form>
              ) : null}
              {mayEdit ? (
                <>
                  <a
                    href={`/${locale}/console/flags?edit=${encodeURIComponent(flag.featureKey)}`}
                    style={{ ...secondaryButtonStyle(), textDecoration: 'none' }}
                    data-testid={`edit-flag-${flag.featureKey}`}
                  >
                    {isArabic ? 'تحرير' : 'Edit'}
                  </a>
                  <form action={removeFlagAction}>
                    <input className="bs-control" type="hidden" name="locale" value={locale} />
                    <input
                      className="bs-control"
                      type="hidden"
                      name="featureKey"
                      value={flag.featureKey}
                    />
                    <button type="submit" style={dangerButtonStyle()}>
                      {isArabic ? 'إزالة' : 'Remove'}
                    </button>
                  </form>
                </>
              ) : null}
            </div>
          </Cell>
        </tr>
      ))}
    </DataTable>
  );
}

function FlagForm({ flag, locale }: { readonly flag: FlagRow | null; readonly locale: string }) {
  const isArabic = locale === 'ar';
  const grid = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))',
    gap: spacingTokens.md,
  } as const;

  return (
    <form action={saveFlagAction} data-testid="flag-form">
      <input className="bs-control" type="hidden" name="locale" value={locale} />
      <div style={grid}>
        <Field label={isArabic ? 'مفتاح الميزة' : 'Feature key'} htmlFor="flag-feature">
          <input
            className="bs-control"
            id="flag-feature"
            name="featureKey"
            required
            defaultValue={flag?.featureKey ?? ''}
            style={inputStyle()}
            data-testid="flag-feature"
          />
        </Field>
        <Field label={isArabic ? 'مفتاح الإيقاف' : 'Kill switch'} htmlFor="flag-kill">
          <select
            className="bs-control"
            id="flag-kill"
            name="killSwitch"
            defaultValue={flag?.killSwitch ? 'yes' : 'no'}
            style={inputStyle()}
          >
            <option value="no">{isArabic ? 'لا' : 'no'}</option>
            <option value="yes">{isArabic ? 'نعم' : 'yes'}</option>
          </select>
        </Field>
        <Field
          label={isArabic ? 'الإعداد العام' : 'Global setting'}
          htmlFor="flag-global"
          hint={isArabic ? 'فارغ = لا رأي' : 'blank = no opinion'}
        >
          <select
            className="bs-control"
            id="flag-global"
            name="globalEnabled"
            defaultValue={flag?.globalEnabled === null ? '' : String(flag?.globalEnabled ?? '')}
            style={inputStyle()}
          >
            <option value="">—</option>
            <option value="true">{isArabic ? 'مُفعّل' : 'on'}</option>
            <option value="false">{isArabic ? 'مُعطّل' : 'off'}</option>
          </select>
        </Field>
        <Field label={isArabic ? 'الخطط' : 'Plans'} htmlFor="flag-plans">
          <input
            className="bs-control"
            id="flag-plans"
            name="enabledForPlans"
            defaultValue={flag?.enabledForPlans.join(', ') ?? ''}
            style={inputStyle()}
          />
        </Field>
        <Field label={isArabic ? 'سماح لمساحات عمل' : 'Allow workspaces'} htmlFor="flag-allow">
          <input
            className="bs-control"
            id="flag-allow"
            name="enabledForWorkspaces"
            defaultValue={flag?.enabledForWorkspaces.join(', ') ?? ''}
            style={inputStyle()}
          />
        </Field>
        <Field label={isArabic ? 'منع مساحات عمل' : 'Deny workspaces'} htmlFor="flag-deny">
          <input
            className="bs-control"
            id="flag-deny"
            name="disabledForWorkspaces"
            defaultValue={flag?.disabledForWorkspaces.join(', ') ?? ''}
            style={inputStyle()}
          />
        </Field>
        <Field label={isArabic ? 'مجموعات التجربة' : 'Beta cohorts'} htmlFor="flag-cohorts">
          <input
            className="bs-control"
            id="flag-cohorts"
            name="betaGroups"
            defaultValue={flag?.betaGroups.join(', ') ?? ''}
            style={inputStyle()}
            data-testid="flag-cohorts"
          />
        </Field>
        <Field label={isArabic ? 'الدول' : 'Countries'} htmlFor="flag-countries">
          <input
            className="bs-control"
            id="flag-countries"
            name="countries"
            defaultValue={flag?.countries.join(', ') ?? ''}
            style={inputStyle()}
          />
        </Field>
        <Field label={isArabic ? 'يبدأ' : 'Active from'} htmlFor="flag-from">
          <input
            className="bs-control"
            id="flag-from"
            name="activeFrom"
            type="date"
            defaultValue={flag?.activeFrom?.slice(0, 10) ?? ''}
            style={inputStyle()}
          />
        </Field>
        <Field label={isArabic ? 'ينتهي' : 'Active until'} htmlFor="flag-until">
          <input
            className="bs-control"
            id="flag-until"
            name="activeUntil"
            type="date"
            defaultValue={flag?.activeUntil?.slice(0, 10) ?? ''}
            style={inputStyle()}
          />
        </Field>
        <Field
          label={isArabic ? 'النشر التدريجي %' : 'Percentage rollout'}
          htmlFor="flag-rollout"
          hint={
            isArabic
              ? 'تجزئة ثابتة — لا تتغير المساحة بين الطلبات.'
              : 'A stable hash — a workspace does not flip between requests.'
          }
        >
          <input
            className="bs-control"
            id="flag-rollout"
            name="percentageRollout"
            type="number"
            min={0}
            max={100}
            defaultValue={flag?.percentageRollout ?? ''}
            style={inputStyle()}
            data-testid="flag-rollout"
          />
        </Field>
      </div>
      <button type="submit" style={primaryButtonStyle()} data-testid="save-flag">
        {isArabic ? 'حفظ في المسودة' : 'Save to draft'}
      </button>
    </form>
  );
}
