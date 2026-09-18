import type {
  ApprovalStatus,
  CalendarDay,
  CalendarLabels,
  ComposerAccount,
  ComposerLabels,
  CopilotChangePreview,
  CopilotLabels,
  CopilotMessage,
  CopilotProposedAction,
  CopilotSuggestion,
  CopilotSurface,
  CopilotToolRun,
  FeatureCardLabels,
  FeatureState,
  PostCardLabels,
  PostDetailLabels,
  PostRecord,
  PostStatus,
  SocialPlatform,
  SocialPostPreviewContent,
  SocialPostPreviewLabels,
  StudioLabels,
} from '@brandspace/ui';
import { SURFACE_ACTIONS, type CopilotActionId } from '@brandspace/ui';

/**
 * SHOWCASE FIXTURES — deterministic, obviously fictional, never persisted.
 *
 * Nothing here reaches a database or resembles a real customer: the names are
 * transparently sample data, the addresses use `example.test` (RFC 6761,
 * reserved and unroutable), and no value is a credential. The showcase is a
 * visual contract, so its content must be stable across runs — a screenshot
 * that changes because a fixture randomised itself proves nothing.
 *
 * WHAT IS DELIBERATELY ABSENT: plan names, prices, quotas, credit allowances,
 * usage counters and analytics figures. CLAUDE.md §2.2 makes every one of those
 * versioned configuration owned by Platform Admin, and inventing a plausible
 * number here would put a lie on a screenshot the owner is asked to approve.
 * Where a screen has a slot for such a figure, the fixture leaves it empty and
 * the component states that the value is not available yet.
 */

export const SAMPLE_CAPTION_EN =
  'Behind every campaign is a team that plans it. This month we mapped a full quarter of content in one afternoon — brand voice, approvals, scheduling and reporting in a single place, so nobody chases a spreadsheet on launch day.';

export const SAMPLE_CAPTION_AR =
  'خلف كل حملة فريق يخطط لها. هذا الشهر رسمنا محتوى ربع كامل في جلسة واحدة — نبرة العلامة والموافقات والجدولة والتقارير في مكان واحد، حتى لا يطارد أحد جدول بيانات يوم الإطلاق.';

export const SHORT_CAPTION_EN = 'New season, same standards.';

const BRAND_NAME_EN = 'Sample Brand';
const BRAND_NAME_AR = 'متجر نموذجي';

/* ------------------------------------------------------------------ */
/* Shared status vocabulary                                            */
/* ------------------------------------------------------------------ */

function statusLabels(ar: boolean): Record<PostStatus, string> {
  return {
    DRAFT: ar ? 'مسودة' : 'Draft',
    SCHEDULED: ar ? 'مجدول' : 'Scheduled',
    PUBLISHING: ar ? 'قيد النشر' : 'Publishing',
    PUBLISHED: ar ? 'منشور' : 'Published',
    PARTIALLY_PUBLISHED: ar ? 'منشور جزئيًا' : 'Partially published',
    FAILED: ar ? 'فشل' : 'Failed',
  };
}

function approvalLabels(ar: boolean): Record<ApprovalStatus, string> {
  return {
    NOT_REQUIRED: ar ? 'لا يحتاج موافقة' : 'No approval needed',
    NEEDS_APPROVAL: ar ? 'بانتظار الموافقة' : 'Needs approval',
    APPROVED: ar ? 'تمت الموافقة' : 'Approved',
    CHANGES_REQUESTED: ar ? 'مطلوب تعديل' : 'Changes requested',
  };
}

const PLATFORM_NAMES: Record<SocialPlatform, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  linkedin: 'LinkedIn',
  x: 'X',
  tiktok: 'TikTok',
};

/* ------------------------------------------------------------------ */
/* Social preview                                                      */
/* ------------------------------------------------------------------ */

export function socialLabels(locale: string): SocialPostPreviewLabels {
  const ar = locale === 'ar';
  return {
    statusLabels: statusLabels(ar),
    approvalLabels: approvalLabels(ar),
    platformNames: PLATFORM_NAMES,
    formatNames: {
      feed: ar ? 'منشور' : 'Feed post',
      story: ar ? 'ستوري' : 'Story',
      reel: ar ? 'ريل' : 'Reel',
      video: ar ? 'فيديو' : 'Video',
    },
    showMore: ar ? 'عرض المزيد' : 'Show more',
    showLess: ar ? 'عرض أقل' : 'Show less',
    missingMedia: ar ? 'لا توجد وسائط بعد' : 'No media yet',
    loadingMedia: ar ? 'جارٍ تحميل الوسائط' : 'Loading media',
    videoBadge: ar ? 'فيديو' : 'Video',
    carouselLabel: (count) => (ar ? `${count} صور في دائري` : `${count} images in a carousel`),
    previewNotice: ar
      ? 'معاينة بصرية فقط — لا يوجد اتصال بأي منصة في هذه المرحلة.'
      : 'Visual preview only — no platform is connected in this phase.',
    aspectLabel: (aspect) => aspect,
    actionsLabel: ar ? 'أزرار المنصة (توضيحية)' : 'Platform actions (illustrative)',
  };
}

export function samplePost(locale: string): SocialPostPreviewContent {
  const ar = locale === 'ar';
  return {
    platform: 'instagram',
    format: 'feed',
    aspect: '4:5',
    status: 'SCHEDULED',
    approval: 'APPROVED',
    account: {
      displayName: ar ? BRAND_NAME_AR : BRAND_NAME_EN,
      handle: '@sample.brand',
      initials: ar ? 'من' : 'SB',
      avatarSeed: 0,
    },
    caption: ar ? SAMPLE_CAPTION_AR : SAMPLE_CAPTION_EN,
    captionDirection: ar ? 'rtl' : 'ltr',
    hashtags: ['brandspace', 'contentstrategy', 'socialmedia'],
    scheduledLabel: ar ? '12 مارس · 9:00 ص' : '12 Mar · 09:00',
    media: {
      kind: 'image',
      alt: ar ? 'صورة المنتج' : 'Product photograph',
      seed: 0,
      count: 3,
    },
  };
}

/**
 * The preview VARIANTS the brief requires: an Instagram feed post, a Story, a
 * Reel, Facebook, LinkedIn, a vertical TikTok video and an X-style post.
 *
 * Each is a genuinely different composition rather than the same card with a
 * different badge, which is the whole point of modelling format separately
 * from platform.
 */
export function previewVariants(locale: string): readonly {
  readonly key: string;
  readonly title: string;
  readonly content: SocialPostPreviewContent;
}[] {
  const ar = locale === 'ar';
  const base = samplePost(locale);
  const account = base.account;
  const shortCaption = ar ? 'موسم جديد، المعايير نفسها.' : SHORT_CAPTION_EN;

  return [
    {
      key: 'instagram-feed',
      title: ar ? 'إنستغرام — منشور' : 'Instagram — feed',
      content: base,
    },
    {
      key: 'instagram-story',
      title: ar ? 'إنستغرام — ستوري' : 'Instagram — Story',
      content: {
        ...base,
        format: 'story',
        aspect: '9:16',
        status: 'DRAFT',
        approval: 'NEEDS_APPROVAL',
        caption: shortCaption,
        hashtags: [],
        media: { kind: 'image', alt: ar ? 'خلفية الستوري' : 'Story artwork', seed: 2 },
      },
    },
    {
      key: 'instagram-reel',
      title: ar ? 'إنستغرام — ريل' : 'Instagram — Reel',
      content: {
        ...base,
        format: 'reel',
        aspect: '9:16',
        status: 'PUBLISHING',
        approval: 'APPROVED',
        caption: shortCaption,
        media: {
          kind: 'video',
          alt: ar ? 'مقطع الريل' : 'Reel clip',
          seed: 4,
          durationLabel: '0:24',
        },
      },
    },
    {
      key: 'facebook-feed',
      title: ar ? 'فيسبوك — منشور' : 'Facebook — feed',
      content: {
        ...base,
        platform: 'facebook',
        format: 'feed',
        aspect: '16:9',
        status: 'PUBLISHED',
        approval: 'NOT_REQUIRED',
        media: { kind: 'image', alt: ar ? 'صورة الحملة' : 'Campaign artwork', seed: 1 },
      },
    },
    {
      key: 'linkedin-feed',
      title: ar ? 'لينكدإن — منشور' : 'LinkedIn — feed',
      content: {
        ...base,
        platform: 'linkedin',
        format: 'feed',
        aspect: '1:1',
        status: 'SCHEDULED',
        approval: 'APPROVED',
        account: { ...account, handle: '@sample.brand', initials: ar ? 'من' : 'SB' },
        media: { kind: 'image', alt: ar ? 'رسم بياني' : 'Diagram artwork', seed: 3 },
      },
    },
    {
      key: 'tiktok-video',
      title: ar ? 'تيك توك — فيديو رأسي' : 'TikTok — vertical video',
      content: {
        ...base,
        platform: 'tiktok',
        format: 'video',
        aspect: '9:16',
        status: 'SCHEDULED',
        approval: 'CHANGES_REQUESTED',
        caption: shortCaption,
        media: {
          kind: 'video',
          alt: ar ? 'مقطع رأسي' : 'Vertical clip',
          seed: 5,
          durationLabel: '0:15',
        },
      },
    },
    {
      key: 'x-post',
      title: ar ? 'إكس — منشور' : 'X — post',
      content: {
        ...base,
        platform: 'x',
        format: 'feed',
        aspect: '16:9',
        status: 'FAILED',
        approval: 'NOT_REQUIRED',
        caption: shortCaption,
        hashtags: ['brandspace'],
        media: { kind: 'missing' },
      },
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Copilot                                                             */
/* ------------------------------------------------------------------ */

export function copilotLabels(locale: string): CopilotLabels {
  const ar = locale === 'ar';
  return {
    title: ar ? 'مساعد براندسبيس' : 'BrandSpace Copilot',
    subtitle: ar ? 'معاينة بصرية' : 'Visual preview',
    open: ar ? 'فتح المساعد' : 'Open Copilot',
    close: ar ? 'إغلاق المساعد' : 'Close Copilot',
    promptLabel: ar ? 'اكتب طلبك' : 'Ask the Copilot',
    promptPlaceholder: ar ? 'اقترح منشورًا لإطلاق المنتج…' : 'Draft a post for the product launch…',
    send: ar ? 'إرسال' : 'Send',
    attach: ar ? 'إرفاق' : 'Attach',
    attachmentsLabel: ar ? 'المرفقات' : 'Attachments',
    suggestionsLabel: ar ? 'اقتراحات' : 'Suggestions',
    conversationLabel: ar ? 'المحادثة' : 'Conversation',
    streaming: ar ? 'يكتب…' : 'Thinking…',
    errorTitle: ar ? 'تعذّر إكمال الطلب' : 'The request could not be completed',
    errorBody: ar ? 'حاول مرة أخرى، أو تواصل مع الدعم.' : 'Try again, or contact support.',
    insufficientCreditsTitle: ar ? 'الرصيد غير كافٍ' : 'Not enough credits',
    insufficientCreditsBody: ar
      ? 'أضف رصيدًا للمتابعة. لم يُخصم أي رصيد لهذه المحاولة.'
      : 'Add credits to continue. Nothing was charged for this attempt.',
    approvalTitle: ar ? 'إجراء يحتاج موافقتك' : 'Action needs your approval',
    approvalBody: ar ? 'لن يُنفَّذ شيء قبل موافقتك.' : 'Nothing runs until you approve it.',
    approve: ar ? 'موافقة' : 'Approve',
    reject: ar ? 'رفض' : 'Reject',
    mutatingWarning: ar
      ? 'هذا الإجراء يغيّر بيانات مساحة عملك.'
      : 'This action changes your workspace data.',
    disabledNotice: ar
      ? 'المساعد معاينة بصرية في هذه المرحلة: لا يوجد نموذج متصل ولن يُخصم رصيد.'
      : 'The Copilot is a visual preview in this phase: no model is connected and no credits are spent.',
    surfaceNames: {
      general: ar ? 'مساحة العمل' : 'Workspace',
      calendar: ar ? 'تقويم المحتوى' : 'Content calendar',
      posts: ar ? 'مكتبة المنشورات' : 'Posts library',
      composer: ar ? 'إنشاء منشور' : 'Create post',
      studio: ar ? 'استوديو التصميم' : 'Design Studio',
    },
    contextLabel: ar ? 'السياق' : 'Context',
    toolsLabel: ar ? 'الإجراءات المقترحة' : 'Proposed operations',
    previewTitle: ar ? 'ما الذي سيتغيّر' : 'What would change',
    beforeLabel: ar ? 'قبل' : 'Before',
    afterLabel: ar ? 'بعد' : 'After',
    assistantName: ar ? 'المساعد' : 'Copilot',
    userName: ar ? 'أنت' : 'You',
  };
}

/** The visible label of each suggested action, keyed by its stable identifier. */
function actionLabels(ar: boolean): Record<CopilotActionId, string> {
  return {
    'generate-ideas': ar ? 'اقترح أفكارًا' : 'Generate ideas',
    'write-caption': ar ? 'اكتب نصًا' : 'Write a caption',
    'rewrite-caption': ar ? 'أعد صياغة النص' : 'Rewrite the caption',
    'change-tone': ar ? 'غيّر النبرة' : 'Change the tone',
    translate: ar ? 'ترجم عربي / إنجليزي' : 'Translate AR / EN',
    'generate-hashtags': ar ? 'اقترح وسومًا' : 'Generate hashtags',
    'suggest-time': ar ? 'اقترح وقت نشر' : 'Suggest a posting time',
    repurpose: ar ? 'أعد استخدام المحتوى' : 'Repurpose this',
    'platform-variations': ar ? 'صيغ لكل منصة' : 'Platform variations',
    'visual-direction': ar ? 'اتجاه بصري' : 'Visual direction',
    'resize-design': ar ? 'أعد ضبط المقاس' : 'Resize the design',
  };
}

/**
 * The suggestion chips a surface offers.
 *
 * Derived from `SURFACE_ACTIONS`, so a screen can only offer an action that
 * screen can serve — a design canvas never offers to suggest a posting time.
 */
export function copilotSuggestions(
  locale: string,
  surface: CopilotSurface,
): readonly CopilotSuggestion[] {
  const labels = actionLabels(locale === 'ar');
  return SURFACE_ACTIONS[surface].map((id) => ({ id, label: labels[id] }));
}

export function sampleConversation(locale: string): readonly CopilotMessage[] {
  const ar = locale === 'ar';
  return [
    {
      id: 'm1',
      author: 'user',
      text: ar
        ? 'اكتب منشورًا عن إطلاق المجموعة الجديدة.'
        : 'Write a post about the new collection launch.',
    },
    {
      id: 'm2',
      author: 'assistant',
      text: ar
        ? 'إليك مسودة بنبرة العلامة المعتمدة، مع ثلاث صيغ للعنوان.'
        : 'Here is a draft in your approved brand voice, with three headline options.',
    },
  ];
}

/** The tool cards: what a run WOULD do, expressed as operations rather than prose. */
export function sampleTools(locale: string): readonly CopilotToolRun[] {
  const ar = locale === 'ar';
  return [
    {
      id: 't1',
      title: ar ? 'قراءة دليل العلامة' : 'Read the brand kit',
      detail: ar
        ? 'النبرة والألوان والخطوط المعتمدة لمساحة العمل.'
        : 'The workspace’s approved tone, palette and typefaces.',
      status: 'done',
    },
    {
      id: 't2',
      title: ar ? 'إعداد ثلاث صيغ للنص' : 'Draft three caption variations',
      detail: ar
        ? 'صيغ لإنستغرام ولينكدإن وإكس، بالطول المناسب لكل منصة.'
        : 'One each for Instagram, LinkedIn and X, at each platform’s length.',
      status: 'running',
    },
  ];
}

function changePreview(locale: string): readonly CopilotChangePreview[] {
  const ar = locale === 'ar';
  return [
    {
      label: ar ? 'النص' : 'Caption',
      before: ar ? 'المجموعة الجديدة متوفرة الآن.' : 'The new collection is available now.',
      after: ar
        ? 'المجموعة الجديدة وصلت — نفس المعايير، موسم جديد.'
        : 'The new collection has landed — same standards, new season.',
    },
    {
      label: ar ? 'وقت النشر' : 'Publishing time',
      before: ar ? 'الخميس 2:00 م' : 'Thursday 14:00',
      after: ar ? 'الخميس 9:00 ص' : 'Thursday 09:00',
    },
  ];
}

export function sampleProposedAction(locale: string): CopilotProposedAction {
  const ar = locale === 'ar';
  return {
    id: 'a1',
    title: ar ? 'جدولة المنشور ليوم الخميس 9:00 ص' : 'Schedule the post for Thursday 09:00',
    description: ar
      ? 'سيُضاف المنشور إلى تقويم النشر لحساب Instagram المرتبط.'
      : 'The post would be added to the publishing calendar for the connected Instagram account.',
    mutating: true,
    preview: changePreview(locale),
  };
}

/* ------------------------------------------------------------------ */
/* Features hub                                                        */
/* ------------------------------------------------------------------ */

export function featureLabels(locale: string): FeatureCardLabels {
  const ar = locale === 'ar';
  return {
    stateLabels: {
      enabled: ar ? 'متاح' : 'Enabled',
      disabled: ar ? 'غير مفعّل' : 'Disabled',
      locked: ar ? 'مقفل' : 'Locked',
      'coming-soon': ar ? 'قريبًا' : 'Coming soon',
    },
  };
}

export interface FeatureFixture {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly state: FeatureState;
  readonly lockedReason?: string;
}

/**
 * The eleven features the brief lists.
 *
 * The STATE of each is the honest state in this phase: what the design showcase
 * can actually demonstrate is `enabled`, what exists as a screen but has no
 * backend is `coming-soon`, and what an entitlement would gate is `locked` with
 * a reason that names no plan. No usage figure is attached to any of them,
 * because none is measured yet.
 */
export function featureFixtures(locale: string): readonly FeatureFixture[] {
  const ar = locale === 'ar';
  const upgrade = ar
    ? 'غير مشمول في اشتراك مساحة العمل الحالي.'
    : 'Not included in this workspace’s current entitlements.';
  return [
    {
      id: 'social',
      name: ar ? 'حسابات التواصل' : 'Social Media',
      description: ar
        ? 'اربط حسابات المنصات وأدر صلاحيات النشر من مكان واحد.'
        : 'Connect platform accounts and manage publishing permissions in one place.',
      state: 'coming-soon',
    },
    {
      id: 'calendar',
      name: ar ? 'تقويم المحتوى' : 'Content Calendar',
      description: ar
        ? 'خطّط الشهر والأسبوع واليوم، وتابع حالة كل منشور.'
        : 'Plan the month, the week and the day, and follow every post’s state.',
      state: 'enabled',
    },
    {
      id: 'library',
      name: ar ? 'المنشورات والمكتبة' : 'Posts and Content Library',
      description: ar
        ? 'كل ما كتبته ونشرته، بالبحث والتصفية وحالات الاعتماد.'
        : 'Everything written and published, with search, filters and approval states.',
      state: 'enabled',
    },
    {
      id: 'composer',
      name: ar ? 'إنشاء منشور' : 'Create Post',
      description: ar
        ? 'محرر بمعاينة حيّة لكل منصة وصيغة.'
        : 'An editor with a live preview for every platform and format.',
      state: 'enabled',
    },
    {
      id: 'studio',
      name: ar ? 'استوديو التصميم' : 'Design Studio',
      description: ar
        ? 'صمّم المرئيات بمقاسات المنصات ودليل علامتك.'
        : 'Design visuals at platform sizes, using your brand kit.',
      state: 'enabled',
    },
    {
      id: 'copilot',
      name: ar ? 'المساعد الذكي' : 'AI Copilot',
      description: ar
        ? 'اقتراحات وصياغة وترجمة، مع موافقة صريحة قبل أي تنفيذ.'
        : 'Ideas, drafting and translation, with an explicit approval before anything runs.',
      state: 'coming-soon',
    },
    {
      id: 'brand-kit',
      name: ar ? 'دليل العلامة' : 'Brand Kit',
      description: ar
        ? 'الألوان والخطوط والشعارات ونبرة الصوت المعتمدة.'
        : 'Approved colours, typefaces, logos and tone of voice.',
      state: 'coming-soon',
    },
    {
      id: 'media',
      name: ar ? 'مكتبة الوسائط' : 'Media Library',
      description: ar
        ? 'الصور والمقاطع المستخدمة عبر الحملات.'
        : 'The images and clips used across campaigns.',
      state: 'coming-soon',
    },
    {
      id: 'analytics',
      name: ar ? 'التحليلات' : 'Analytics',
      description: ar
        ? 'الأداء بعد النشر، عند توفر بيانات حقيقية من المنصات.'
        : 'Post-publication performance, once real platform data is available.',
      state: 'disabled',
    },
    {
      id: 'team',
      name: ar ? 'الفريق والاعتمادات' : 'Team and Approvals',
      description: ar
        ? 'الأعضاء والأدوار ومسارات الاعتماد قبل النشر.'
        : 'Members, roles and the approval path before anything is published.',
      state: 'enabled',
    },
    {
      id: 'automations',
      name: ar ? 'الأتمتة' : 'Automations',
      description: ar
        ? 'قواعد متكررة للنشر والتذكير والاعتماد.'
        : 'Recurring rules for publishing, reminders and approvals.',
      state: 'locked',
      lockedReason: upgrade,
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Posts                                                               */
/* ------------------------------------------------------------------ */

export function postCardLabels(locale: string): PostCardLabels {
  const ar = locale === 'ar';
  return {
    statusLabels: statusLabels(ar),
    approvalLabels: approvalLabels(ar),
    platformNames: PLATFORM_NAMES,
    selectLabel: ar ? 'تحديد المنشور' : 'Select post',
    openLabel: ar ? 'فتح تفاصيل المنشور' : 'Open post details',
  };
}

/** Labels for the post-details panel a calendar chip or a card opens. */
export function postDetailLabels(locale: string): PostDetailLabels {
  const ar = locale === 'ar';
  return {
    title: ar ? 'تفاصيل المنشور (بيانات عرض)' : 'Post details (preview data)',
    close: ar ? 'إغلاق التفاصيل' : 'Close details',
    account: ar ? 'الحساب' : 'Account',
    platforms: ar ? 'المنصات' : 'Platforms',
    schedule: ar ? 'الموعد' : 'Schedule',
    status: ar ? 'الحالة' : 'Status',
    approval: ar ? 'الاعتماد' : 'Approval',
  };
}

/**
 * Eight sample records covering every publishing and approval state.
 *
 * Deliberately no performance figures: §13 allows a performance slot only where
 * the screen says the number is unavailable, so the library renders the slot
 * with that sentence rather than a plausible engagement count.
 */
export function postFixtures(locale: string): readonly PostRecord[] {
  const ar = locale === 'ar';
  const account = ar ? BRAND_NAME_AR : BRAND_NAME_EN;
  const dir = ar ? ('rtl' as const) : ('ltr' as const);
  const alt = ar ? 'عمل فني تجريدي' : 'Abstract artwork';

  return [
    {
      id: 'p1',
      caption: ar ? SAMPLE_CAPTION_AR : SAMPLE_CAPTION_EN,
      captionDirection: dir,
      platforms: ['instagram', 'facebook'],
      accountName: account,
      status: 'SCHEDULED',
      approval: 'APPROVED',
      whenLabel: ar ? '12 مارس · 9:00 ص' : '12 Mar · 09:00',
      mediaSeed: 0,
      mediaAlt: alt,
      mediaCount: 3,
    },
    {
      id: 'p2',
      caption: ar ? 'موسم جديد، المعايير نفسها.' : SHORT_CAPTION_EN,
      captionDirection: dir,
      platforms: ['instagram'],
      accountName: account,
      status: 'DRAFT',
      approval: 'NEEDS_APPROVAL',
      whenLabel: ar ? 'مسودة · بلا موعد' : 'Draft · no date',
      mediaSeed: 1,
      mediaAlt: alt,
    },
    {
      id: 'p3',
      caption: ar
        ? 'ثلاثة أشياء غيّرناها هذا الربع، وواحد منها أحدث الفرق فعلًا.'
        : 'Three things we changed this quarter, and the one that actually moved the needle.',
      captionDirection: dir,
      platforms: ['linkedin'],
      accountName: account,
      status: 'PUBLISHED',
      approval: 'NOT_REQUIRED',
      whenLabel: ar ? '4 مارس · 11:30 ص' : '4 Mar · 11:30',
      mediaSeed: 2,
      mediaAlt: alt,
    },
    {
      id: 'p4',
      caption: ar
        ? 'خلف الكواليس: يوم تصوير كامل في 60 ثانية.'
        : 'Behind the scenes: a full shoot day in 60 seconds.',
      captionDirection: dir,
      platforms: ['tiktok', 'instagram'],
      accountName: account,
      status: 'PUBLISHING',
      approval: 'APPROVED',
      whenLabel: ar ? 'الآن' : 'Now',
      mediaSeed: 4,
      mediaAlt: alt,
      isVideo: true,
    },
    {
      id: 'p5',
      caption: ar
        ? 'إعلان الشراكة — نسخة أولى للمراجعة.'
        : 'Partnership announcement — first pass for review.',
      captionDirection: dir,
      platforms: ['x'],
      accountName: account,
      status: 'FAILED',
      approval: 'CHANGES_REQUESTED',
      whenLabel: ar ? '2 مارس · 4:00 م' : '2 Mar · 16:00',
      mediaSeed: 5,
      mediaAlt: alt,
    },
    {
      id: 'p6',
      caption: ar
        ? 'أسئلة العملاء الخمسة الأكثر تكرارًا.'
        : 'The five questions customers ask us most.',
      captionDirection: dir,
      platforms: ['facebook', 'linkedin'],
      accountName: account,
      status: 'SCHEDULED',
      approval: 'NEEDS_APPROVAL',
      whenLabel: ar ? '14 مارس · 1:00 م' : '14 Mar · 13:00',
      mediaSeed: 3,
      mediaAlt: alt,
      mediaCount: 2,
    },
    {
      id: 'p7',
      caption: ar
        ? 'تقرير الربع متاح الآن للتحميل.'
        : 'The quarterly report is available to download.',
      captionDirection: dir,
      platforms: ['linkedin'],
      accountName: account,
      status: 'PUBLISHED',
      approval: 'APPROVED',
      whenLabel: ar ? '28 فبراير · 10:00 ص' : '28 Feb · 10:00',
      mediaSeed: 1,
      mediaAlt: alt,
    },
    {
      id: 'p8',
      caption: ar ? 'عدّ تنازلي للإطلاق — ستوري.' : 'Launch countdown — Story.',
      captionDirection: dir,
      platforms: ['instagram'],
      accountName: account,
      status: 'DRAFT',
      approval: 'NOT_REQUIRED',
      whenLabel: ar ? 'مسودة · بلا موعد' : 'Draft · no date',
      mediaSeed: 2,
      mediaAlt: alt,
      isVideo: true,
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Calendar                                                            */
/* ------------------------------------------------------------------ */

export function calendarLabels(locale: string): CalendarLabels {
  const ar = locale === 'ar';
  return {
    ...postCardLabels(locale),
    calendarLabel: ar ? 'تقويم المحتوى' : 'Content calendar',
    monthView: ar ? 'شهر' : 'Month',
    weekView: ar ? 'أسبوع' : 'Week',
    agendaView: ar ? 'قائمة' : 'Agenda',
    today: ar ? 'اليوم' : 'Today',
    previous: ar ? 'الفترة السابقة' : 'Previous period',
    next: ar ? 'الفترة التالية' : 'Next period',
    createPost: ar ? 'إنشاء منشور' : 'Create post',
    weekdayNames: ar
      ? ['الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت', 'الأحد']
      : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    emptyDay: ar ? 'لا منشورات' : 'No posts',
    emptyPeriodTitle: ar ? 'لا شيء مجدول' : 'Nothing scheduled',
    emptyPeriodBody: ar
      ? 'لا توجد منشورات في هذه الفترة. ابدأ بإنشاء منشور.'
      : 'There are no posts in this period. Start by creating one.',
    postsOnDay: (count) => (ar ? `${count} منشورات` : `${count} posts`),
  };
}

/**
 * A deterministic four-week grid.
 *
 * The dates are fixed rather than derived from `new Date()`: a calendar that
 * moves with the clock produces a different screenshot every day, which makes
 * a visual review impossible to repeat.
 */
export function calendarDays(locale: string): readonly CalendarDay[] {
  const ar = locale === 'ar';
  const posts = postFixtures(locale);
  const monthName = ar ? 'مارس' : 'March';
  /*
   * WESTERN ARABIC NUMERALS IN ARABIC, per CLAUDE.md §4 — and per the demo,
   * whose Arabic mode mirrors the layout and keeps `12`, not `١٢`. The fixture
   * used to transliterate every figure to Eastern Arabic-Indic digits, which
   * is neither the project's stated default nor what the reference shows.
   */
  const digits = (n: number) => String(n);

  // Day 1 falls on the fourth weekday cell, so the grid opens with three
  // trailing days from the previous month — the shape a real month has.
  const cells: readonly { readonly day: number; readonly inMonth: boolean }[] = [
    { day: 26, inMonth: false },
    { day: 27, inMonth: false },
    { day: 28, inMonth: false },
    ...Array.from({ length: 25 }, (_, index) => ({ day: index + 1, inMonth: true })),
  ];

  const byDay: Record<number, readonly PostRecord[]> = {
    2: posts[4] ? [posts[4]] : [],
    4: posts[2] ? [posts[2]] : [],
    9: posts[3] ? [posts[3]] : [],
    12: posts[0] && posts[1] ? [posts[0], posts[1]] : [],
    14: posts[5] ? [posts[5]] : [],
    18: posts[6] ? [posts[6]] : [],
    21: posts[7] ? [posts[7]] : [],
  };

  return cells.map((cell, index) => ({
    key: `${cell.inMonth ? 'm' : 'p'}-${cell.day}-${index}`,
    label: digits(cell.day),
    longLabel: `${digits(cell.day)} ${monthName}`,
    inCurrentPeriod: cell.inMonth,
    isToday: cell.inMonth && cell.day === 12,
    posts: cell.inMonth ? (byDay[cell.day] ?? []) : [],
  }));
}

export function calendarPeriodLabel(locale: string): string {
  return locale === 'ar' ? 'مارس 2026' : 'March 2026';
}

/* ------------------------------------------------------------------ */
/* Composer                                                            */
/* ------------------------------------------------------------------ */

export function composerAccounts(locale: string): readonly ComposerAccount[] {
  const ar = locale === 'ar';
  const brand = ar ? BRAND_NAME_AR : BRAND_NAME_EN;
  return [
    {
      id: 'acc-ig',
      name: brand,
      handle: '@sample.brand',
      platform: 'instagram',
      initials: ar ? 'من' : 'SB',
      avatarSeed: 0,
    },
    {
      id: 'acc-li',
      name: brand,
      handle: '@sample.brand',
      platform: 'linkedin',
      initials: ar ? 'من' : 'SB',
      avatarSeed: 2,
    },
    {
      id: 'acc-tt',
      name: brand,
      handle: '@sample.brand',
      platform: 'tiktok',
      initials: ar ? 'من' : 'SB',
      avatarSeed: 4,
    },
  ];
}

export function composerLabels(locale: string): ComposerLabels {
  const ar = locale === 'ar';
  return {
    accountsTitle: ar ? 'الحسابات' : 'Accounts',
    accountsHint: ar
      ? 'اختر الحسابات التي سيُنشر عليها هذا المحتوى.'
      : 'Choose the accounts this content would be published to.',
    contentTitle: ar ? 'المحتوى' : 'Content',
    captionLabel: ar ? 'النص' : 'Caption',
    captionPlaceholder: ar ? 'اكتب نص المنشور…' : 'Write the post…',
    characterCount: (used, limit) =>
      ar ? `${used} من ${limit} حرفًا` : `${used} of ${limit} characters`,
    overLimit: ar
      ? 'النص أطول مما تقبله هذه المنصة.'
      : 'The caption is longer than this platform accepts.',
    hashtagsLabel: ar ? 'الوسوم' : 'Hashtags',
    hashtagsHint: ar ? 'افصل بينها بمسافة.' : 'Separate them with a space.',
    mentionsLabel: ar ? 'الإشارات' : 'Mentions',
    mediaTitle: ar ? 'الوسائط' : 'Media',
    mediaHint: ar
      ? 'أضف صورًا أو مقطعًا، ورتّبها بالسحب.'
      : 'Add images or a clip, and drag to reorder them.',
    addMedia: ar ? 'إضافة وسائط' : 'Add media',
    reorderHint: ar ? 'اسحب لإعادة الترتيب.' : 'Drag to reorder.',
    carouselLabel: ar ? 'دائري' : 'Carousel',
    aspectLabel: ar ? 'النسبة' : 'Aspect ratio',
    optionsTitle: ar ? 'خيارات المنصة' : 'Platform options',
    firstCommentLabel: ar ? 'التعليق الأول' : 'First comment',
    firstCommentHint: ar
      ? 'يُنشر مباشرة بعد المنشور، حيث تدعمه المنصة.'
      : 'Posted immediately after, where the platform supports it.',
    locationLabel: ar ? 'الموقع' : 'Location',
    campaignLabel: ar ? 'الحملة' : 'Campaign',
    approvalLabel: ar ? 'المعتمِد' : 'Approver',
    scheduleTitle: ar ? 'الجدولة' : 'Scheduling',
    publishNow: ar ? 'انشر الآن' : 'Publish now',
    schedule: ar ? 'جدولة' : 'Schedule',
    saveDraft: ar ? 'حفظ كمسودة' : 'Save draft',
    previewTitle: ar ? 'المعاينة' : 'Preview',
    unsupportedTitle: ar ? 'صيغة غير مدعومة' : 'Unsupported format',
    unsupportedBody: ar
      ? 'هذه المنصة لا تقبل هذه الصيغة. اختر صيغة أخرى أو أزل الحساب.'
      : 'This platform does not accept this format. Choose another, or remove the account.',
    prototypeNotice: ar
      ? 'نموذج بصري: لا يوجد اتصال بأي منصة، ولن يُنشر أو يُجدول شيء.'
      : 'A visual prototype: no platform is connected, and nothing is published or scheduled.',
    formatNames: {
      feed: ar ? 'منشور' : 'Feed post',
      story: ar ? 'ستوري' : 'Story',
      reel: ar ? 'ريل' : 'Reel',
      video: ar ? 'فيديو' : 'Video',
    },
    platformNames: PLATFORM_NAMES,
  };
}

export function composerCampaigns(
  locale: string,
): readonly { readonly id: string; readonly name: string }[] {
  const ar = locale === 'ar';
  return [
    { id: 'c0', name: ar ? 'بلا حملة' : 'No campaign' },
    { id: 'c1', name: ar ? 'إطلاق الربيع' : 'Spring launch' },
    { id: 'c2', name: ar ? 'وعي بالعلامة' : 'Brand awareness' },
  ];
}

export function composerApprovers(
  locale: string,
): readonly { readonly id: string; readonly name: string }[] {
  const ar = locale === 'ar';
  return [
    { id: 'u0', name: ar ? 'بلا اعتماد' : 'No approval required' },
    { id: 'u1', name: ar ? 'ليلى ن. — مديرة المحتوى' : 'Layla N. — Content lead' },
    { id: 'u2', name: ar ? 'عمر ص. — مدير مساحة العمل' : 'Omar S. — Workspace owner' },
  ];
}

export function composerCaption(locale: string): string {
  return locale === 'ar'
    ? 'ثلاثة أشياء غيّرناها هذا الربع، وواحد منها أحدث الفرق فعلًا. التفاصيل كاملة في التعليقات.'
    : 'Three things we changed this quarter, and the one that actually moved the needle. Full breakdown in the thread.';
}

/* ------------------------------------------------------------------ */
/* Design Studio                                                       */
/* ------------------------------------------------------------------ */

export function studioLabels(locale: string): StudioLabels {
  const ar = locale === 'ar';
  return {
    designName: ar ? 'اسم التصميم' : 'Design name',
    undo: ar ? 'تراجع' : 'Undo',
    redo: ar ? 'إعادة' : 'Redo',
    zoom: ar ? 'تكبير' : 'Zoom',
    saved: ar ? 'محفوظ' : 'Saved',
    preview: ar ? 'معاينة' : 'Preview',
    exportAction: ar ? 'تصدير' : 'Export',
    toolsLabel: ar ? 'الأدوات' : 'Tools',
    toolNames: {
      templates: ar ? 'قوالب' : 'Templates',
      uploads: ar ? 'رفع' : 'Uploads',
      photos: ar ? 'صور' : 'Photos',
      elements: ar ? 'عناصر' : 'Elements',
      text: ar ? 'نص' : 'Text',
      brand: ar ? 'دليل العلامة' : 'Brand Kit',
      background: ar ? 'خلفية' : 'Background',
    },
    canvasLabel: ar ? 'لوح التصميم' : 'Artboard',
    assetsLabel: ar ? 'العناصر' : 'Assets',
    assetsEmpty: ar
      ? 'لا توجد مكتبة وسائط بعد. تصل في المرحلة الثالثة.'
      : 'No media library yet. It arrives in Phase 3.',
    propertiesLabel: ar ? 'الخصائص' : 'Properties',
    sizeLabel: ar ? 'المقاس' : 'Size',
    positionLabel: ar ? 'الموضع' : 'Position',
    colourLabel: ar ? 'اللون' : 'Colour',
    typographyLabel: ar ? 'الخط' : 'Typography',
    alignmentLabel: ar ? 'المحاذاة' : 'Alignment',
    layersLabel: ar ? 'الطبقات' : 'Layers',
    opacityLabel: ar ? 'الشفافية' : 'Opacity',
    effectsLabel: ar ? 'التأثيرات' : 'Effects',
    effectNames: ar ? ['ظل', 'ضباب'] : ['Shadow', 'Blur'],
    presetsLabel: ar ? 'مقاسات جاهزة' : 'Preset sizes',
    presetNames: {
      'ig-post': ar ? 'منشور إنستغرام' : 'Instagram post',
      'ig-story': ar ? 'ستوري إنستغرام' : 'Instagram Story',
      'fb-post': ar ? 'منشور فيسبوك' : 'Facebook post',
      'li-post': ar ? 'منشور لينكدإن' : 'LinkedIn post',
      'x-post': ar ? 'منشور إكس' : 'X post',
      'yt-thumb': ar ? 'صورة يوتيوب' : 'YouTube thumbnail',
    },
    prototypeNotice: ar
      ? 'نموذج بصري: التحرير والتصدير والحفظ غير مفعّلة في هذه المرحلة.'
      : 'A visual prototype: editing, exporting and saving are not wired up in this phase.',
    layerNames: ar
      ? ['العنوان', 'السطر المساند', 'شارة الرابط', 'شعار العلامة', 'الخلفية']
      : ['Headline', 'Supporting line', 'URL badge', 'Brand mark', 'Background'],
    mobileNotice: ar
      ? 'على الشاشات الصغيرة يعرض الاستوديو اللوح والخصائص أسفل بعضهما بدل ثلاثة أعمدة.'
      : 'On a small screen the Studio stacks the artboard and its properties instead of showing three columns.',
    brandName: ar ? 'براندسبيس' : 'BrandSpace',
    sampleHeadline: ar
      ? 'خطّط ربعًا كاملًا في جلسة واحدة'
      : 'Plan a whole quarter in one afternoon',
    sampleSupporting: ar
      ? 'نبرة العلامة والموافقات والجدولة في مكان واحد.'
      : 'Brand voice, approvals and scheduling in one place.',
    sampleUrl: 'brandspace.cc',
  };
}

export function studioDocumentName(locale: string): string {
  return locale === 'ar' ? 'إطلاق الربع — مربع' : 'Q2 launch — square';
}
