/**
 * Secret categories. Each names an integration family whose credentials the
 * Platform Owner manages from the Control Center.
 */
export const SECRET_CATEGORIES = [
  'ai_provider',
  'email_provider',
  'payment_provider',
  'object_storage',
  'social_oauth_app',
  'observability',
  'mfa_totp',
  'other',
] as const;

export type SecretCategory = (typeof SECRET_CATEGORIES)[number];

export interface SecretCategoryDefinition {
  readonly key: SecretCategory;
  readonly labelEn: string;
  readonly labelAr: string;
  /** Whether zero-downtime rotation is possible for this family. */
  readonly supportsZeroDowntimeRotation: boolean;
  readonly description: string;
}

export const SECRET_CATEGORY_DEFINITIONS: readonly SecretCategoryDefinition[] = [
  {
    key: 'ai_provider',
    labelEn: 'AI provider API key',
    labelAr: 'مفتاح مزود الذكاء الاصطناعي',
    supportsZeroDowntimeRotation: true,
    description:
      'Most AI providers accept several live keys, so a new key can be validated before the old one is retired.',
  },
  {
    key: 'email_provider',
    labelEn: 'Email provider credential',
    labelAr: 'بيانات مزود البريد',
    supportsZeroDowntimeRotation: true,
    description: 'Transactional email API keys.',
  },
  {
    key: 'payment_provider',
    labelEn: 'Payment provider credential',
    labelAr: 'بيانات مزود الدفع',
    supportsZeroDowntimeRotation: false,
    description:
      'Payment providers usually invalidate the previous key immediately, so rotation needs a maintenance window.',
  },
  {
    key: 'object_storage',
    labelEn: 'Object storage credential',
    labelAr: 'بيانات تخزين الملفات',
    supportsZeroDowntimeRotation: true,
    description: 'S3-compatible access key pairs.',
  },
  {
    key: 'social_oauth_app',
    labelEn: 'Social platform OAuth application',
    labelAr: 'تطبيق OAuth لمنصة تواصل',
    supportsZeroDowntimeRotation: false,
    description:
      'Client secrets for the BrandSpace application registered with each social platform.',
  },
  {
    key: 'observability',
    labelEn: 'Observability credential',
    labelAr: 'بيانات المراقبة',
    supportsZeroDowntimeRotation: true,
    description: 'OTLP collector headers and API keys.',
  },
  {
    key: 'mfa_totp',
    labelEn: 'MFA TOTP secret',
    labelAr: 'سر المصادقة الثنائية',
    supportsZeroDowntimeRotation: false,
    description: 'A platform user TOTP seed. Never displayed after enrolment.',
  },
  {
    key: 'other',
    labelEn: 'Other provider secret',
    labelAr: 'سر مزود آخر',
    supportsZeroDowntimeRotation: false,
    description: 'Future integrations that do not yet have a dedicated category.',
  },
];

export function isSecretCategory(value: string): value is SecretCategory {
  return (SECRET_CATEGORIES as readonly string[]).includes(value);
}

/** `ai/openai/production/api-key` — the shape configuration documents reference. */
export function buildSecretRef(parts: {
  category: SecretCategory;
  provider: string;
  environment: string;
  name: string;
}): string {
  const slug = (v: string) =>
    v
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-');
  return [
    slug(parts.category),
    slug(parts.provider),
    slug(parts.environment),
    slug(parts.name),
  ].join('/');
}
