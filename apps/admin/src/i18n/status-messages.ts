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
    return locale === 'ar'
      ? `صالح. ${changes} تغيير، منها ${high} عالي الأثر.`
      : `Valid. ${changes} change(s), ${high} high impact.`;
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
