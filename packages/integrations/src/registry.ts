import { z } from 'zod';
import { AppError } from '@brandspace/shared';

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
  /**
   * BrandSpace COMPUTES this value; the owner never types it.
   *
   * A callback or webhook URL is ours — it is where our own route lives — and
   * an input for it is an invitation to point a payment webhook somewhere else.
   * A generated field renders read-only and copyable, and `parseSettingsInput`
   * below discards whatever a form submitted for it (Phase 10 correction §10).
   */
  readonly generated?: boolean;
  /** How the value is validated. `url` refuses anything `new URL()` rejects. */
  readonly kind?: 'text' | 'url';
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
 * FIVE DEVELOPMENT DOUBLES AND TWO REAL VENDORS. Phase 10 ended with only the
 * doubles, and the claim it made was that adding a real provider would be one
 * entry here plus its adapter. Cloudflare R2 and Resend are that claim being
 * cashed: two rows below, two adapters, no change to the Hub, the
 * configuration service, the Secret Service or any screen.
 *
 * AI, SOCIAL AND PAYMENTS REMAIN DOUBLES. No vendor has been chosen for any of
 * the three, and none is named anywhere in this file.
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
        /*
         * A REAL CONSTRUCTOR PARAMETER of `DevelopmentPaymentProvider`, not a
         * field invented to give the form something to show. The adapter needs
         * somewhere to host its checkout page, and before this correction that
         * value was read from an environment variable while the Hub claimed to
         * manage the provider.
         */
        key: 'hostedBaseUrl',
        labelEn: 'Hosted checkout base URL',
        labelAr: 'الرابط الأساسي لصفحة الدفع',
        secret: false,
        required: true,
        kind: 'url',
        helpEn: 'Where the provider hosts its checkout page. The customer is sent here to pay.',
        helpAr: 'المكان الذي يستضيف فيه المزود صفحة الدفع. يُرسَل العميل إليه ليدفع.',
      },
      {
        key: 'webhookUrl',
        labelEn: 'Webhook URL',
        labelAr: 'رابط الويب هوك',
        secret: false,
        required: false,
        copyable: true,
        generated: true,
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
    providerKey: 'resend',
    displayNameEn: 'Resend',
    displayNameAr: 'Resend',
    category: 'email',
    supportedEnvironments: INTEGRATION_ENVIRONMENTS,
    capabilities: { transactional: true, templates: false, deliveryReceipts: false, bulk: false },
    credentialFields: [
      {
        key: 'apiKey',
        labelEn: 'API key',
        labelAr: 'مفتاح الواجهة',
        secret: true,
        required: true,
        helpEn:
          'A Resend API key with SENDING ACCESS ONLY, restricted to your verified sending domain — the least privilege that can send. Do not use a Full Access key. Entered once and never shown again — only a mask, a fingerprint and the date it was set.',
        helpAr:
          'مفتاح Resend بصلاحية الإرسال. يُدخل مرة واحدة ولا يُعرض مجددًا — يظهر القناع والبصمة وتاريخ الضبط فقط.',
      },
    ],
    settingFields: [
      {
        key: 'fromEmail',
        labelEn: 'From address',
        labelAr: 'عنوان المُرسِل',
        secret: false,
        required: true,
        kind: 'text',
        helpEn:
          'The address every message is sent from. Its domain must be verified in Resend, or the provider refuses the send.',
        helpAr: 'العنوان الذي تُرسل منه كل رسالة. يجب التحقق من نطاقه في Resend وإلا رُفض الإرسال.',
      },
      {
        key: 'fromName',
        labelEn: 'From name',
        labelAr: 'اسم المُرسِل',
        secret: false,
        required: false,
        kind: 'text',
        helpEn: 'Shown beside the address in the recipient’s inbox. Optional.',
        helpAr: 'يظهر بجانب العنوان في بريد المستلم. اختياري.',
      },
      {
        key: 'replyTo',
        labelEn: 'Reply-To address',
        labelAr: 'عنوان الرد',
        secret: false,
        required: false,
        kind: 'text',
        helpEn:
          'Where a recipient’s reply goes, when that should differ from the sending address. Optional.',
        helpAr: 'إلى أين يذهب رد المستلم إن اختلف عن عنوان الإرسال. اختياري.',
      },
    ],
    adapterAvailable: true,
    /*
     * NOT TESTABLE FROM THIS SCREEN, AND THAT IS A CHOICE ABOUT THE CREDENTIAL
     * RATHER THAN A GAP IN THE ADAPTER.
     *
     * The key BrandSpace asks for is the least-privileged one that can do the
     * job: Resend **Sending access**, restricted to the verified sending
     * domain. Such a key can send and can do nothing else — it cannot list
     * domains, read the account, or manage anything.
     *
     * Every non-destructive check Resend offers is a READ, and a
     * Sending-access key is refused all of them. So a Test Connection button
     * here had exactly three possible behaviours, and all three are worse than
     * no button:
     *
     *   1. Call `GET /domains` and report 401 — telling an owner their
     *      correctly-scoped production key is broken. A red tick on a working
     *      credential trains people to ignore ticks.
     *   2. Ask for a Full Access key so the read succeeds — widening a
     *      production credential's scope to light up a UI element. The key
     *      would then be able to manage the account, and it would live in the
     *      vault forever at that scope.
     *   3. Send a probe message — an unsolicited email, to somebody's real
     *      inbox, every time an operator presses a button.
     *
     * WHAT PROVES THE KEY INSTEAD. The controlled production smoke email after
     * activation (docs/RAILWAY-SMOKE-TEST.md §7.2): a real signup the owner
     * performs, to an address the owner controls, once. That is the same
     * operation the credential exists to perform, which makes it the only
     * honest test of a send-only key.
     *
     * Save and Activate remain separate operations. Removing the middle step
     * does not merge them.
     */
    testable: false,
    developmentOnly: false,
    noteEn:
      'Sends real mail. Use a Resend key with Sending access, restricted to your verified sending domain — the least privilege that can send. There is deliberately no Test connection button: every read-only check Resend offers is refused to a send-only key, so the alternatives would be a red tick on a working credential, a wider key than the platform needs, or an unsolicited probe email. Verify the sending domain in Resend before activating, then confirm delivery with the controlled smoke email after activation.',
    noteAr:
      'يرسل بريدًا حقيقيًا. استخدم مفتاح Resend بصلاحية الإرسال فقط، مقيّدًا بنطاق الإرسال الموثّق — وهي أقل صلاحية كافية للإرسال. لا يوجد زر اختبار اتصال عمدًا: كل فحص للقراءة توفّره Resend مرفوض لمفتاح الإرسال فقط، والبدائل إما إظهار فشل لمفتاح سليم، أو طلب مفتاح أوسع مما تحتاج المنصة، أو إرسال رسالة اختبار غير مطلوبة. تحقّق من نطاق الإرسال في Resend قبل التفعيل، ثم أكّد التسليم برسالة التحقق المضبوطة بعد التفعيل.',
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
    providerKey: 'cloudflare-r2',
    displayNameEn: 'Cloudflare R2 (S3-compatible)',
    displayNameAr: 'Cloudflare R2 (متوافق مع S3)',
    category: 'storage',
    supportedEnvironments: INTEGRATION_ENVIRONMENTS,
    capabilities: { put: true, get: true, delete: true, signedUrls: false, versioning: false },
    /*
     * NO FORM, AND THAT IS THE POINT.
     *
     * Object storage is configured by the DEPLOYMENT, through the `STORAGE_*`
     * environment variables `packages/shared/src/env.ts` declares, and
     * `createObjectStore` reads nothing else. Offering an endpoint and a key
     * here would create a second place to configure one thing — an owner would
     * type credentials into a form, watch it save, and watch the running
     * processes keep using the ones from the environment. A configuration
     * screen that is ignored is worse than no configuration screen.
     *
     * WHY STORAGE IS NOT LIKE EMAIL, which does get a form. The email provider
     * is resolved per send, by a process that can read the platform database
     * and decrypt a credential, so configuration is the right home for it. The
     * object store is constructed synchronously inside worker processors and
     * request handlers, long before any configuration read could be awaited,
     * and it sits at the same level as `DATABASE_URL` and `REDIS_URL` —
     * infrastructure the platform is handed, not a vendor the platform selects.
     *
     * IT STILL BELONGS IN THIS REGISTRY. The Hub is where an owner goes to ask
     * "what is this platform connected to", and a storage vendor that appears
     * nowhere would make the answer incomplete. What the entry provides is the
     * description and the honest note below; what it does not provide is a form
     * that writes somewhere nothing reads.
     */
    credentialFields: [],
    settingFields: [],
    adapterAvailable: true,
    /*
     * NOT TESTABLE FROM HERE. A reachability check needs the bucket credential,
     * and the Control Center deliberately does not hold it: an object-store key
     * is given only to the processes that move bytes (docs/SECURITY.md §2.4).
     * The API reports whether storage is configured on `/health/ready`, and the
     * end-to-end proof that bytes survive a redeploy is the owner-run step in
     * docs/RAILWAY-SMOKE-TEST.md rather than a green tick on this screen.
     */
    testable: false,
    developmentOnly: false,
    noteEn:
      'Holds every customer file. Bytes live at Cloudflare rather than on Railway, so a redeploy cannot lose an upload. The adapter speaks S3 and works against any S3-compatible endpoint. Configured by the STORAGE_* deployment variables, not on this screen — production and staging must use different buckets and different credentials.',
    noteAr:
      'يحتفظ بكل ملفات العملاء. تبقى البايتات لدى Cloudflare لا على Railway، فلا تُفقد أي ملفات عند إعادة النشر. يتحدث المحوّل بروتوكول S3 ويعمل مع أي نقطة نهاية متوافقة. يُضبط عبر متغيرات النشر STORAGE_* وليس من هذه الشاشة — ويجب أن يستخدم الإنتاج والتجريب حاويتين مختلفتين وبيانات اعتماد مختلفة.',
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

/**
 * WHICH SECRET CATEGORY an integration's credentials belong to.
 *
 * The Secret Service classifies every secret, and a credential saved from the
 * Hub must land in the same category an operator would have chosen by hand on
 * the Secrets page — otherwise the two screens disagree about what exists.
 */
const SECRET_CATEGORY_BY_INTEGRATION: Readonly<Record<IntegrationCategory, string>> = {
  ai: 'ai_provider',
  social: 'social_oauth_app',
  payment: 'payment_provider',
  email: 'email_provider',
  storage: 'object_storage',
  observability: 'observability',
};

export function secretCategoryFor(category: IntegrationCategory): string {
  return SECRET_CATEGORY_BY_INTEGRATION[category];
}

/**
 * The stable reference a credential is stored under.
 *
 * DETERMINISTIC ON PURPOSE. Rotation has to find the secret the owner saved
 * last time, and a random ref would leave the previous one orphaned in the
 * vault while the configuration pointed at a new one — two secrets, one slot,
 * and no way to tell which is live. The environment is part of the ref because
 * the Secret Service is keyed on `(ref, environment)`: the same provider in
 * staging and production is two secrets that must never be confused.
 *
 * Every component comes from the REGISTRY, never from a form.
 */
export function integrationSecretRef(
  definition: IntegrationDefinition,
  environment: IntegrationEnvironment,
  fieldKey: string,
): string {
  return `integration/${definition.category}/${definition.providerKey}/${environment.toLowerCase()}/${fieldKey}`;
}

/** The setting fields an owner may actually type into. */
export function editableSettingFields(
  definition: IntegrationDefinition,
): readonly IntegrationField[] {
  return definition.settingFields.filter((field) => field.generated !== true);
}

export interface SettingsParseResult {
  readonly settings: Readonly<Record<string, string>>;
  /** Keys the form submitted that this provider does not declare. */
  readonly ignored: readonly string[];
}

/**
 * Turn whatever a form submitted into exactly the settings this provider declares.
 *
 * THE REGISTRY DECIDES, NOT THE FORM — the Phase 10 correction's §4 rule, made
 * mechanical. The loop walks the DECLARED fields and reads each one out of the
 * submission; it never walks the submission. So an extra key is not a
 * vulnerability to be blocklisted, it is simply never looked at, and the
 * `ignored` list exists so a caller can say so out loud rather than pretending
 * it saved something it dropped.
 *
 * GENERATED FIELDS ARE NOT READ AT ALL. A webhook URL is ours; accepting one
 * from a form is how a payment callback ends up pointing at somebody else.
 */
export function parseSettingsInput(
  definition: IntegrationDefinition,
  submitted: Readonly<Record<string, unknown>>,
): SettingsParseResult {
  const settings: Record<string, string> = {};
  const declared = new Set(definition.settingFields.map((field) => field.key));

  for (const field of editableSettingFields(definition)) {
    const raw = submitted[field.key];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value === '') {
      if (field.required) {
        throw new AppError('VALIDATION_FAILED', `"${field.labelEn}" is required.`);
      }
      continue;
    }
    if (value.length > 2048) {
      throw new AppError('VALIDATION_FAILED', `"${field.labelEn}" is too long.`);
    }
    if (field.kind === 'url' && !isHttpUrl(value)) {
      throw new AppError('VALIDATION_FAILED', `"${field.labelEn}" must be an http(s) URL.`);
    }
    settings[field.key] = value;
  }

  const ignored = Object.keys(submitted).filter((key) => !declared.has(key));
  return { settings, ignored };
}

/**
 * Turn whatever a form submitted into the credential values to write.
 *
 * AN ABSENT FIELD IS "LEAVE IT ALONE", NOT "CLEAR IT". The form cannot
 * pre-populate a secret — nothing in this product can read one back — so an
 * empty box means the owner did not touch that credential, and treating it as a
 * deletion would wipe a working key every time somebody edited a URL.
 */
export function parseCredentialInput(
  definition: IntegrationDefinition,
  submitted: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const field of definition.credentialFields) {
    const raw = submitted[field.key];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value === '') continue;
    if (value.length > 8192) {
      throw new AppError('VALIDATION_FAILED', `"${field.labelEn}" is too long.`);
    }
    values[field.key] = value;
  }
  return values;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
