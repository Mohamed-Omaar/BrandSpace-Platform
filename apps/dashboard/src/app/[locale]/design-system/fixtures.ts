import type {
  CopilotLabels,
  CopilotMessage,
  CopilotProposedAction,
  SocialPostPreviewContent,
  SocialPostPreviewLabels,
} from '@brandspace/ui';

/**
 * SHOWCASE FIXTURES — deterministic, obviously fictional, never persisted.
 *
 * Nothing here reaches a database or resembles a real customer: the names are
 * transparently sample data, the addresses use `example.test` (RFC 6761,
 * reserved and unroutable), and no value is a credential. The showcase is a
 * visual contract, so its content must be stable across runs — a screenshot
 * that changes because a fixture randomised itself proves nothing.
 */

export const SAMPLE_CAPTION_EN =
  'Behind every campaign is a team that plans it. This month we mapped a full quarter of content in one afternoon — brand voice, approvals, scheduling and reporting in a single place, so nobody chases a spreadsheet on launch day.';

export const SAMPLE_CAPTION_AR =
  'خلف كل حملة فريق يخطط لها. هذا الشهر رسمنا محتوى ربع كامل في جلسة واحدة — نبرة العلامة والموافقات والجدولة والتقارير في مكان واحد، حتى لا يطارد أحد جدول بيانات يوم الإطلاق.';

export const SHORT_CAPTION_EN = 'New season, same standards.';

export function socialLabels(locale: string): SocialPostPreviewLabels {
  const ar = locale === 'ar';
  return {
    statusLabels: {
      DRAFT: ar ? 'مسودة' : 'Draft',
      SCHEDULED: ar ? 'مجدول' : 'Scheduled',
      PUBLISHED: ar ? 'منشور' : 'Published',
      FAILED: ar ? 'فشل' : 'Failed',
    },
    platformNames: {
      instagram: 'Instagram',
      facebook: 'Facebook',
      linkedin: 'LinkedIn',
      x: 'X',
      tiktok: 'TikTok',
    },
    showMore: ar ? 'عرض المزيد' : 'Show more',
    showLess: ar ? 'عرض أقل' : 'Show less',
    missingMedia: ar ? 'لا توجد وسائط بعد' : 'No media yet',
    loadingMedia: ar ? 'جارٍ تحميل الوسائط' : 'Loading media',
    videoBadge: ar ? 'فيديو' : 'Video',
    previewNotice: ar
      ? 'معاينة بصرية فقط — لا يوجد اتصال بأي منصة في هذه المرحلة.'
      : 'Visual preview only — no platform is connected in this phase.',
    aspectLabel: (aspect) => aspect,
  };
}

export function samplePost(locale: string): SocialPostPreviewContent {
  const ar = locale === 'ar';
  return {
    platform: 'instagram',
    aspect: '4:5',
    status: 'SCHEDULED',
    account: {
      displayName: ar ? 'متجر نموذجي' : 'Sample Brand',
      handle: '@sample.brand',
      initials: ar ? 'م' : 'SB',
    },
    caption: ar ? SAMPLE_CAPTION_AR : SAMPLE_CAPTION_EN,
    captionDirection: ar ? 'rtl' : 'ltr',
    scheduledLabel: ar ? '١٢ مارس · ٩:٠٠ ص' : '12 Mar · 09:00',
    media: { kind: 'image', alt: ar ? 'صورة المنتج' : 'Product photograph' },
  };
}

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
  };
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

export function sampleProposedAction(locale: string): CopilotProposedAction {
  const ar = locale === 'ar';
  return {
    id: 'a1',
    title: ar ? 'جدولة المنشور ليوم الخميس ٩:٠٠ ص' : 'Schedule the post for Thursday 09:00',
    description: ar
      ? 'سيُضاف المنشور إلى تقويم النشر لحساب Instagram المرتبط.'
      : 'The post would be added to the publishing calendar for the connected Instagram account.',
    mutating: true,
  };
}
