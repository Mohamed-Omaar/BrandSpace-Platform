/**
 * Customer dashboard messages.
 *
 * CLAUDE.md §4: every user-facing string is a key, and both locales are
 * first-class. Typed, so a missing key is a compile error rather than a
 * placeholder that ships.
 */
export const messages = {
  ar: {
    'app.title': 'براندسبيس',
    'nav.overview': 'الرئيسية',
    'nav.members': 'الفريق',
    'nav.settings': 'الإعدادات',
    'nav.plan': 'الخطة والاستخدام',
    'nav.switch': 'تبديل مساحة العمل',
    'nav.signOut': 'تسجيل الخروج',
    'signIn.title': 'تسجيل الدخول',
    'signIn.email': 'البريد الإلكتروني',
    'signIn.password': 'كلمة المرور',
    'signIn.submit': 'دخول',
    'signIn.forgot': 'نسيت كلمة المرور؟',
    'signIn.failed': 'بيانات الدخول غير صحيحة.',
    'reset.title': 'إعادة تعيين كلمة المرور',
    'reset.request': 'إرسال رابط إعادة التعيين',
    'reset.sent': 'إذا كان هناك حساب بهذا البريد، فستصلك رسالة.',
    'reset.newPassword': 'كلمة المرور الجديدة',
    'reset.submit': 'حفظ كلمة المرور',
    'invite.title': 'دعوة إلى مساحة عمل',
    'invite.accept': 'قبول الدعوة',
    'invite.invalid': 'رابط الدعوة غير صالح أو انتهت صلاحيته.',
    'invite.signInFirst': 'سجّل الدخول بالبريد المدعو لقبول الدعوة.',
    'invite.workspace': 'مساحة العمل',
    'invite.role': 'الدور',
    'ws.select': 'اختر مساحة عمل',
    'ws.none': 'لا توجد مساحة عمل متاحة لحسابك حاليًا.',
    'ws.suspended': 'مساحة العمل موقوفة. تواصل مع الدعم.',
    'members.title': 'الفريق',
    'members.invite': 'دعوة عضو',
    'members.email': 'البريد الإلكتروني',
    'members.role': 'الدور',
    'members.status': 'الحالة',
    'members.remove': 'إزالة',
    'members.changeRole': 'تغيير الدور',
    'members.invitations': 'الدعوات المعلّقة',
    'members.resend': 'إعادة الإرسال',
    'members.revoke': 'إلغاء',
    'members.lastOwner': 'لا يمكن إزالة آخر مالك لمساحة العمل.',
    'perms.title': 'الأدوار والصلاحيات',
    'perms.yourRole': 'دورك',
    'perms.permission': 'الصلاحية',
    'settings.title': 'إعدادات مساحة العمل',
    'settings.name': 'الاسم',
    'settings.locale': 'اللغة',
    'settings.timezone': 'المنطقة الزمنية',
    'plan.title': 'الخطة والميزات الفعّالة',
    'plan.current': 'الخطة الحالية',
    'plan.none': 'لم تُعيَّن خطة بعد.',
    'plan.features': 'الميزات الفعّالة',
    'plan.limit': 'الحد',
    'plan.unlimited': 'بلا حد',
    'plan.credits': 'رصيد الذكاء الاصطناعي',
    'plan.noFeatures': 'لا توجد ميزات مُعرَّفة في الإعدادات النشطة بعد.',
    'common.save': 'حفظ',
    'common.enabled': 'مُفعّلة',
    'common.disabled': 'معطّلة',
    'common.reason': 'السبب',
    'common.empty': 'لا توجد بيانات بعد',
    'common.loading': 'جارٍ التحميل…',
  },
  en: {
    'app.title': 'BrandSpace',
    'nav.overview': 'Home',
    'nav.members': 'Team',
    'nav.settings': 'Settings',
    'nav.plan': 'Plan & usage',
    'nav.switch': 'Switch workspace',
    'nav.signOut': 'Sign out',
    'signIn.title': 'Sign in',
    'signIn.email': 'Email',
    'signIn.password': 'Password',
    'signIn.submit': 'Sign in',
    'signIn.forgot': 'Forgot your password?',
    'signIn.failed': 'Invalid credentials.',
    'reset.title': 'Reset your password',
    'reset.request': 'Send a reset link',
    'reset.sent': 'If an account exists for that address, a message is on its way.',
    'reset.newPassword': 'New password',
    'reset.submit': 'Save password',
    'invite.title': 'Workspace invitation',
    'invite.accept': 'Accept invitation',
    'invite.invalid': 'This invitation link is not valid.',
    'invite.signInFirst': 'Sign in with the invited address to accept.',
    'invite.workspace': 'Workspace',
    'invite.role': 'Role',
    'ws.select': 'Choose a workspace',
    'ws.none': 'No workspace is available to your account right now.',
    'ws.suspended': 'This workspace is suspended. Contact support.',
    'members.title': 'Team',
    'members.invite': 'Invite a member',
    'members.email': 'Email',
    'members.role': 'Role',
    'members.status': 'Status',
    'members.remove': 'Remove',
    'members.changeRole': 'Change role',
    'members.invitations': 'Pending invitations',
    'members.resend': 'Resend',
    'members.revoke': 'Revoke',
    'members.lastOwner': 'The last Workspace Owner cannot be removed.',
    'perms.title': 'Roles & permissions',
    'perms.yourRole': 'Your role',
    'perms.permission': 'Permission',
    'settings.title': 'Workspace settings',
    'settings.name': 'Name',
    'settings.locale': 'Locale',
    'settings.timezone': 'Timezone',
    'plan.title': 'Plan & effective features',
    'plan.current': 'Current plan',
    'plan.none': 'No plan has been assigned yet.',
    'plan.features': 'Effective features',
    'plan.limit': 'Limit',
    'plan.unlimited': 'Unlimited',
    'plan.credits': 'AI credits',
    'plan.noFeatures': 'No features are defined in the active configuration yet.',
    'common.save': 'Save',
    'common.enabled': 'Enabled',
    'common.disabled': 'Disabled',
    'common.reason': 'Reason',
    'common.empty': 'No data yet',
    'common.loading': 'Loading…',
  },
} as const;

export type MessageKey = keyof (typeof messages)['en'];

export function translator(locale: string) {
  const dictionary = locale === 'ar' ? messages.ar : messages.en;
  return (key: MessageKey): string => dictionary[key];
}

/**
 * Fixed, bilingual text for the CODES a server action puts in the URL.
 *
 * Same construction as the Control Center (R-05): the client receives a code
 * from a closed set and the page chooses the words, so no exception text can
 * reach the address bar, the browser history or an access log.
 */
const STATUS_TEXT: Record<string, { en: string; ar: string }> = {
  INVALID_INPUT: {
    en: 'That was rejected. Check the values and try again.',
    ar: 'تم الرفض. راجع القيم وحاول مرة أخرى.',
  },
  UNAUTHENTICATED: { en: 'Invalid credentials.', ar: 'بيانات الدخول غير صحيحة.' },
  FORBIDDEN: { en: 'You do not have permission to do that.', ar: 'لا تملك صلاحية تنفيذ هذا.' },
  NOT_FOUND: { en: 'That item no longer exists.', ar: 'لم يعد هذا العنصر موجودًا.' },
  CONFLICT: {
    en: 'That conflicts with the current state. Reload and try again.',
    ar: 'يتعارض هذا مع الحالة الحالية. أعد التحميل وحاول مرة أخرى.',
  },
  CONCURRENT_EDIT: {
    en: 'Someone else changed this. Reload before saving.',
    ar: 'عدّل شخص آخر هذا. أعد التحميل قبل الحفظ.',
  },
  RATE_LIMITED: {
    en: 'Too many attempts. Wait a moment and try again.',
    ar: 'محاولات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.',
  },
  INTERNAL: {
    en: 'Something went wrong and nothing was changed.',
    ar: 'حدث خطأ ولم يتغيّر شيء.',
  },
  INVALID_JSON: { en: 'The payload is not valid.', ar: 'المحتوى غير صالح.' },
  MEMBER_INVITED: { en: 'Invitation sent.', ar: 'تم إرسال الدعوة.' },
  MEMBER_REMOVED: { en: 'Member removed.', ar: 'تمت إزالة العضو.' },
  ROLE_CHANGED: { en: 'Role updated.', ar: 'تم تحديث الدور.' },
  INVITATION_REVOKED: { en: 'Invitation revoked.', ar: 'تم إلغاء الدعوة.' },
  INVITATION_RESENT: { en: 'A new invitation was sent.', ar: 'تم إرسال دعوة جديدة.' },
  SETTINGS_SAVED: { en: 'Settings saved.', ar: 'تم حفظ الإعدادات.' },
  RESET_REQUESTED: {
    en: 'If an account exists for that address, a message is on its way.',
    ar: 'إذا كان هناك حساب بهذا البريد، فستصلك رسالة.',
  },
  PASSWORD_UPDATED: {
    en: 'Password updated. Sign in with your new password.',
    ar: 'تم تحديث كلمة المرور. سجّل الدخول بكلمتك الجديدة.',
  },
};

/** Render a status code. An unrecognised code renders nothing at all. */
export function statusMessage(
  code: string | null | undefined,
  locale: string,
  correlationId?: string,
): string | null {
  if (!code) return null;
  const entry = STATUS_TEXT[code];
  if (!entry) return null;
  const text = locale === 'ar' ? entry.ar : entry.en;
  // The correlation id is an opaque uuid we generated: the ONE variable part,
  // and the only thing joining this screen to the redacted server log.
  const safeId = correlationId && /^[0-9a-f-]{36}$/i.test(correlationId) ? correlationId : null;
  if (!safeId) return text;
  return locale === 'ar' ? `${text} (المرجع: ${safeId})` : `${text} (reference: ${safeId})`;
}
