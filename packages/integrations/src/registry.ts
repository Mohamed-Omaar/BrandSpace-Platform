import { z } from 'zod';

/**
 * THE INTEGRATIONS REGISTRY — Phase 10 §2 and §4.
 *
 * WHAT THIS IS. One description, in one place, of every external system
 * BrandSpace can be connected to: which category it belongs to, which
 * environments it may run in, what it can do, which credentials it needs, and
 * whether an adapter for it actually exists. The Control Center's Integrations
 * screen is GENERATED from this file, so a new provider is a registration plus
 * an adapter rather than a new screen.
 *
 * THE HONEST RULE (§4), stated here because the UI is built from it:
 *
 *   If a BrandSpace adapter exists for a provider, the owner can configure and
 *   activate it from the Control Center without touching application code. A
 *   provider with a fundamentally different protocol still needs a new adapter.
 *
 * So `adapter` below is not a boolean flourish — it is the difference between
 * "enter your key" and "this needs an adapter first", and the screen says which.
 * There is deliberately NO generic arbitrary-HTTP provider: one would let an
 * owner point payment webhooks at an unvalidated endpoint and call it
 * compatibility.
 *
 * WHAT IS NOT IN HERE. No credential value, no endpoint belonging to a real
 * vendor account, and no vendor this product has not built an adapter for.
 * Listing "Stripe" with an empty adapter would be choosing the owner's payment
 * provider by implication (D-204), which Phase 9 deliberately did not do and
 * Phase 10 does not undo.
 */

export const INTEGRATION_CATEGORIES = [
  'ai',
  'social',
  'payment',
  'email',
  'storage',
  'observability',
] as const;

export type IntegrationCategory = (typeof INTEGRATION_CATEGORIES)[number];

export interface IntegrationCategoryDefinition {
  readonly key: IntegrationCategory;
  readonly labelEn: string;
  readonly labelAr: string;
  readonly descriptionEn: string;
  readonly descriptionAr: string;
  /** Which configuration domain holds this category's records. */
  readonly configDomain: string;
  /**
   * Whether the platform REQUIRES a configured provider in production.
   *
   * Required categories fail closed with an operator-visible refusal when no
   * production provider is active (§11, §14). Optional ones degrade the one
   * capability they serve and leave the rest of the platform running (§19).
   */
  readonly requiredInProduction: boolean;
}

export const INTEGRATION_CATEGORY_DEFINITIONS: readonly IntegrationCategoryDefinition[] = [
  {
    key: 'ai',
    labelEn: 'AI providers',
    labelAr: 'مزودو الذكاء الاصطناعي',
    descriptionEn: 'The model providers every AI capability is routed to.',
    descriptionAr: 'مزودو النماذج الذين تُوجَّه إليهم كل قدرات الذكاء الاصطناعي.',
    configDomain: 'ai.providers',
    // Without one, every AI feature in the product is unavailable.
    requiredInProduction: true,
  },
  {
    key: 'social',
    labelEn: 'Social platforms',
    labelAr: 'منصات التواصل',
    descriptionEn:
      'The BrandSpace developer application registered with each platform. Customers connect their own accounts separately.',
    descriptionAr:
      'تطبيق BrandSpace المسجَّل لدى كل منصة. يربط العملاء حساباتهم الخاصة من مكان آخر.',
    configDomain: 'integrations.social-apps',
    /*
     * NOT required. A workspace that never connects an account still gets
     * every other part of the product, and taking the platform down because
     * nobody registered a TikTok application would be a self-inflicted outage.
     */
    requiredInProduction: false,
  },
  {
    key: 'payment',
    labelEn: 'Payments',
    labelAr: 'المدفوعات',
    descriptionEn: 'The payment provider subscriptions and credit packs are bought through.',
    descriptionAr: 'مزود الدفع الذي تُشترى من خلاله الاشتراكات وحزم الرصيد.',
    configDomain: 'integrations.payment',
    // A platform that cannot take money cannot sell a subscription.
    requiredInProduction: true,
  },
  {
    key: 'email',
    labelEn: 'Transactional email',
    labelAr: 'البريد المعاملاتي',
    descriptionEn:
      'Verification links, security notices and billing mail. Nobody can finish signing up without it.',
    descriptionAr: 'روابط التحقق وإشعارات الأمان ورسائل الفوترة. لا يمكن إتمام التسجيل بدونها.',
    configDomain: 'integrations.email',
    requiredInProduction: true,
  },
  {
    key: 'storage',
    labelEn: 'Object storage',
    labelAr: 'تخزين الملفات',
    descriptionEn: 'Where uploaded files and generated media are kept.',
    descriptionAr: 'المكان الذي تُحفظ فيه الملفات المرفوعة والوسائط المولّدة.',
    configDomain: 'integrations.storage',
    requiredInProduction: true,
  },
  {
    key: 'observability',
    labelEn: 'Observability',
    labelAr: 'المراقبة',
    descriptionEn: 'Where traces and metrics are exported. The platform runs without it.',
    descriptionAr: 'وجهة تصدير التتبّع والمقاييس. تعمل المنصة بدونها.',
    configDomain: 'integrations.observability',
    requiredInProduction: false,
  },
];

export function findIntegrationCategory(key: string): IntegrationCategoryDefinition | undefined {
  return INTEGRATION_CATEGORY_DEFINITIONS.find((category) => category.key === key);
}

/** Environments a provider may be configured for, in ascending seriousness. */
export const INTEGRATION_ENVIRONMENTS = ['DEVELOPMENT', 'STAGING', 'PRODUCTION'] as const;
export type IntegrationEnvironment = (typeof INTEGRATION_ENVIRONMENTS)[number];

/**
 * A field the owner fills in for a provider.
 *
 * `secret: true` means the value goes to the Secret Service and never comes
 * back: the form writes it, the screen shows a mask, and there is no read path
 * anywhere in the product (§2, docs/SECURITY.md §5.1 rule 5).
 */
export interface IntegrationField {
  readonly key: string;
  readonly labelEn: string;
  readonly labelAr: string;
  readonly secret: boolean;
  readonly required: boolean;
  /** Shown beneath the field. Never an example credential. */
  readonly helpEn?: string;
  readonly helpAr?: string;
  /** A URL the owner copies INTO the provider's own console (a callback). */
  readonly copyable?: boolean;
}

/** What an integration can do, declared rather than assumed (§4). */
export interface IntegrationCapabilities {
  readonly [key: string]: boolean;
}

export interface IntegrationDefinition {
  readonly providerKey: string;
  readonly displayNameEn: string;
  readonly displayNameAr: string;
  readonly category: IntegrationCategory;
  readonly supportedEnvironments: readonly IntegrationEnvironment[];
  readonly capabilities: IntegrationCapabilities;
  /** Credential fields. Every one is written to the vault, never to config. */
  readonly credentialFields: readonly IntegrationField[];
  /** Non-secret settings. These live in the configuration document. */
  readonly settingFields: readonly IntegrationField[];
  /**
   * Whether BrandSpace has an adapter that can actually talk to this provider.
   *
   * ALWAYS TRUE TODAY, because the registry lists only providers with one. The
   * field exists so the rule in the file header is expressed in the type rather
   * than in prose, and so a provider added ahead of its adapter cannot be
   * presented to an owner as ready to activate.
   */
  readonly adapterAvailable: boolean;
  /** Whether Test Connection is meaningful for this provider. */
  readonly testable: boolean;
  /**
   * Whether this provider exists for DEVELOPMENT AND TEST ONLY.
   *
   * A development integration must never be selectable for production, and
   * `assertSelectableIn` below refuses it rather than leaving the refusal to a
   * screen somebody might change.
   */
  readonly developmentOnly: boolean;
  /** One sentence the Control Center shows. Honest about what this is. */
  readonly noteEn: string;
  readonly noteAr: string;
}

const DEVELOPMENT_AND_TEST: readonly IntegrationEnvironment[] = ['DEVELOPMENT', 'STAGING'];

/**
 * The providers BrandSpace can actually talk to today.
 *
 * ALL FIVE ARE DEVELOPMENT DOUBLES, and the registry says so on every row
 * rather than in a footnote. That is the true state of the platform at the end
 * of Phase 10: the contracts, the routing, the accounting and the screens are
 * finished, and no production vendor has been chosen. Adding one is a new
 * entry here plus its adapter — which is exactly the claim §4 asks this file
 * to make good on.
 */
export const INTEGRATION_DEFINITIONS: readonly IntegrationDefinition[] = [
  {
    providerKey: 'mock',
    displayNameEn: 'Deterministic AI (development)',
    displayNameAr: 'ذكاء اصطناعي حتمي (تطوير)',
    category: 'ai',
    supportedEnvironments: DEVELOPMENT_AND_TEST,
    capabilities: {
      text: true,
      image: true,
      moderation: true,
      embeddings: false,
      streaming: false,
    },
    credentialFields: [],
    settingFields: [],
    adapterAvailable: true,
    testable: true,
    developmentOnly: true,
    noteEn:
      'Produces repeatable output offline so the product can be built and tested without a vendor. It cannot be activated in production.',
    noteAr:
      'ينتج مخرجات قابلة للتكرار دون اتصال لبناء المنتج واختباره بلا مزود. لا يمكن تفعيله في الإنتاج.',
  },
  {
    /*
     * The adapter's own key, verbatim (`DEVELOPMENT_PROVIDER_KEY` in
     * `@brandspace/billing`). A registry entry whose key did not match the
     * adapter it describes would show an operator a row that tests nothing.
     */
    providerKey: 'development-mock',
    displayNameEn: 'Development payment provider',
    displayNameAr: 'مزود دفع للتطوير',
    category: 'payment',
    supportedEnvironments: DEVELOPMENT_AND_TEST,
    capabilities: {
      hostedCheckout: true,
      signedWebhooks: true,
      refunds: true,
      proration: false,
      multiCurrency: true,
      // Stated explicitly because its absence is the guarantee: no adapter in
      // this product has a method that could accept a card (D-204).
      acceptsCardData: false,
    },
    credentialFields: [
      {
        key: 'webhookSecret',
        labelEn: 'Webhook signing secret',
        labelAr: 'سر توقيع الويب هوك',
        secret: true,
        required: true,
        helpEn: 'Used to verify that an incoming payment event really came from the provider.',
        helpAr: 'يُستخدم للتحقق من أن حدث الدفع الوارد صادر فعلًا عن المزود.',
      },
    ],
    settingFields: [
      {
        key: 'webhookUrl',
        labelEn: 'Webhook URL',
        labelAr: 'رابط الويب هوك',
        secret: false,
        required: false,
        copyable: true,
        helpEn:
          'Give this to the provider. BrandSpace only ever believes a signed event sent here.',
        helpAr: 'أعطِ هذا الرابط للمزود. لا يصدّق BrandSpace إلا حدثًا موقَّعًا يصل إليه.',
      },
    ],
    adapterAvailable: true,
    testable: true,
    developmentOnly: true,
    noteEn:
      'Exercises the real payment path — a hosted page, a signed event, reconciliation — with no money and no vendor. Choosing the production provider remains the owner decision D-21.',
    noteAr:
      'يمرّ بمسار الدفع الحقيقي — صفحة مستضافة وحدث موقَّع وتسوية — بلا أموال وبلا مزود. اختيار مزود الإنتاج يبقى قرار المالك D-21.',
  },
  {
    providerKey: 'outbox',
    displayNameEn: 'Outbox email (development)',
    displayNameAr: 'بريد صندوق الصادر (تطوير)',
    category: 'email',
    supportedEnvironments: DEVELOPMENT_AND_TEST,
    capabilities: { transactional: true, templates: true, deliveryReceipts: false, bulk: false },
    credentialFields: [],
    settingFields: [],
    adapterAvailable: true,
    testable: true,
    developmentOnly: true,
    noteEn:
      'Writes each message to an auditable table instead of sending it. Nothing leaves the system, and production refuses it rather than reporting mail as sent.',
    noteAr:
      'يكتب كل رسالة في جدول قابل للتدقيق بدل إرسالها. لا يخرج شيء من النظام، ويرفضه الإنتاج بدل الادعاء بأن البريد أُرسل.',
  },
  {
    providerKey: 'filesystem',
    displayNameEn: 'Local filesystem storage (development)',
    displayNameAr: 'تخزين محلي على القرص (تطوير)',
    category: 'storage',
    supportedEnvironments: DEVELOPMENT_AND_TEST,
    capabilities: { put: true, get: true, delete: true, signedUrls: false, versioning: false },
    credentialFields: [],
    settingFields: [],
    adapterAvailable: true,
    testable: true,
    developmentOnly: true,
    noteEn:
      'Keeps uploads on the machine running the process. Production refuses it: the first restart on new hardware would lose every file.',
    noteAr:
      'يحفظ الملفات على الجهاز الذي يشغّل العملية. يرفضه الإنتاج: أول إعادة تشغيل على جهاز جديد تفقد كل ملف.',
  },
  {
    providerKey: 'mock',
    displayNameEn: 'Deterministic social connectors (development)',
    displayNameAr: 'موصلات تواصل حتمية (تطوير)',
    category: 'social',
    supportedEnvironments: DEVELOPMENT_AND_TEST,
    capabilities: {
      oauth: true,
      publish: true,
      media: true,
      analytics: true,
      tokenRefresh: true,
      webhooks: false,
    },
    credentialFields: [],
    settingFields: [],
    adapterAvailable: true,
    testable: true,
    developmentOnly: true,
    noteEn:
      'Simulates OAuth, publishing and analytics so the whole social workflow can be proven. Production refuses it rather than marking a post published into the void.',
    noteAr:
      'يحاكي OAuth والنشر والتحليلات لإثبات مسار التواصل كاملًا. يرفضه الإنتاج بدل اعتبار منشور غير موجود منشورًا.',
  },
];

/** The registry, keyed the way a lookup actually needs it. */
const BY_CATEGORY_AND_KEY = new Map<string, IntegrationDefinition>(
  INTEGRATION_DEFINITIONS.map((definition) => [
    `${definition.category}:${definition.providerKey}`,
    definition,
  ]),
);

export function findIntegration(
  category: string,
  providerKey: string,
): IntegrationDefinition | undefined {
  return BY_CATEGORY_AND_KEY.get(`${category}:${providerKey}`);
}

export function integrationsInCategory(
  category: IntegrationCategory,
): readonly IntegrationDefinition[] {
  return INTEGRATION_DEFINITIONS.filter((definition) => definition.category === category);
}

/**
 * Why this provider may not be selected for this environment, or null.
 *
 * THE ONE PLACE the development-only rule is enforced, so every caller — the
 * activation action, the adapter factories, the production readiness check —
 * asks the same question and gets the same answer. A screen that merely hid
 * the option would leave the rule enforced by a button.
 */
export function selectionRefusal(
  definition: IntegrationDefinition,
  environment: IntegrationEnvironment,
): string | null {
  if (!definition.adapterAvailable) {
    return `${definition.displayNameEn} has no adapter in this build, so it cannot be activated yet.`;
  }
  if (definition.developmentOnly && environment === 'PRODUCTION') {
    return (
      `${definition.displayNameEn} is a development double and can never be activated in ` +
      'production. Configure a real provider for this category.'
    );
  }
  if (!definition.supportedEnvironments.includes(environment)) {
    return `${definition.displayNameEn} does not support the ${environment} environment.`;
  }
  return null;
}

/** The schema an integration's settings document is parsed against. */
export function settingsSchemaFor(definition: IntegrationDefinition) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of definition.settingFields) {
    const base = z.string().max(2048);
    shape[field.key] = field.required ? base.min(1) : base.optional();
  }
  return z.object(shape);
}
