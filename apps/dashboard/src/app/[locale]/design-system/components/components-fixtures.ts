/**
 * Fixtures for the component gallery. Obviously fictional, deterministic, and
 * in both languages, exactly as `../fixtures.ts` does for the main showcase.
 */

export const FAMILIES = [
  'button',
  'input',
  'select',
  'checkbox',
  'card',
  'badge',
  'dialog',
  'backdrop',
  'tooltip',
  'table',
  'empty',
  'nav',
] as const;

export type Family = (typeof FAMILIES)[number];

export function galleryCopy(locale: string) {
  const ar = locale === 'ar';
  const families: Record<Family, string> = ar
    ? {
        button: 'الأزرار',
        input: 'الحقول',
        select: 'القوائم',
        checkbox: 'مربعات الاختيار والمفاتيح',
        card: 'البطاقات',
        badge: 'الشارات',
        dialog: 'النوافذ',
        backdrop: 'الخلفيات الحاجبة',
        tooltip: 'التلميحات',
        table: 'الجداول',
        empty: 'الحالات الفارغة',
        nav: 'التنقل',
      }
    : {
        button: 'Button',
        input: 'Input and textarea',
        select: 'Select and menus',
        checkbox: 'Checkbox, radio and switch',
        card: 'Card',
        badge: 'Badge, pill and chip',
        dialog: 'Dialog and sheet',
        backdrop: 'Backdrop',
        tooltip: 'Tooltip',
        table: 'Table',
        empty: 'Empty and state',
        nav: 'Navigation',
      };
  return {
    pageTitle: ar ? 'معرض المكوّنات' : 'Component gallery',
    pageSubtitle: ar ? 'معرض المكوّنات' : 'Component gallery',
    pageDescription: ar
      ? 'كل مكوّن مشترك بكل حالاته الثابتة، بمظهري تطبيق العميل ومركز التحكم. بيانات عرض ثابتة فقط.'
      : 'Every shared control in every static state, in the customer app look and the Control Center look. Fixed showcase data only.',
    changeLanguage: ar ? 'تغيير اللغة' : 'Change language',
    indexLabel: ar ? 'أقسام المعرض' : 'Gallery sections',
    customerLook: ar ? 'مظهر تطبيق العميل' : 'Customer app look',
    consoleLook: ar ? 'مظهر مركز التحكم' : 'Control Center look',
    families,
  };
}

export const LONG_EN =
  'A deliberately long label that keeps going well past the width of its container to show how it wraps or clips';
export const LONG_AR =
  'نص طويل عمدًا يتجاوز عرض الحاوية بكثير لإظهار كيفية التفافه أو اقتطاعه عند ضيق المساحة المتاحة له';
