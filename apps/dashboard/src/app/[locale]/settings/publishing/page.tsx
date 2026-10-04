import Link from 'next/link';
import {
  Card,
  DraftForm,
  Field,
  SectionHeader,
  StateMessage,
  StatusBadge,
  buttonClass,
  buttonStyle,
  colorTokens,
  inputStyle,
  layoutTokens,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import { requireWorkspacePage } from '../../../../server/customer-context';
import { inContentStudio } from '../../../../server/content-context';
import { NoAccessPage } from '../../../../components/no-access-page';
import { CheckboxRow } from '../../../../components/checkbox-row';
import { brandContextFor, listAccessibleBrands } from '../../../../server/brand-context';
import { SettingsFrame } from '../../../../components/settings-frame';
import { saveBarLabels } from '../../../../server/save-bar-labels';
import {
  optionalMessage,
  statusMessage,
  translator,
  type MessageKey,
  successFlash,
} from '../../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../../components/workspace-shell';
import { CONTENT_TYPES } from '../../content/content-types';
import {
  deleteTemplateAction,
  savePublishingDefaultsAction,
  saveTemplateAction,
  setDefaultTemplateAction,
} from './actions';

export const dynamic = 'force-dynamic';

/**
 * SETTINGS → PUBLISHING DEFAULTS (prototype v90 A8 / A10 / B2, Phase 2B-2 —
 * deferred here from Phase 2B-1, §6.2).
 *
 * Per brand the member may see (one while multi-brand is off, D-327): the
 * channels a new post starts with, the time it is proposed at, whether its
 * hashtags go into the first comment — under the shared save bar (G1) — and
 * the brand's post templates. Link tracking is not here (Q15, deferred); the
 * AI suggestions switch is in Settings → AI (owner answer D7).
 *
 * `brand.manage` opens the tab (the key Settings → AI uses). The template list
 * is shown to everyone who opens it; saving, changing, deleting and choosing
 * the default are offered only with `templates.manage`, which every action
 * and the service check again.
 *
 * DESIGN-SYSTEM EXTENSION (CLAUDE.md §4.2; UI-FIDELITY §6.3): `SettingsSplit`,
 * `Card`, `SectionHeader`, `Field`, `CheckboxRow`, `StatusBadge`,
 * `StateMessage`, the native `bs-select` and the `<details>` two-step delete the
 * Automations screen already uses. No new component.
 */
export default async function PublishingDefaultsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const access = await requireWorkspacePage(locale, '/settings/publishing');
  const { messageLocale } = access.session;
  const t = translator(messageLocale);
  if (!access.allowed) return <NoAccessPage locale={locale} access={access} />;
  const { customer, workspace } = access.session;
  const mayManageTemplates = workspace.permissionKeys.includes('templates.manage');

  const accessible = await listAccessibleBrands(workspace);
  const data = await inContentStudio(workspace.workspaceId, async (services) => {
    const policy = await services.policy();
    const brands = await services.db.brand.findMany({
      where: { id: { in: accessible.map((brand) => brand.id) }, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        defaultPlatformKeys: true,
        defaultPostTime: true,
        hashtagsInFirstComment: true,
      },
    });
    const templates = await services.templates();
    const byBrand = new Map(
      await Promise.all(
        brands.map(
          async (brand) =>
            [
              brand.id,
              await templates.list({ brandId: brand.id, brandScope: workspace.brandScope }),
            ] as const,
        ),
      ),
    );
    return { policy, brands, byBrand };
  });

  const platformLabel = (key: string, labelKey: string) =>
    optionalMessage(messageLocale, labelKey) ?? key;
  const platforms = data.policy.platforms.map((platform) => ({
    key: platform.key,
    label: platformLabel(platform.key, platform.labelKey),
  }));
  const labelOf = (key: string) => platforms.find((p) => p.key === key)?.label ?? key;

  const editId = typeof query['edit'] === 'string' ? query['edit'] : null;
  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const ok = typeof query['ok'] === 'string' ? query['ok'] : null;
  const ref = typeof query['ref'] === 'string' ? query['ref'] : undefined;
  const brandContext = await brandContextFor(workspace, '/settings');

  const listStyle = {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'grid',
    gap: spacingTokens.sm,
  } as const;
  const hintStyle = { ...typographyTokens.caption, color: colorTokens.textSecondary } as const;

  return (
    <WorkspaceShell
      flash={successFlash(ok, locale)}
      brandContext={brandContext}
      locale={locale}
      heading={t('settings.publishing')}
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      {error && <CustomerBanner tone="error">{statusMessage(error, locale, ref)}</CustomerBanner>}
      <SettingsFrame
        locale={locale}
        permissionKeys={workspace.permissionKeys}
        selected="publishing"
      >
        {data.brands.length === 0 ? (
          <Card testId="publishing-defaults">
            <StateMessage
              title={t('publishingDefaults.noBrand')}
              testId="publishing-defaults-no-brand"
            />
          </Card>
        ) : null}
        {data.brands.map((brand) => {
          const templates = data.byBrand.get(brand.id) ?? [];
          const editing = templates.find((template) => template.id === editId) ?? null;
          const saved = {
            platformKeys: [...brand.defaultPlatformKeys].sort(),
            time: brand.defaultPostTime ?? '',
            hashtags: brand.hashtagsInFirstComment,
          };
          return (
            <div key={brand.id} style={{ display: 'grid', gap: spacingTokens.md }}>
              <Card testId={`publishing-defaults-${brand.id}`}>
                <SectionHeader
                  title={
                    data.brands.length > 1
                      ? `${t('publishingDefaults.title')} · ${brand.name}`
                      : t('publishingDefaults.title')
                  }
                  description={t('publishingDefaults.body')}
                />
                <DraftForm
                  key={JSON.stringify(saved)}
                  action={savePublishingDefaultsAction}
                  style={{ display: 'grid', gap: spacingTokens.md }}
                  testId={`publishing-defaults-form-${brand.id}`}
                  barTestId={`publishing-defaults-bar-${brand.id}`}
                  saveTestId={`publishing-defaults-save-${brand.id}`}
                  labels={saveBarLabels(t)}
                >
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="brandId" value={brand.id} />
                  <fieldset
                    style={{
                      border: 0,
                      margin: 0,
                      padding: 0,
                      display: 'grid',
                      gap: spacingTokens['2xs'],
                    }}
                  >
                    <legend style={{ ...typographyTokens.bodySm, fontWeight: 600 }}>
                      {t('publishingDefaults.channels')}
                    </legend>
                    <span style={hintStyle}>{t('publishingDefaults.channelsHint')}</span>
                    {platforms.map((platform) => (
                      <CheckboxRow
                        key={platform.key}
                        name="platformKeys"
                        value={platform.key}
                        label={platform.label}
                        checked={brand.defaultPlatformKeys.includes(platform.key)}
                        testId={`publishing-default-channel-${brand.id}-${platform.key}`}
                      />
                    ))}
                  </fieldset>
                  <Field
                    label={t('publishingDefaults.time')}
                    htmlFor={`publishing-default-time-${brand.id}`}
                    hint={t('publishingDefaults.timeHint')}
                  >
                    <input
                      className="bs-control"
                      type="time"
                      id={`publishing-default-time-${brand.id}`}
                      name="defaultPostTime"
                      data-testid={`publishing-default-time-${brand.id}`}
                      defaultValue={brand.defaultPostTime ?? ''}
                      style={inputStyle()}
                    />
                  </Field>
                  <CheckboxRow
                    name="hashtagsInFirstComment"
                    label={t('publishingDefaults.hashtags')}
                    hint={t('publishingDefaults.hashtagsHint')}
                    checked={brand.hashtagsInFirstComment}
                    testId={`publishing-default-hashtags-${brand.id}`}
                  />
                </DraftForm>
              </Card>

              <Card testId={`templates-${brand.id}`}>
                <SectionHeader
                  title={t('templates.title')}
                  description={
                    mayManageTemplates ? t('templates.body') : t('templates.bodyReadOnly')
                  }
                />
                {templates.length === 0 ? (
                  <StateMessage
                    title={t('templates.empty')}
                    description={
                      mayManageTemplates ? t('templates.emptyBody') : t('templates.emptyReadOnly')
                    }
                    testId={`templates-empty-${brand.id}`}
                  />
                ) : (
                  <ul style={listStyle}>
                    {templates.map((template) => (
                      <li
                        key={template.id}
                        data-testid={`template-${template.id}`}
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: spacingTokens.sm,
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          paddingBlock: spacingTokens.xs,
                          borderBlockEnd: `1px solid ${colorTokens.border}`,
                        }}
                      >
                        <span style={{ display: 'grid', gap: '0.125rem', minInlineSize: 0 }}>
                          <span
                            style={{
                              display: 'flex',
                              gap: spacingTokens.xs,
                              alignItems: 'center',
                            }}
                          >
                            <strong dir="auto" style={typographyTokens.bodySm}>
                              {template.name}
                            </strong>
                            {template.isDefault ? (
                              <StatusBadge
                                tone="info"
                                label={t('templates.default')}
                                testId={`template-default-${template.id}`}
                              />
                            ) : null}
                          </span>
                          <span style={hintStyle}>
                            {[
                              t(`content.type.${template.contentType}` as MessageKey),
                              template.platformKeys.map(labelOf).join(' · ') ||
                                t('templates.noChannels'),
                            ].join(' — ')}
                          </span>
                        </span>
                        {mayManageTemplates ? (
                          <span
                            style={{
                              display: 'flex',
                              flexWrap: 'wrap',
                              gap: spacingTokens.xs,
                              alignItems: 'center',
                            }}
                          >
                            <Link
                              href={`/${locale}/settings/publishing?edit=${template.id}#template-form-${brand.id}`}
                              style={buttonStyle('ghost', 'sm')}
                              className={buttonClass('ghost')}
                              data-testid={`template-edit-${template.id}`}
                            >
                              {t('templates.edit')}
                            </Link>
                            <form action={setDefaultTemplateAction}>
                              <input type="hidden" name="locale" value={locale} />
                              <input type="hidden" name="brandId" value={brand.id} />
                              <input
                                type="hidden"
                                name="templateId"
                                value={template.isDefault ? '' : template.id}
                              />
                              <button
                                type="submit"
                                style={buttonStyle('ghost', 'sm')}
                                className={buttonClass('ghost')}
                                data-testid={`template-set-default-${template.id}`}
                              >
                                {template.isDefault
                                  ? t('templates.clearDefault')
                                  : t('templates.makeDefault')}
                              </button>
                            </form>
                            {/* DELETE ASKS TWICE — the Automations screen's pattern. */}
                            <details data-testid={`template-delete-${template.id}`}>
                              <summary
                                style={{ ...buttonStyle('ghost', 'sm'), listStyle: 'none' }}
                                className={buttonClass('ghost')}
                              >
                                {t('templates.delete')}
                              </summary>
                              <form
                                action={deleteTemplateAction}
                                style={{
                                  display: 'grid',
                                  gap: spacingTokens.xs,
                                  marginBlockStart: spacingTokens.xs,
                                }}
                              >
                                <input type="hidden" name="locale" value={locale} />
                                <input type="hidden" name="templateId" value={template.id} />
                                <span style={hintStyle}>{t('templates.deleteBody')}</span>
                                <button
                                  type="submit"
                                  style={buttonStyle('danger', 'sm')}
                                  className={buttonClass('danger')}
                                  data-testid={`template-delete-confirm-${template.id}`}
                                >
                                  {t('templates.deleteConfirm')}
                                </button>
                              </form>
                            </details>
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}

                {mayManageTemplates ? (
                  <form
                    key={editing?.id ?? 'new'}
                    id={`template-form-${brand.id}`}
                    action={saveTemplateAction}
                    data-testid={`template-form-${brand.id}`}
                    style={{
                      display: 'grid',
                      gap: spacingTokens.sm,
                      marginBlockStart: spacingTokens.md,
                      paddingBlockStart: spacingTokens.md,
                      borderBlockStart: `1px solid ${colorTokens.border}`,
                    }}
                  >
                    <strong style={typographyTokens.bodySm}>
                      {editing ? t('templates.editTitle') : t('templates.newTitle')}
                    </strong>
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="brandId" value={brand.id} />
                    {editing ? (
                      <>
                        <input type="hidden" name="templateId" value={editing.id} />
                        <input type="hidden" name="expectedVersion" value={editing.version} />
                      </>
                    ) : null}
                    <Field label={t('templates.name')} htmlFor={`template-name-${brand.id}`}>
                      <input
                        className="bs-control"
                        id={`template-name-${brand.id}`}
                        name="name"
                        required
                        maxLength={80}
                        defaultValue={editing?.name ?? ''}
                        data-testid={`template-name-${brand.id}`}
                        style={inputStyle()}
                      />
                    </Field>
                    <Field label={t('templates.format')} htmlFor={`template-format-${brand.id}`}>
                      <select
                        className="bs-control bs-select"
                        id={`template-format-${brand.id}`}
                        name="contentType"
                        defaultValue={editing?.contentType ?? 'POST'}
                        data-testid={`template-format-${brand.id}`}
                        style={inputStyle()}
                      >
                        {CONTENT_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {t(`content.type.${type}` as MessageKey)}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <fieldset
                      style={{
                        border: 0,
                        margin: 0,
                        padding: 0,
                        display: 'grid',
                        gap: spacingTokens['2xs'],
                      }}
                    >
                      <legend style={{ ...typographyTokens.bodySm, fontWeight: 600 }}>
                        {t('templates.channels')}
                      </legend>
                      {platforms.map((platform) => (
                        <CheckboxRow
                          key={platform.key}
                          name="platformKeys"
                          value={platform.key}
                          label={platform.label}
                          checked={editing?.platformKeys.includes(platform.key) ?? false}
                          testId={`template-channel-${brand.id}-${platform.key}`}
                        />
                      ))}
                    </fieldset>
                    <Field
                      label={t('templates.caption')}
                      htmlFor={`template-body-${brand.id}`}
                      hint={t('templates.captionHint')}
                    >
                      <textarea
                        className="bs-control"
                        id={`template-body-${brand.id}`}
                        name="body"
                        maxLength={5000}
                        rows={4}
                        dir="auto"
                        defaultValue={editing?.body ?? ''}
                        data-testid={`template-body-${brand.id}`}
                        style={{ ...inputStyle(), minBlockSize: '6rem' }}
                      />
                    </Field>
                    <Field
                      label={t('templates.hashtags')}
                      htmlFor={`template-hashtags-${brand.id}`}
                      hint={t('templates.hashtagsHint')}
                    >
                      <input
                        className="bs-control"
                        id={`template-hashtags-${brand.id}`}
                        name="hashtags"
                        dir="auto"
                        defaultValue={editing?.hashtags.map((tag) => `#${tag}`).join(' ') ?? ''}
                        data-testid={`template-hashtags-${brand.id}`}
                        style={inputStyle()}
                      />
                    </Field>
                    <Field
                      label={t('templates.firstComment')}
                      htmlFor={`template-first-comment-${brand.id}`}
                    >
                      <textarea
                        className="bs-control"
                        id={`template-first-comment-${brand.id}`}
                        name="firstComment"
                        maxLength={2200}
                        rows={2}
                        dir="auto"
                        defaultValue={editing?.firstComment ?? ''}
                        data-testid={`template-first-comment-${brand.id}`}
                        style={inputStyle()}
                      />
                    </Field>
                    {editing ? null : (
                      <CheckboxRow
                        name="isDefault"
                        label={t('templates.makeDefaultOnSave')}
                        checked={templates.length === 0}
                        testId={`template-default-new-${brand.id}`}
                      />
                    )}
                    <span
                      style={{
                        display: 'flex',
                        gap: spacingTokens.xs,
                        flexWrap: 'wrap',
                        minBlockSize: layoutTokens.minTargetSize,
                      }}
                    >
                      <button
                        type="submit"
                        style={buttonStyle('primary', 'sm')}
                        className={buttonClass('primary')}
                        data-testid={`template-save-${brand.id}`}
                      >
                        {t('templates.save')}
                      </button>
                      {editing ? (
                        <Link
                          href={`/${locale}/settings/publishing`}
                          style={buttonStyle('ghost', 'sm')}
                          className={buttonClass('ghost')}
                        >
                          {t('templates.cancelEdit')}
                        </Link>
                      ) : null}
                    </span>
                  </form>
                ) : null}
              </Card>
            </div>
          );
        })}
      </SettingsFrame>
    </WorkspaceShell>
  );
}
