import { isPublicErrorCode, type PublicErrorCode } from '@brandspace/shared';

/**
 * Fixed, bilingual text for the CODES that server actions put in the URL.
 *
 * The client never receives a message the server generated from an exception.
 * It receives a code from a closed set, and the page chooses the words. That is
 * what makes the redirect safe: there is no path from a Prisma error, a
 * connection string or a stack trace to anything rendered here.
 */

const ERROR_TEXT: Record<PublicErrorCode, { en: string; ar: string }> = {
  INVALID_INPUT: {
    en: 'That change was rejected. Check the values and try again.',
    ar: 'تم رفض التغيير. راجع القيم وحاول مرة أخرى.',
  },
  INVALID_JSON: {
    en: 'The payload is not valid JSON.',
    ar: 'المحتوى ليس JSON صالحًا.',
  },
  CONCURRENT_EDIT: {
    en: 'This draft was changed by someone else since you loaded it. Reload before saving, so neither edit is lost.',
    ar: 'عدّل شخص آخر هذه المسودة بعد فتحك لها. أعد التحميل قبل الحفظ حتى لا يضيع أي تعديل.',
  },
  CONFLICT: {
    en: 'That conflicts with the current state. Reload and try again.',
    ar: 'يتعارض هذا مع الحالة الحالية. أعد التحميل وحاول مرة أخرى.',
  },
  FORBIDDEN: {
    en: 'You do not have permission to do that.',
    ar: 'لا تملك صلاحية تنفيذ هذا الإجراء.',
  },
  UNAUTHENTICATED: {
    en: 'Your session is no longer valid. Sign in again.',
    ar: 'لم تعد جلستك صالحة. سجّل الدخول مرة أخرى.',
  },
  NOT_FOUND: {
    en: 'That item no longer exists.',
    ar: 'لم يعد هذا العنصر موجودًا.',
  },
  RATE_LIMITED: {
    en: 'Too many attempts. Wait a moment and try again.',
    ar: 'محاولات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.',
  },
  // Phase 3. An operator acting in the Control Center can hit these three when
  // they act on behalf of a workspace. The words name the wall, never the plan,
  // the limit or the price behind it.
  ENTITLEMENT_REQUIRED: {
    en: "That workspace's plan does not include this capability.",
    ar: 'خطة مساحة العمل هذه لا تشمل هذه الإمكانية.',
  },
  QUOTA_EXCEEDED: {
    en: 'That workspace has reached its limit for this action.',
    ar: 'بلغت مساحة العمل هذه حدّها لهذا الإجراء.',
  },
  INSUFFICIENT_CREDITS: {
    en: 'That workspace does not have enough AI credits for this action.',
    ar: 'لا تملك مساحة العمل هذه رصيد ذكاء اصطناعي كافيًا لهذا الإجراء.',
  },
  INTERNAL: {
    en: 'Something went wrong and nothing was changed.',
    ar: 'حدث خطأ ولم يتغيّر شيء.',
  },
};

/**
 * Render an error code. An unrecognised code falls back to the generic text —
 * a hand-crafted `?error=` is not a way to put words on the page.
 */
export function errorMessage(code: string, locale: string, correlationId?: string): string {
  const entry = isPublicErrorCode(code) ? ERROR_TEXT[code] : ERROR_TEXT.INTERNAL;
  const text = locale === 'ar' ? entry.ar : entry.en;
  if (!correlationId) return text;

  // The correlation id is an opaque uuid we generated. It is the ONE variable
  // part, and it is what joins this screen to the redacted server log.
  const safeId = /^[0-9a-f-]{36}$/i.test(correlationId) ? correlationId : null;
  if (!safeId) return text;
  return locale === 'ar' ? `${text} (المرجع: ${safeId})` : `${text} (reference: ${safeId})`;
}

const SUCCESS_TEXT: Record<string, (locale: string, params: URLSearchParams) => string> = {
  DRAFT_CREATED: (locale) => (locale === 'ar' ? 'تم إنشاء المسودة' : 'Draft created'),
  DRAFT_SAVED: (locale) =>
    locale === 'ar'
      ? 'تم حفظ المسودة. أعد التحقق قبل التفعيل.'
      : 'Draft saved. Validate it again before activating.',
  VALIDATION_PASSED: (locale, params) => {
    // Numbers only, coerced — the URL carries no free-form text.
    const changes = Number(params.get('changes') ?? 0);
    const high = Number(params.get('high') ?? 0);
    const base =
      locale === 'ar'
        ? `صالح. ${changes} تغيير، منها ${high} عالي الأثر.`
        : `Valid. ${changes} change(s), ${high} high impact.`;
    // Phase 3: the plan editor also reports who would be pushed over a new
    // limit (AC-04.5). Absent for every other domain, so the clause only
    // appears where it means something.
    const over = params.get('over');
    if (over === null) return base;
    const count = Number(over);
    return locale === 'ar'
      ? `${base} ${count} مساحة عمل تتجاوز حدًا جديدًا.`
      : `${base} ${count} workspace(s) over a new limit.`;
  },
  VALIDATION_FAILED: (locale, params) => {
    const errors = Number(params.get('errors') ?? 0);
    return locale === 'ar' ? `${errors} أخطاء تحقق.` : `${errors} validation error(s).`;
  },
  ACTIVATED: (locale) => (locale === 'ar' ? 'تم تفعيل الإعدادات' : 'Configuration activated'),
  ROLLED_BACK: (locale) => (locale === 'ar' ? 'تم التراجع' : 'Rolled back'),
  SECRET_STORED: (locale) => (locale === 'ar' ? 'تم حفظ المفتاح السري' : 'Secret stored'),
  SECRET_ROTATED: (locale) => (locale === 'ar' ? 'تم تدوير المفتاح السري' : 'Secret rotated'),
  SECRET_DISABLED: (locale) => (locale === 'ar' ? 'تم تعطيل المفتاح السري' : 'Secret disabled'),

  // --- Phase 2B. Codes only: none of these interpolates operator input. ---
  WORKSPACE_CREATED: (locale) => (locale === 'ar' ? 'تم إنشاء مساحة العمل' : 'Workspace created'),
  WORKSPACE_UPDATED: (locale) => (locale === 'ar' ? 'تم حفظ التغييرات' : 'Changes saved'),
  STATUS_CHANGED: (locale) =>
    locale === 'ar' ? 'تم تغيير حالة مساحة العمل' : 'Workspace status changed',
  PLAN_ASSIGNED: (locale) => (locale === 'ar' ? 'تم تعيين الخطة' : 'Plan assigned'),
  OVERRIDE_SET: (locale) => (locale === 'ar' ? 'تم حفظ الاستثناء' : 'Override saved'),
  OVERRIDE_REVOKED: (locale) => (locale === 'ar' ? 'تم إلغاء الاستثناء' : 'Override revoked'),
  CREDITS_ADJUSTED: (locale) => (locale === 'ar' ? 'تم تعديل الرصيد' : 'Credits adjusted'),
  INVITATION_SENT: (locale) => (locale === 'ar' ? 'تم إرسال الدعوة' : 'Invitation sent'),
  INVITATION_REVOKED: (locale) => (locale === 'ar' ? 'تم إلغاء الدعوة' : 'Invitation revoked'),
  SUPPORT_STARTED: (locale) => (locale === 'ar' ? 'بدأت جلسة الدعم' : 'Support session started'),
  SUPPORT_ENDED: (locale) => (locale === 'ar' ? 'انتهت جلسة الدعم' : 'Support session ended'),

  // --- Phase 3 ---
  DRAFT_DISCARDED: (locale) => (locale === 'ar' ? 'تم تجاهل المسودة' : 'Draft discarded'),
  FEATURE_SAVED: (locale) => (locale === 'ar' ? 'تم حفظ الميزة' : 'Feature saved'),
  FLAG_SAVED: (locale) => (locale === 'ar' ? 'تم حفظ المفتاح' : 'Flag saved'),
  COHORT_ADDED: (locale) =>
    locale === 'ar' ? 'تمت إضافة مساحة العمل إلى المجموعة' : 'Workspace added to the cohort',
  COHORT_REMOVED: (locale) =>
    locale === 'ar' ? 'تمت إزالة مساحة العمل من المجموعة' : 'Workspace removed from the cohort',
  TRIAL_STARTED: (locale) => (locale === 'ar' ? 'بدأت التجربة' : 'Trial started'),
  CREDITS_GRANTED: (locale) => (locale === 'ar' ? 'تمت إضافة الرصيد' : 'Credits granted'),
  RECONCILED: (locale) => (locale === 'ar' ? 'تمت المطابقة' : 'Reconciliation complete'),
};

/** Render a success code, or null when the code is not one we emit. */
export function successMessage(
  code: string,
  locale: string,
  params: URLSearchParams = new URLSearchParams(),
): string | null {
  const render = SUCCESS_TEXT[code];
  return render ? render(locale, params) : null;
}
