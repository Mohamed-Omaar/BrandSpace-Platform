/**
 * Simple mode copy (D-307 … D-314).
 *
 * Business language for the platform owner, in both interface languages. The
 * English dictionary defines the shape and the Arabic one must match it
 * exactly — a missing Arabic string is a compile error, never a runtime
 * fallback to English (CLAUDE.md §4).
 *
 * Internal vocabulary — config domain, featureKey, workspaceId, routing rule,
 * secret — does not appear here. Advanced mode keeps it.
 */

const en = {
  // Navigation and the mode switch.
  'nav.home': 'Home',
  'nav.customers': 'Customers',
  'nav.plans': 'Plans & Pricing',
  'nav.features': 'Features',
  'nav.ai': 'AI',
  'nav.integrations': 'Integrations',
  'nav.usage': 'Usage & Billing',
  'nav.system': 'System',
  'page.home': 'Home',
  'page.customers': 'Customers',
  'page.plans': 'Plans & Pricing',
  'page.features': 'Features',
  'page.ai': 'AI',
  'page.aiConnect': 'Connect AI',
  'page.aiProfile': 'AI profile',
  'page.integrations': 'Integrations',
  'page.usage': 'Usage & Billing',
  'page.system': 'System',
  'mode.group': 'Control Center mode',
  'mode.simple': 'Simple',
  'mode.advanced': 'Advanced',
  'mode.advancedScreen':
    'This is an Advanced screen with technical detail. Nothing here is hidden from you in Simple mode — it is simply not part of the everyday owner view.',
  'mode.switchToAdvanced': 'Switch to Advanced',
  'mode.backToSimple': 'Back to Simple home',
  'mode.technicalDetails': 'View technical details',
} as const;

type Copy = { readonly [K in keyof typeof en]: string };

const ar: Copy = {
  'nav.home': 'الرئيسية',
  'nav.customers': 'العملاء',
  'nav.plans': 'الخطط والأسعار',
  'nav.features': 'الميزات',
  'nav.ai': 'الذكاء الاصطناعي',
  'nav.integrations': 'التكاملات',
  'nav.usage': 'الاستخدام والفوترة',
  'nav.system': 'النظام',
  'page.home': 'الرئيسية',
  'page.customers': 'العملاء',
  'page.plans': 'الخطط والأسعار',
  'page.features': 'الميزات',
  'page.ai': 'الذكاء الاصطناعي',
  'page.aiConnect': 'ربط الذكاء الاصطناعي',
  'page.aiProfile': 'ملف الذكاء الاصطناعي',
  'page.integrations': 'التكاملات',
  'page.usage': 'الاستخدام والفوترة',
  'page.system': 'النظام',
  'mode.group': 'وضع مركز التحكم',
  'mode.simple': 'بسيط',
  'mode.advanced': 'متقدم',
  'mode.advancedScreen':
    'هذه شاشة متقدمة فيها تفاصيل تقنية. لا شيء هنا محجوب عنك في الوضع البسيط — هي فقط ليست جزءًا من العرض اليومي للمالك.',
  'mode.switchToAdvanced': 'التبديل إلى المتقدم',
  'mode.backToSimple': 'العودة إلى الرئيسية البسيطة',
  'mode.technicalDetails': 'عرض التفاصيل التقنية',
};

export type SimpleKey = keyof typeof en;

export function simpleCopy(locale: string): (key: SimpleKey) => string {
  const dictionary: Copy = locale === 'ar' ? ar : en;
  return (key) => dictionary[key];
}
