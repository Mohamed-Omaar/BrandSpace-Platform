'use client';

import { useState } from 'react';
import {
  AlertIcon,
  Banner,
  Button,
  ButtonRow,
  CalendarIcon,
  Card,
  Cell,
  ConfirmDialog,
  ContentGrid,
  ContentCalendar,
  CopilotBody,
  CopilotLauncher,
  CopilotPanel,
  CreditIcon,
  DataTable,
  DesignStudio,
  Dialog,
  DropdownMenu,
  FeatureCard,
  Field,
  IconButton,
  ImageIcon,
  LayersIcon,
  ListIcon,
  MetricCard,
  Pagination,
  PostComposer,
  PostDetailDrawer,
  PostGridCard,
  PostListRow,
  PulseIcon,
  RecordList,
  SearchField,
  SectionHeader,
  SkeletonLines,
  SocialPostPreview,
  SocialPostPreviewer,
  SparkIcon,
  Stack,
  StateMessage,
  StatusBadge,
  TabPanel,
  Tabs,
  TeamIcon,
  Toast,
  Toolbar,
  Tooltip,
  RouteIcon,
  SettingsIcon,
  ShieldIcon,
  colorTokens,
  inputStyle,
  menuItemStyle,
  radiusTokens,
  shadowTokens,
  spacingTokens,
  textareaStyle,
  typographyTokens,
  type CopilotState,
  type CopilotSurface,
  type PostRecord,
  type SocialPlatform,
} from '@brandspace/ui';
import {
  calendarDays,
  calendarLabels,
  calendarPeriodLabel,
  composerAccounts,
  composerApprovers,
  composerCampaigns,
  composerCaption,
  composerLabels,
  copilotLabels,
  copilotSuggestions,
  featureFixtures,
  featureLabels,
  postCardLabels,
  postDetailLabels,
  postFixtures,
  previewVariants,
  sampleConversation,
  sampleProposedAction,
  sampleTools,
  samplePost,
  socialLabels,
  studioDocumentName,
  studioLabels,
  SHORT_CAPTION_EN,
} from './fixtures';
import type { ReactNode } from 'react';

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
 *
 * THE PROTOTYPE SCREENS (features hub, calendar, posts library, composer,
 * Design Studio) live HERE and only here. They are complete compositions so the
 * owner can judge the visual direction on a real screen rather than on a
 * component gallery — but they are behind the same `showcaseEnabled()` gate as
 * everything else on this page, they are linked from no navigation, and every
 * one of them says on its face that it performs nothing.
 */

const PLATFORMS: readonly SocialPlatform[] = ['instagram', 'facebook', 'linkedin', 'x', 'tiktok'];

/** Icons for the features hub, keyed by the fixture's id. */
const FEATURE_ICONS: Record<string, ReactNode> = {
  social: <RouteIcon size={18} />,
  calendar: <CalendarIcon size={18} />,
  library: <ListIcon size={18} />,
  composer: <ImageIcon size={18} />,
  studio: <LayersIcon size={18} />,
  copilot: <SparkIcon size={18} />,
  'brand-kit': <ShieldIcon size={18} />,
  media: <ImageIcon size={18} />,
  analytics: <PulseIcon size={18} />,
  team: <TeamIcon size={18} />,
  automations: <SettingsIcon size={18} />,
};

/**
 * The status tabs of the posts library, and what each one selects.
 *
 * `archived` deliberately matches nothing: there is no archived fixture, and a
 * tab that quietly shows the same eight posts as every other tab would be a
 * decorative control. It shows the empty state instead.
 */
const LIBRARY_TABS = [
  'all',
  'drafts',
  'approval',
  'scheduled',
  'published',
  'failed',
  'archived',
] as const;

type LibraryTab = (typeof LIBRARY_TABS)[number];

function libraryTabLabel(tab: LibraryTab, ar: boolean): string {
  switch (tab) {
    case 'all':
      return ar ? 'الكل' : 'All';
    case 'drafts':
      return ar ? 'مسودات' : 'Drafts';
    case 'approval':
      return ar ? 'بانتظار الموافقة' : 'Needs approval';
    case 'scheduled':
      return ar ? 'مجدول' : 'Scheduled';
    case 'published':
      return ar ? 'منشور' : 'Published';
    case 'failed':
      return ar ? 'فشل' : 'Failed';
    case 'archived':
      return ar ? 'مؤرشف' : 'Archived';
  }
}

/**
 * The library tab that actually contains a record.
 *
 * "View in library" must never land on an empty panel, so the tab is derived
 * from the record rather than assumed — and `all` is the honest fallback for a
 * status the library does not give a tab of its own.
 */
function tabForStatus(post: PostRecord): LibraryTab {
  switch (post.status) {
    case 'DRAFT':
      return 'drafts';
    case 'SCHEDULED':
      return 'scheduled';
    case 'PUBLISHED':
      return 'published';
    case 'FAILED':
      return 'failed';
    default:
      return 'all';
  }
}

function filterPosts(posts: readonly PostRecord[], tab: LibraryTab): readonly PostRecord[] {
  switch (tab) {
    case 'all':
      return posts;
    case 'drafts':
      return posts.filter((post) => post.status === 'DRAFT');
    case 'approval':
      return posts.filter((post) => post.approval === 'NEEDS_APPROVAL');
    case 'scheduled':
      return posts.filter((post) => post.status === 'SCHEDULED');
    case 'published':
      return posts.filter((post) => post.status === 'PUBLISHED');
    case 'failed':
      return posts.filter((post) => post.status === 'FAILED');
    case 'archived':
      return [];
  }
}

/** A banner every prototype screen carries, so no screenshot can mislead. */
function PrototypeNotice({ ar, testId }: { readonly ar: boolean; readonly testId: string }) {
  return (
    <Banner tone="warning" testId={testId}>
      {ar
        ? 'شاشة نموذجية للمراجعة البصرية فقط. لا تتصل بقاعدة بيانات أو منصة، ولا ينفّذ أي زر فيها إجراءً حقيقيًا.'
        : 'A prototype screen, for visual review only. It connects to no database and no platform, and no control on it performs a real action.'}
    </Banner>
  );
}

export function ShowcaseInteractive({ locale }: { readonly locale: string }) {
  const ar = locale === 'ar';
  const [tab, setTab] = useState('states');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [copilotState, setCopilotState] = useState<CopilotState>('idle');
  const [copilotSurface, setCopilotSurface] = useState<CopilotSurface>('composer');
  const [libraryTab, setLibraryTab] = useState<LibraryTab>('all');
  const [selectedPosts, setSelectedPosts] = useState<readonly string[]>([]);

  /*
   * CALENDAR → POST DETAILS → COMPOSER, wired for real.
   *
   * §9 is explicit: every visible post must be clickable, clicking it must
   * open its details, and the details must lead somewhere — "no dead cards or
   * buttons". Inside this gated prototype that chain is genuine state rather
   * than a mock-up of one: opening a chip opens the panel for THAT record,
   * "view in library" switches the library to the tab that contains it and
   * highlights it, and "edit post" loads its caption, its direction and its
   * artwork into the composer.
   *
   * WHAT IT IS NOT is a substitute for a backend. There is no Post model, no
   * migration and no route — the records are the same clearly-labelled preview
   * fixtures the rest of this page uses, and nothing here writes anything.
   */
  const [openPostId, setOpenPostId] = useState<string | null>(null);
  const [editingPostId, setEditingPostId] = useState<string | null>(null);
  const [highlightedPostId, setHighlightedPostId] = useState<string | null>(null);

  const post = samplePost(locale);
  const labels = socialLabels(locale);
  const cLabels = copilotLabels(locale);
  const posts = postFixtures(locale);
  const pcLabels = postCardLabels(locale);
  const pdLabels = postDetailLabels(locale);

  const openPost = posts.find((record) => record.id === openPostId) ?? null;
  const editingPost = posts.find((record) => record.id === editingPostId) ?? null;

  /** Scroll a section into view after the state that reveals it has settled. */
  const revealSection = (id: string) => {
    // `requestAnimationFrame` rather than a timeout: the target may only exist
    // after the state change above renders, and a fixed delay is a guess.
    requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  };

  const viewInLibrary = (record: PostRecord) => {
    // Switch to a tab that actually contains the record, so "view in library"
    // never lands on an empty panel.
    setLibraryTab(tabForStatus(record));
    setHighlightedPostId(record.id);
    setOpenPostId(null);
    revealSection('showcase-library-anchor');
  };

  const editInComposer = (record: PostRecord) => {
    setEditingPostId(record.id);
    setOpenPostId(null);
    revealSection('showcase-composer-anchor');
  };

  const toggleSelected = (id: string) =>
    setSelectedPosts((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );

  /** The Copilot body, wired to whichever surface the reviewer picked. */
  const copilotBody = (surface: CopilotSurface, testId?: string) => (
    <CopilotBody
      labels={cLabels}
      state={copilotState}
      messages={sampleConversation(locale)}
      suggestions={copilotSuggestions(locale, surface)}
      tools={sampleTools(locale)}
      context={{
        surface,
        subject: ar ? 'إطلاق المجموعة — ١٢ مارس' : 'Collection launch — 12 Mar',
      }}
      attachments={testId ? [ar ? 'دليل-العلامة.pdf' : 'brand-guide.pdf'] : []}
      proposedAction={copilotState === 'approval' ? sampleProposedAction(locale) : undefined}
      disabled
    />
  );

  return (
    <Stack gap={spacingTokens.xl}>
      {/* ---------------------------------------------------- Buttons --- */}
      <Card title={ar ? 'الأزرار' : 'Buttons'} testId="showcase-buttons">
        <ButtonRow>
          <Button variant="primary">{ar ? 'إجراء أساسي' : 'Primary'}</Button>
          <Button variant="accent">{ar ? 'إجراء مميّز' : 'Accent'}</Button>
          <Button variant="neutral">{ar ? 'محايد' : 'Neutral'}</Button>
          <Button variant="ghost">{ar ? 'شفاف' : 'Ghost'}</Button>
          <Button variant="danger">{ar ? 'إجراء خطر' : 'Destructive'}</Button>
          <Button variant="primary" disabled>
            {ar ? 'معطّل' : 'Disabled'}
          </Button>
          <Button variant="primary" loading loadingLabel={ar ? 'جارٍ الحفظ' : 'Saving'}>
            {ar ? 'حفظ' : 'Save'}
          </Button>
          <Tooltip label={ar ? 'الإعدادات' : 'Settings'}>
            <IconButton
              label={ar ? 'الإعدادات' : 'Settings'}
              variant="neutral"
              circular
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
              className="bs-control"
              style={inputStyle()}
              defaultValue={ar ? 'متجر نموذجي' : 'Sample Brand'}
            />
          </Field>
          <Field
            label={ar ? 'البريد الإلكتروني' : 'Email'}
            htmlFor="demo-email"
            hint={ar ? 'يُستخدم للإشعارات فقط.' : 'Used for notifications only.'}
          >
            <input id="demo-email" type="email" className="bs-control" style={inputStyle()} />
          </Field>
          <Field
            label={ar ? 'المُعرّف' : 'Slug'}
            htmlFor="demo-slug"
            error={ar ? 'هذا المُعرّف مستخدم بالفعل.' : 'That slug is already taken.'}
          >
            <input
              id="demo-slug"
              className="bs-control"
              style={inputStyle({ tone: 'error' })}
              defaultValue="sample-brand"
            />
          </Field>
          <Field
            label={ar ? 'اسم مساحة العمل' : 'Workspace name'}
            htmlFor="demo-ok"
            success={ar ? 'الاسم متاح.' : 'That name is available.'}
          >
            <input
              id="demo-ok"
              className="bs-control"
              style={inputStyle({ tone: 'success' })}
              defaultValue={ar ? 'متجر نموذجي' : 'Sample Brand'}
            />
          </Field>
          <Field
            label={ar ? 'ملاحظات' : 'Notes'}
            htmlFor="demo-notes"
            optionalLabel={ar ? 'اختياري' : 'Optional'}
          >
            <textarea id="demo-notes" className="bs-control" style={textareaStyle()} />
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
                  <Button size="sm" variant="neutral">
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
              <StatusBadge label="ACTIVE" tone="success" dot />
              <StatusBadge label="TRIALING" tone="warning" dot />
              <StatusBadge label="SUSPENDED" tone="danger" dot />
              <StatusBadge label="ARCHIVED" tone="neutral" dot />
              <StatusBadge label="INFO" tone="info" dot />
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
            <Button variant="neutral" onClick={() => setDialogOpen(false)}>
              {ar ? 'إغلاق' : 'Close'}
            </Button>
          }
        >
          <Field label={ar ? 'الاسم' : 'Name'} htmlFor="dialog-name">
            <input id="dialog-name" className="bs-control" style={inputStyle()} />
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
          <Button variant="neutral" size="sm">
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
              <tr key={row.id} className="bs-row">
                <Cell>{row.name}</Cell>
                <Cell>
                  <StatusBadge label={row.status} tone={row.tone} dot />
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
                  value: <StatusBadge label={row.status} tone={row.tone} dot />,
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
          title={ar ? 'مبدّل المنصة والصيغة' : 'Platform and format switcher'}
          description={labels.previewNotice}
        />
        <SocialPostPreviewer content={post} labels={labels} platforms={PLATFORMS} />

        <SectionHeader
          title={ar ? 'الصيغ المطلوبة' : 'The required variants'}
          description={
            ar
              ? 'كل صيغة تركيبة مختلفة، لا البطاقة نفسها بشارة مختلفة.'
              : 'Each variant is a different composition, not the same card with a different badge.'
          }
        />
        <ContentGrid min="17rem" gap={spacingTokens.lg}>
          {previewVariants(locale).map((variant) => (
            <div key={variant.key} style={{ display: 'grid', gap: spacingTokens.xs }}>
              <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
                {variant.title}
              </span>
              <SocialPostPreview
                testId={`preview-${variant.key}`}
                labels={labels}
                content={variant.content}
              />
            </div>
          ))}
        </ContentGrid>

        <SectionHeader
          title={ar ? 'حالات الوسائط والاتجاه' : 'Media and direction states'}
          description={
            ar
              ? 'التحميل، والوسائط الغائبة، والنص المعاكس.'
              : 'Loading, missing media, and the opposite script.'
          }
        />
        <ContentGrid min="17rem" gap={spacingTokens.lg}>
          <SocialPostPreview
            testId="preview-loading"
            labels={labels}
            content={{ ...post, media: { kind: 'loading' } }}
          />
          {/* The opposite script, so both directions are reviewable at once. */}
          <SocialPostPreview
            testId="preview-opposite-script"
            labels={labels}
            content={{
              ...post,
              aspect: '1:1',
              caption: ar ? SHORT_CAPTION_EN : 'محتوى عربي داخل واجهة إنجليزية.',
              captionDirection: ar ? 'ltr' : 'rtl',
            }}
          />
          {/*
            A landscape post. The preview no longer has a "desktop surface"
            width: the demo draws it at 340px in a fixed column and the
            composition was measured there, so it holds that width everywhere.
          */}
          <SocialPostPreview
            testId="preview-landscape"
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
                variant={copilotState === state ? 'primary' : 'neutral'}
                onClick={() => setCopilotState(state)}
                data-testid={`copilot-state-${state}`}
              >
                {state}
              </Button>
            ),
          )}
        </ButtonRow>

        {/* The Copilot is CONTEXTUAL: each surface offers only the actions that
            surface can serve, so the chip set changes with the context. */}
        <ButtonRow>
          {(['calendar', 'posts', 'composer', 'studio'] as const).map((surface) => (
            <Button
              key={surface}
              size="sm"
              variant={copilotSurface === surface ? 'accent' : 'neutral'}
              onClick={() => setCopilotSurface(surface)}
              data-testid={`copilot-surface-${surface}`}
            >
              {cLabels.surfaceNames[surface]}
            </Button>
          ))}
        </ButtonRow>

        {/* The same body, inline, so the states are reviewable without opening
            the panel — and so a screenshot can capture them. */}
        <div
          data-testid="copilot-inline"
          style={{
            marginBlockStart: spacingTokens.md,
            blockSize: '34rem',
            maxInlineSize: '26rem',
            borderRadius: radiusTokens.xl,
            background: colorTokens.surface,
            boxShadow: shadowTokens.raised,
            overflow: 'hidden',
          }}
        >
          {copilotBody(copilotSurface, 'inline')}
        </div>

        <CopilotPanel open={copilotOpen} onClose={() => setCopilotOpen(false)} labels={cLabels}>
          {copilotBody(copilotSurface)}
        </CopilotPanel>
      </Card>

      {/* ---------------------------------------------------- Metrics --- */}
      <Card title={ar ? 'بطاقات القياس' : 'Metric cards'} testId="showcase-metrics">
        <ContentGrid min="13rem">
          <MetricCard label={ar ? 'الأعضاء' : 'Members'} value="12" icon={<TeamIcon size={16} />} />
          <MetricCard
            label={ar ? 'منشورات مجدولة' : 'Scheduled posts'}
            value="7"
            icon={<CalendarIcon size={16} />}
            accent
          />
          {/*
            NO CREDIT BALANCE AND NO ANALYTICS FIGURE. Both are configuration
            and measurement the platform does not have yet (CLAUDE.md §2.2), so
            the cards state that the value is unavailable rather than showing a
            plausible number on a screenshot the owner is asked to approve.
          */}
          <MetricCard
            label={ar ? 'رصيد الذكاء الاصطناعي' : 'AI credits'}
            icon={<CreditIcon size={16} />}
            unavailable
            unavailableLabel={ar ? 'يُدار من لوحة المنصة' : 'Managed from Platform Admin'}
          />
          <MetricCard
            label={ar ? 'المشاهدات هذا الأسبوع' : 'Views this week'}
            icon={<PulseIcon size={16} />}
            unavailable
            unavailableLabel={
              ar ? 'يتوفر بعد ربط المنصات' : 'Available once platforms are connected'
            }
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

      {/* ------------------------------------------------ Features hub --- */}
      <Card title={ar ? 'مركز المزايا' : 'Features hub'} testId="showcase-features">
        <PrototypeNotice ar={ar} testId="features-prototype-notice" />
        <SectionHeader
          title={ar ? 'ما تستطيع مساحة العمل فعله' : 'What this workspace can do'}
          description={
            ar
              ? 'حالة كل ميزة هي حالتها الحقيقية في هذه المرحلة. لا خطط ولا أسعار ولا حصص — كلها إعدادات تُدار من لوحة المنصة.'
              : 'Each feature carries its honest state in this phase. No plan, price or quota appears: all of those are configuration owned by Platform Admin.'
          }
          icon={<LayersIcon size={16} />}
        />
        <ContentGrid min="17rem">
          {featureFixtures(locale).map((feature) => (
            <FeatureCard
              key={feature.id}
              testId={`feature-${feature.id}`}
              name={feature.name}
              description={feature.description}
              icon={FEATURE_ICONS[feature.id] ?? <LayersIcon size={18} />}
              state={feature.state}
              labels={featureLabels(locale)}
              lockedReason={feature.lockedReason}
              action={
                feature.state === 'enabled' ? (
                  <Button size="sm" variant="neutral">
                    {ar ? 'فتح' : 'Open'}
                  </Button>
                ) : undefined
              }
            />
          ))}
        </ContentGrid>
      </Card>

      {/* --------------------------------------------------- Calendar --- */}
      <Card
        title={ar ? 'تقويم المحتوى' : 'Content calendar'}
        testId="showcase-calendar"
        padded={false}
      >
        <div style={{ padding: spacingTokens.md, display: 'grid', gap: spacingTokens.md }}>
          <PrototypeNotice ar={ar} testId="calendar-prototype-notice" />
          <ContentCalendar
            testId="prototype-calendar"
            periodLabel={calendarPeriodLabel(locale)}
            days={calendarDays(locale)}
            labels={calendarLabels(locale)}
            onOpenPost={(record) => setOpenPostId(record.id)}
            createAction={
              // Not decorative: it opens the composer, which is on this page.
              <Button
                size="sm"
                data-testid="calendar-create-post"
                onClick={() => {
                  setEditingPostId(null);
                  revealSection('showcase-composer-anchor');
                }}
              >
                {ar ? 'إنشاء منشور' : 'Create post'}
              </Button>
            }
            filters={
              <>
                <SearchField id="calendar-search" label={ar ? 'بحث' : 'Search'} />
                {[
                  ar ? 'كل المنصات' : 'All platforms',
                  ar ? 'كل الحسابات' : 'All accounts',
                  ar ? 'كل الحملات' : 'All campaigns',
                  ar ? 'كل الحالات' : 'All statuses',
                ].map((filter) => (
                  <Button key={filter} size="sm" variant="neutral">
                    {filter}
                  </Button>
                ))}
              </>
            }
          />
        </div>
      </Card>

      {/* --------------------------------------------- Posts library --- */}
      <span id="showcase-library-anchor" aria-hidden="true" />
      <Card title={ar ? 'مكتبة المنشورات' : 'Posts library'} testId="showcase-library">
        <PrototypeNotice ar={ar} testId="library-prototype-notice" />
        <Toolbar>
          <SearchField id="library-search" label={ar ? 'بحث في المنشورات' : 'Search posts'} />
          {[
            ar ? 'المنصة' : 'Platform',
            ar ? 'الحساب' : 'Account',
            ar ? 'الحملة' : 'Campaign',
            ar ? 'التاريخ' : 'Date',
            ar ? 'الترتيب: الأحدث' : 'Sort: newest',
          ].map((filter) => (
            <Button key={filter} size="sm" variant="neutral">
              {filter}
            </Button>
          ))}
        </Toolbar>

        <Tabs
          label={ar ? 'حالة المنشور' : 'Post status'}
          activeId={libraryTab}
          onSelect={(id) => setLibraryTab(id as LibraryTab)}
          testId="library-tabs"
          tabs={LIBRARY_TABS.map((tabId) => ({
            id: tabId,
            label: libraryTabLabel(tabId, ar),
            badge: String(filterPosts(posts, tabId).length),
          }))}
        />

        {/* The bulk-selection state, which only appears once something is chosen. */}
        {selectedPosts.length > 0 ? (
          <div
            data-testid="library-bulk-bar"
            style={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: spacingTokens.sm,
              marginBlock: spacingTokens.md,
              padding: spacingTokens.sm,
              paddingInline: spacingTokens.md,
              borderRadius: radiusTokens.lg,
              background: colorTokens.surfaceLavender,
            }}
          >
            <span style={{ ...typographyTokens.label, color: colorTokens.textPrimary }}>
              {ar ? `${selectedPosts.length} محدد` : `${selectedPosts.length} selected`}
            </span>
            <ButtonRow align="end">
              <Button size="sm" variant="neutral">
                {ar ? 'إضافة إلى حملة' : 'Add to campaign'}
              </Button>
              <Button size="sm" variant="neutral">
                {ar ? 'أرشفة' : 'Archive'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelectedPosts([])}>
                {ar ? 'إلغاء التحديد' : 'Clear selection'}
              </Button>
            </ButtonRow>
          </div>
        ) : null}

        {/*
          A REAL FILTER, not a decorative tab strip. The status tabs select
          from the fixture set client-side: an "Archived" tab with no archived
          records shows the empty state rather than the same eight posts under
          a different heading. It also gives every `aria-controls` a panel that
          exists — axe reported the dangling reference when the tabs had none.
        */}
        {LIBRARY_TABS.map((tabId) => {
          const shown = filterPosts(posts, tabId);
          return (
            <TabPanel key={tabId} id={tabId} activeId={libraryTab}>
              {shown.length === 0 ? (
                <StateMessage
                  kind="no-results"
                  title={ar ? 'لا منشورات في هذه الحالة' : 'No posts in this state'}
                  description={
                    ar
                      ? 'غيّر الحالة أعلاه لعرض منشورات أخرى.'
                      : 'Choose another status above to see other posts.'
                  }
                />
              ) : (
                <>
                  <SectionHeader
                    title={ar ? 'عرض شبكي' : 'Grid view'}
                    description={
                      ar
                        ? 'لا تظهر أرقام أداء: لم تُربط أي منصة بعد.'
                        : 'No performance figures appear: no platform is connected yet.'
                    }
                  />
                  <ContentGrid min="15rem">
                    {shown.slice(0, 4).map((record) => (
                      <PostGridCard
                        key={record.id}
                        post={record}
                        labels={pcLabels}
                        onOpen={() => setOpenPostId(record.id)}
                        selected={
                          selectedPosts.includes(record.id) || highlightedPostId === record.id
                        }
                        actions={
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => toggleSelected(record.id)}
                          >
                            {selectedPosts.includes(record.id)
                              ? ar
                                ? 'إلغاء'
                                : 'Deselect'
                              : ar
                                ? 'تحديد'
                                : 'Select'}
                          </Button>
                        }
                      />
                    ))}
                  </ContentGrid>

                  {shown.length > 4 ? (
                    <>
                      <SectionHeader title={ar ? 'عرض قائمة' : 'List view'} />
                      <Stack gap={spacingTokens.xs}>
                        {shown.slice(4).map((record) => (
                          <PostListRow
                            key={record.id}
                            post={record}
                            labels={pcLabels}
                            onOpen={() => setOpenPostId(record.id)}
                            selected={
                              selectedPosts.includes(record.id) || highlightedPostId === record.id
                            }
                            actions={
                              <DropdownMenu
                                label={ar ? 'إجراءات المنشور' : 'Post actions'}
                                triggerContent="⋯"
                                testId={`library-menu-${record.id}`}
                              >
                                <button type="button" role="menuitem" style={menuItemStyle()}>
                                  {ar ? 'تعديل' : 'Edit'}
                                </button>
                                <button type="button" role="menuitem" style={menuItemStyle()}>
                                  {ar ? 'نسخ' : 'Duplicate'}
                                </button>
                                <button type="button" role="menuitem" style={menuItemStyle()}>
                                  {ar ? 'أرشفة' : 'Archive'}
                                </button>
                              </DropdownMenu>
                            }
                          />
                        ))}
                      </Stack>
                    </>
                  ) : null}
                </>
              )}
            </TabPanel>
          );
        })}
      </Card>

      {/* --------------------------------------------------- Composer --- */}
      <span id="showcase-composer-anchor" aria-hidden="true" />
      <Card
        title={
          editingPost ? (ar ? 'تعديل منشور' : 'Edit post') : ar ? 'إنشاء منشور' : 'Create post'
        }
        testId="showcase-composer"
        padded={false}
      >
        <div style={{ padding: spacingTokens.md, display: 'grid', gap: spacingTokens.md }}>
          <PrototypeNotice ar={ar} testId="composer-prototype-notice" />
          {editingPost ? (
            <Banner tone="info" testId="composer-editing-notice">
              {ar
                ? `يجري تعديل «${editingPost.caption.slice(0, 40)}…» — بيانات عرض.`
                : `Editing “${editingPost.caption.slice(0, 40)}…” — preview data.`}{' '}
              <button
                type="button"
                data-testid="composer-stop-editing"
                onClick={() => setEditingPostId(null)}
                style={{
                  border: 0,
                  background: 'transparent',
                  padding: 0,
                  font: 'inherit',
                  fontWeight: 700,
                  textDecoration: 'underline',
                  cursor: 'pointer',
                  color: 'inherit',
                }}
              >
                {ar ? 'إنشاء منشور جديد بدلًا من ذلك' : 'Start a new post instead'}
              </button>
            </Banner>
          ) : null}
          <PostComposer
            /*
             * REMOUNTS when the post being edited changes. The composer owns
             * its own caption, format and selection state, and `initialCaption`
             * is exactly that — an INITIAL value. Without the key, choosing
             * "edit post" on a second record would leave the first one's text
             * in the editor, which is the class of bug that makes an interface
             * feel haunted.
             */
            key={editingPost?.id ?? 'new'}
            testId="prototype-composer"
            accounts={composerAccounts(locale)}
            labels={composerLabels(locale)}
            previewLabels={labels}
            campaigns={composerCampaigns(locale)}
            approvers={composerApprovers(locale)}
            initialCaption={editingPost?.caption ?? composerCaption(locale)}
            captionDirection={editingPost?.captionDirection ?? (ar ? 'rtl' : 'ltr')}
            scheduledLabel={editingPost?.whenLabel ?? (ar ? '١٢ مارس · ٩:٠٠ ص' : '12 Mar · 09:00')}
            mediaAlt={editingPost?.mediaAlt ?? (ar ? 'عمل فني للمنشور' : 'Composed artwork')}
            mediaSeed={editingPost?.mediaSeed ?? 1}
            copilot={
              <div
                data-testid="composer-copilot"
                style={{
                  blockSize: '30rem',
                  borderRadius: radiusTokens.xl,
                  background: colorTokens.surface,
                  boxShadow: shadowTokens.card,
                  overflow: 'hidden',
                }}
              >
                {copilotBody('composer')}
              </div>
            }
          />
        </div>
      </Card>

      {/* --------------------------------------------- Design Studio --- */}
      <Card
        title={ar ? 'استوديو التصميم' : 'Design Studio'}
        testId="showcase-studio"
        padded={false}
      >
        <div style={{ padding: spacingTokens.md, display: 'grid', gap: spacingTokens.md }}>
          <PrototypeNotice ar={ar} testId="studio-prototype-banner" />
          <DesignStudio
            testId="prototype-studio"
            labels={studioLabels(locale)}
            documentName={studioDocumentName(locale)}
          />
        </div>
      </Card>
      {/*
       * The post-details panel, rendered once for the whole page. Whichever
       * chip, card or row was clicked, the same panel opens for it — which is
       * why the calendar and the library agree about what a post is.
       */}
      <PostDetailDrawer
        post={openPost}
        labels={pdLabels}
        postLabels={pcLabels}
        onClose={() => setOpenPostId(null)}
        actions={
          openPost ? (
            <>
              <Button
                variant="neutral"
                data-testid="post-detail-view-in-library"
                onClick={() => viewInLibrary(openPost)}
              >
                {ar ? 'عرض في المكتبة' : 'View in library'}
              </Button>
              <Button data-testid="post-detail-edit" onClick={() => editInComposer(openPost)}>
                {ar ? 'تعديل المنشور' : 'Edit post'}
              </Button>
            </>
          ) : undefined
        }
      />
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
