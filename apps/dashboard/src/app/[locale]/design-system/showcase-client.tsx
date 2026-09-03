'use client';

import { useState } from 'react';
import {
  AlertIcon,
  Banner,
  Button,
  ButtonRow,
  Card,
  Cell,
  ConfirmDialog,
  ContentGrid,
  CopilotBody,
  CopilotLauncher,
  CopilotPanel,
  DataTable,
  Dialog,
  DropdownMenu,
  Field,
  IconButton,
  MetricCard,
  Pagination,
  RecordList,
  SearchField,
  SectionHeader,
  SkeletonLines,
  SocialPostPreview,
  SocialPostPreviewer,
  Stack,
  StateMessage,
  StatusBadge,
  TabPanel,
  Tabs,
  Toast,
  Toolbar,
  Tooltip,
  SettingsIcon,
  colorTokens,
  inputStyle,
  menuItemStyle,
  spacingTokens,
  textareaStyle,
  typographyTokens,
  type CopilotState,
  type SocialPlatform,
} from '@brandspace/ui';
import {
  copilotLabels,
  sampleConversation,
  sampleProposedAction,
  samplePost,
  socialLabels,
  SHORT_CAPTION_EN,
} from './fixtures';

/**
 * The interactive half of the design showcase.
 *
 * A client component because half of what needs reviewing IS the behaviour —
 * a collapsed sidebar's tooltip, a dialog's focus trap, a caption that expands,
 * a Copilot panel that becomes a sheet. A screenshot of a closed dialog reviews
 * nothing.
 *
 * Every control here operates on local state. Nothing calls a server action,
 * touches a database or spends a credit.
 */

const PLATFORMS: readonly SocialPlatform[] = ['instagram', 'facebook', 'linkedin', 'x', 'tiktok'];

export function ShowcaseInteractive({ locale }: { readonly locale: string }) {
  const ar = locale === 'ar';
  const [tab, setTab] = useState('states');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [copilotState, setCopilotState] = useState<CopilotState>('idle');
  const post = samplePost(locale);
  const labels = socialLabels(locale);
  const cLabels = copilotLabels(locale);

  return (
    <Stack gap={spacingTokens.xl}>
      {/* ---------------------------------------------------- Buttons --- */}
      <Card title={ar ? 'الأزرار' : 'Buttons'} testId="showcase-buttons">
        <ButtonRow>
          <Button variant="primary">{ar ? 'إجراء أساسي' : 'Primary'}</Button>
          <Button variant="secondary">{ar ? 'ثانوي' : 'Secondary'}</Button>
          <Button variant="tertiary">{ar ? 'ثالثي' : 'Tertiary'}</Button>
          <Button variant="danger">{ar ? 'إجراء خطر' : 'Destructive'}</Button>
          <Button variant="primary" disabled>
            {ar ? 'معطّل' : 'Disabled'}
          </Button>
          <Tooltip label={ar ? 'الإعدادات' : 'Settings'}>
            <IconButton
              label={ar ? 'الإعدادات' : 'Settings'}
              variant="secondary"
              icon={<SettingsIcon size={18} />}
            />
          </Tooltip>
        </ButtonRow>
      </Card>

      {/* ------------------------------------------------------ Forms --- */}
      <Card title={ar ? 'النماذج' : 'Forms'} testId="showcase-forms">
        <div style={{ maxInlineSize: '28rem' }}>
          <Field label={ar ? 'الاسم' : 'Name'} htmlFor="demo-name" required>
            <input
              id="demo-name"
              style={inputStyle()}
              defaultValue={ar ? 'متجر نموذجي' : 'Sample Brand'}
            />
          </Field>
          <Field
            label={ar ? 'البريد الإلكتروني' : 'Email'}
            htmlFor="demo-email"
            hint={ar ? 'يُستخدم للإشعارات فقط.' : 'Used for notifications only.'}
          >
            <input id="demo-email" type="email" style={inputStyle()} />
          </Field>
          <Field
            label={ar ? 'المُعرّف' : 'Slug'}
            htmlFor="demo-slug"
            error={ar ? 'هذا المُعرّف مستخدم بالفعل.' : 'That slug is already taken.'}
          >
            <input
              id="demo-slug"
              style={inputStyle({ invalid: true })}
              defaultValue="sample-brand"
            />
          </Field>
          <Field label={ar ? 'ملاحظات' : 'Notes'} htmlFor="demo-notes">
            <textarea id="demo-notes" style={textareaStyle()} />
          </Field>
        </div>
      </Card>

      {/* --------------------------------------------------- Feedback --- */}
      <Card title={ar ? 'التنبيهات والحالات' : 'Feedback and states'} testId="showcase-feedback">
        <Stack gap={spacingTokens.md}>
          <Banner tone="success" testId="showcase-banner-success">
            {ar ? 'تم حفظ التغييرات.' : 'Your changes were saved.'}
          </Banner>
          <Banner tone="error" testId="showcase-banner-error">
            {ar ? 'تعذّر إكمال الطلب.' : 'The request could not be completed.'}
          </Banner>
          <Banner tone="warning" testId="showcase-banner-warning">
            {ar ? 'ستنتهي الفترة التجريبية قريبًا.' : 'The trial ends soon.'}
          </Banner>
          <Banner tone="info" testId="showcase-banner-info">
            {ar ? 'تُدار الخطط من لوحة تحكم المنصة.' : 'Plans are managed from Platform Admin.'}
          </Banner>
          <Toast tone="success" testId="showcase-toast">
            {ar ? 'أُرسلت الدعوة.' : 'Invitation sent.'}
          </Toast>

          <Tabs
            label={ar ? 'حالات المحتوى' : 'Content states'}
            activeId={tab}
            onSelect={setTab}
            testId="showcase-tabs"
            tabs={[
              { id: 'states', label: ar ? 'حالات فارغة' : 'Empty states' },
              { id: 'loading', label: ar ? 'التحميل' : 'Loading' },
              { id: 'badges', label: ar ? 'الشارات' : 'Badges', badge: '6' },
            ]}
          />
          <TabPanel id="states" activeId={tab}>
            <ContentGrid min="15rem">
              <StateMessage
                kind="empty"
                title={ar ? 'لا يوجد شيء بعد' : 'Nothing here yet'}
                description={ar ? 'أنشئ أول عنصر للبدء.' : 'Create the first item to begin.'}
                action={<Button size="sm">{ar ? 'إنشاء' : 'Create'}</Button>}
              />
              <StateMessage
                kind="no-results"
                title={ar ? 'لا توجد نتائج' : 'No results'}
                description={ar ? 'جرّب كلمات بحث أخرى.' : 'Try a different search.'}
              />
              <StateMessage
                kind="error"
                title={ar ? 'تعذّر التحميل' : 'Could not load'}
                description={ar ? 'حدث خطأ مؤقت.' : 'Something went wrong.'}
                action={
                  <Button size="sm" variant="secondary">
                    {ar ? 'إعادة المحاولة' : 'Retry'}
                  </Button>
                }
              />
              <StateMessage
                kind="forbidden"
                title={ar ? 'غير متاح لدورك' : 'Not available for your role'}
                description={
                  ar
                    ? 'تحتاج صلاحية إضافية لعرض هذا القسم.'
                    : 'You need an additional permission to see this section.'
                }
              />
            </ContentGrid>
          </TabPanel>
          <TabPanel id="loading" activeId={tab}>
            <div style={{ maxInlineSize: '30rem' }}>
              <SkeletonLines lines={4} />
            </div>
          </TabPanel>
          <TabPanel id="badges" activeId={tab}>
            <ButtonRow>
              <StatusBadge label="ACTIVE" tone="success" />
              <StatusBadge label="TRIALING" tone="warning" />
              <StatusBadge label="SUSPENDED" tone="danger" />
              <StatusBadge label="ARCHIVED" tone="neutral" />
              <StatusBadge label="INFO" tone="info" />
              <StatusBadge label={ar ? 'مميّز' : 'Featured'} tone="accent" />
            </ButtonRow>
          </TabPanel>
        </Stack>
      </Card>

      {/* --------------------------------------------------- Overlays --- */}
      <Card title={ar ? 'الطبقات الحوارية' : 'Overlays'} testId="showcase-overlays">
        <ButtonRow>
          <Button onClick={() => setDialogOpen(true)} data-testid="open-dialog">
            {ar ? 'فتح حوار' : 'Open dialog'}
          </Button>
          <Button variant="danger" onClick={() => setConfirmOpen(true)} data-testid="open-confirm">
            {ar ? 'إجراء يحتاج تأكيدًا' : 'Action needing confirmation'}
          </Button>
          <DropdownMenu
            label={ar ? 'إجراءات' : 'Actions'}
            testId="showcase-menu"
            triggerContent={ar ? 'إجراءات' : 'Actions'}
          >
            <button type="button" role="menuitem" style={menuItemStyle()}>
              {ar ? 'تعديل' : 'Edit'}
            </button>
            <button type="button" role="menuitem" style={menuItemStyle()}>
              {ar ? 'نسخ' : 'Duplicate'}
            </button>
            <button
              type="button"
              role="menuitem"
              style={{ ...menuItemStyle(), color: colorTokens.danger }}
            >
              {ar ? 'حذف' : 'Delete'}
            </button>
          </DropdownMenu>
        </ButtonRow>

        <Dialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          title={ar ? 'تفاصيل العنصر' : 'Item details'}
          description={ar ? 'حوار قياسي بمصيدة تركيز.' : 'A standard dialog with a focus trap.'}
          closeLabel={ar ? 'إغلاق' : 'Close'}
          footer={
            <Button variant="secondary" onClick={() => setDialogOpen(false)}>
              {ar ? 'إغلاق' : 'Close'}
            </Button>
          }
        >
          <Field label={ar ? 'الاسم' : 'Name'} htmlFor="dialog-name">
            <input id="dialog-name" style={inputStyle()} />
          </Field>
        </Dialog>

        <ConfirmDialog
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          onConfirm={() => setConfirmOpen(false)}
          title={ar ? 'إزالة العضو؟' : 'Remove this member?'}
          description={
            ar
              ? 'سيفقد الوصول إلى مساحة العمل فورًا. يمكن دعوته مرة أخرى لاحقًا.'
              : 'They lose access to the workspace immediately. You can invite them again later.'
          }
          confirmLabel={ar ? 'إزالة' : 'Remove'}
          cancelLabel={ar ? 'إلغاء' : 'Cancel'}
          closeLabel={ar ? 'إغلاق' : 'Close'}
        />
      </Card>

      {/* ------------------------------------------------------ Table --- */}
      <Card title={ar ? 'الجداول' : 'Tables'} testId="showcase-table">
        <Toolbar>
          <SearchField id="showcase-search" label={ar ? 'بحث' : 'Search'} />
          <Button variant="secondary" size="sm">
            {ar ? 'تصفية' : 'Filter'}
          </Button>
        </Toolbar>
        <div className="bs-wide-only">
          <DataTable
            headers={[ar ? 'الاسم' : 'Name', ar ? 'الحالة' : 'Status', ar ? 'الدور' : 'Role']}
            caption={ar ? 'أعضاء نموذجيون' : 'Sample members'}
            testId="showcase-data-table"
          >
            {SAMPLE_ROWS.map((row) => (
              <tr key={row.id}>
                <Cell>{row.name}</Cell>
                <Cell>
                  <StatusBadge label={row.status} tone={row.tone} />
                </Cell>
                <Cell>{ar ? row.roleAr : row.roleEn}</Cell>
              </tr>
            ))}
          </DataTable>
        </div>
        <div className="bs-narrow-only">
          <RecordList
            testId="showcase-record-list"
            records={SAMPLE_ROWS.map((row) => ({
              id: row.id,
              title: row.name,
              fields: [
                {
                  label: ar ? 'الحالة' : 'Status',
                  value: <StatusBadge label={row.status} tone={row.tone} />,
                },
                { label: ar ? 'الدور' : 'Role', value: ar ? row.roleAr : row.roleEn },
              ],
            }))}
          />
        </div>
        <Pagination
          page={2}
          pageCount={5}
          hrefForPage={(page) => `?page=${page}`}
          labels={{
            navigation: ar ? 'ترقيم الصفحات' : 'Pagination',
            previous: ar ? 'السابق' : 'Previous',
            next: ar ? 'التالي' : 'Next',
            summary: ar ? 'صفحة ٢ من ٥' : 'Page 2 of 5',
          }}
        />
      </Card>

      {/* ---------------------------------------------- Social preview --- */}
      <Card title={ar ? 'معاينة المنشور' : 'Social post preview'} testId="showcase-social">
        <SectionHeader
          title={ar ? 'مبدّل المنصة والنسبة' : 'Platform and aspect switcher'}
          description={labels.previewNotice}
        />
        <SocialPostPreviewer content={post} labels={labels} platforms={PLATFORMS} />

        <SectionHeader
          title={ar ? 'الحالات' : 'States'}
          description={ar ? 'حالات النشر والوسائط.' : 'Publishing and media states.'}
        />
        <ContentGrid min="18rem" gap={spacingTokens.lg}>
          <SocialPostPreview
            testId="preview-published-square"
            labels={labels}
            content={{ ...post, platform: 'linkedin', aspect: '1:1', status: 'PUBLISHED' }}
          />
          <SocialPostPreview
            testId="preview-story"
            labels={labels}
            content={{
              ...post,
              platform: 'tiktok',
              aspect: '9:16',
              status: 'DRAFT',
              media: { kind: 'video', alt: ar ? 'مقطع' : 'Clip', durationLabel: '0:18' },
            }}
          />
          <SocialPostPreview
            testId="preview-failed-missing"
            labels={labels}
            content={{
              ...post,
              platform: 'x',
              aspect: '16:9',
              status: 'FAILED',
              media: { kind: 'missing' },
              caption: SHORT_CAPTION_EN,
              captionDirection: 'ltr',
            }}
          />
          <SocialPostPreview
            testId="preview-loading"
            labels={labels}
            content={{
              ...post,
              platform: 'facebook',
              aspect: '4:5',
              status: 'SCHEDULED',
              media: { kind: 'loading' },
            }}
          />
          {/* The opposite script, so both directions are reviewable at once. */}
          <SocialPostPreview
            testId="preview-opposite-script"
            labels={labels}
            content={{
              ...post,
              platform: 'instagram',
              aspect: '1:1',
              caption: ar ? SHORT_CAPTION_EN : 'محتوى عربي داخل واجهة إنجليزية.',
              captionDirection: ar ? 'ltr' : 'rtl',
            }}
          />
          <SocialPostPreview
            testId="preview-desktop-surface"
            surface="desktop"
            labels={labels}
            content={{ ...post, platform: 'linkedin', aspect: '16:9' }}
          />
        </ContentGrid>
      </Card>

      {/* ---------------------------------------------------- Copilot --- */}
      <Card title={ar ? 'مساعد الذكاء الاصطناعي' : 'AI Copilot shell'} testId="showcase-copilot">
        <SectionHeader title={cLabels.title} description={cLabels.disabledNotice} />
        <ButtonRow>
          <CopilotLauncher
            label={cLabels.open}
            onOpen={() => setCopilotOpen(true)}
            expanded={copilotOpen}
          />
          {(['idle', 'streaming', 'error', 'insufficient-credits', 'approval'] as const).map(
            (state) => (
              <Button
                key={state}
                size="sm"
                variant={copilotState === state ? 'primary' : 'secondary'}
                onClick={() => setCopilotState(state)}
                data-testid={`copilot-state-${state}`}
              >
                {state}
              </Button>
            ),
          )}
        </ButtonRow>

        {/* The same body, inline, so the states are reviewable without opening
            the panel — and so a screenshot can capture them. */}
        <div
          data-testid="copilot-inline"
          style={{
            marginBlockStart: spacingTokens.md,
            blockSize: '28rem',
            maxInlineSize: '26rem',
            border: `1px solid ${colorTokens.cardBorder}`,
            borderRadius: spacingTokens.sm,
            overflow: 'hidden',
          }}
        >
          <CopilotBody
            labels={cLabels}
            state={copilotState}
            messages={sampleConversation(locale)}
            suggestions={[
              ar ? 'أعد صياغة أقصر' : 'Make it shorter',
              ar ? 'أضف دعوة لاتخاذ إجراء' : 'Add a call to action',
            ]}
            attachments={[ar ? 'دليل-العلامة.pdf' : 'brand-guide.pdf']}
            proposedAction={copilotState === 'approval' ? sampleProposedAction(locale) : undefined}
            disabled
          />
        </div>

        <CopilotPanel open={copilotOpen} onClose={() => setCopilotOpen(false)} labels={cLabels}>
          <CopilotBody
            labels={cLabels}
            state={copilotState}
            messages={sampleConversation(locale)}
            suggestions={[ar ? 'أعد صياغة أقصر' : 'Make it shorter']}
            proposedAction={copilotState === 'approval' ? sampleProposedAction(locale) : undefined}
            disabled
          />
        </CopilotPanel>
      </Card>

      {/* ---------------------------------------------------- Metrics --- */}
      <Card title={ar ? 'بطاقات القياس' : 'Metric cards'} testId="showcase-metrics">
        <ContentGrid min="13rem">
          <MetricCard label={ar ? 'الأعضاء' : 'Members'} value="12" />
          <MetricCard
            label={ar ? 'الرصيد' : 'Credits'}
            value="4,820"
            hint={ar ? 'أرصدة كاملة' : 'Whole credits'}
            accent
          />
          <MetricCard
            label={ar ? 'المنشور اليوم' : 'Published today'}
            unavailable
            unavailableLabel={ar ? 'يتوفر لاحقًا' : 'Available later'}
          />
        </ContentGrid>
        <p
          style={{
            marginBlockStart: spacingTokens.md,
            display: 'flex',
            gap: spacingTokens.xs,
            alignItems: 'center',
            ...typographyTokens.caption,
            color: colorTokens.textSecondary,
          }}
        >
          <AlertIcon size={14} />
          {ar
            ? 'كل الأرقام هنا بيانات عرض ثابتة، وليست قياسات حقيقية.'
            : 'Every figure here is fixed showcase data, not a real measurement.'}
        </p>
      </Card>
    </Stack>
  );
}

const SAMPLE_ROWS = [
  {
    id: '1',
    name: 'amal@example.test',
    status: 'ACTIVE',
    tone: 'success' as const,
    roleEn: 'Workspace Owner',
    roleAr: 'مالك مساحة العمل',
  },
  {
    id: '2',
    name: 'noor@example.test',
    status: 'ACTIVE',
    tone: 'success' as const,
    roleEn: 'Marketing Manager',
    roleAr: 'مدير التسويق',
  },
  {
    id: '3',
    name: 'sami@example.test',
    status: 'PENDING',
    tone: 'warning' as const,
    roleEn: 'Analyst',
    roleAr: 'محلل',
  },
];
