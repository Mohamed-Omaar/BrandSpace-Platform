/**
 * Provider adapter contracts.
 *
 * Every external dependency is reached through one of these. Adding a provider
 * means writing an adapter plus configuration — never touching business logic
 * (docs/ARCHITECTURE.md §13 A10).
 *
 * NOTHING HERE IS CONNECTED TO A REAL PROVIDER. Phase 2A defines the contracts
 * and ships fake adapters for tests; real integrations arrive in the phases that
 * own them (AI in Phase 4, social in Phase 6, payment in Phase 8). Claiming
 * otherwise would be worse than saying so.
 */

/** Result of "test connection" in the Control Center. */
export interface ConnectionTestResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  /** Safe to display. Never contains a credential or a raw provider error. */
  readonly message: string;
  readonly checkedAt: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * Credentials handed to an adapter.
 *
 * The adapter receives already-resolved values from the Secret Service. It must
 * not log them, attach them to spans, or include them in an error.
 */
export interface ResolvedCredentials {
  readonly [key: string]: string;
}

export interface AdapterContext {
  readonly environment: 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION';
  readonly credentials: ResolvedCredentials;
  readonly settings: Readonly<Record<string, string | number | boolean>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/** Every adapter can be configured, validated and health-checked the same way. */
export interface ProviderAdapter {
  readonly key: string;
  readonly kind: ProviderKind;
  /** Secret refs this adapter needs, so the UI can prompt for exactly those. */
  readonly requiredCredentialKeys: readonly string[];
  testConnection(ctx: AdapterContext): Promise<ConnectionTestResult>;
}

export const PROVIDER_KINDS = [
  'ai',
  'email',
  'payment',
  'storage',
  'social_oauth',
  'observability',
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

// --- AI ---------------------------------------------------------------------
export interface AiAdapter extends ProviderAdapter {
  readonly kind: 'ai';
  listModels(ctx: AdapterContext): Promise<readonly { key: string; displayName: string }[]>;
  generateText(
    input: { prompt: string; modelKey: string; maxOutputTokens: number },
    ctx: AdapterContext,
  ): Promise<{ text: string; promptTokens: number; completionTokens: number }>;
}

// --- Email ------------------------------------------------------------------
export interface EmailAdapter extends ProviderAdapter {
  readonly kind: 'email';
  send(
    input: { to: string; subject: string; html: string; text: string },
    ctx: AdapterContext,
  ): Promise<{ providerMessageId: string }>;
}

// --- Payment ----------------------------------------------------------------
export interface PaymentAdapter extends ProviderAdapter {
  readonly kind: 'payment';
  capabilities(): {
    supportsProration: boolean;
    supportsHostedCheckout: boolean;
    supportsMultiCurrency: boolean;
  };
  verifyWebhookSignature(raw: Buffer, signature: string, secret: string): boolean;
}

// --- Storage ----------------------------------------------------------------
export interface StorageAdapter extends ProviderAdapter {
  readonly kind: 'storage';
  createUploadUrl(
    input: { key: string; contentType: string; maxBytes: number },
    ctx: AdapterContext,
  ): Promise<{ url: string; expiresAt: string }>;
  createDownloadUrl(
    input: { key: string; ttlSeconds: number },
    ctx: AdapterContext,
  ): Promise<{ url: string; expiresAt: string }>;
}

// --- Social OAuth -----------------------------------------------------------
export interface SocialOAuthAdapter extends ProviderAdapter {
  readonly kind: 'social_oauth';
  buildAuthorizationUrl(
    input: { state: string; redirectUri: string; scopes: readonly string[] },
    ctx: AdapterContext,
  ): string;
  exchangeCode(
    input: { code: string; redirectUri: string },
    ctx: AdapterContext,
  ): Promise<{ accessToken: string; refreshToken: string | null; expiresInSeconds: number }>;
}

// --- Observability ----------------------------------------------------------
export interface ObservabilityAdapter extends ProviderAdapter {
  readonly kind: 'observability';
  /** Endpoint host only — never the full URL, which may embed credentials. */
  describeTarget(ctx: AdapterContext): { endpointHost: string | null; protocol: string };
}

export type AnyProviderAdapter =
  | AiAdapter
  | EmailAdapter
  | PaymentAdapter
  | StorageAdapter
  | SocialOAuthAdapter
  | ObservabilityAdapter;

/**
 * Registry. Adapters register themselves; configuration decides which is used.
 */
export class ProviderRegistry {
  readonly #adapters = new Map<string, AnyProviderAdapter>();

  register(adapter: AnyProviderAdapter): void {
    this.#adapters.set(`${adapter.kind}:${adapter.key}`, adapter);
  }

  get(kind: ProviderKind, key: string): AnyProviderAdapter | undefined {
    return this.#adapters.get(`${kind}:${key}`);
  }

  listByKind(kind: ProviderKind): AnyProviderAdapter[] {
    return [...this.#adapters.values()].filter((a) => a.kind === kind);
  }

  list(): AnyProviderAdapter[] {
    return [...this.#adapters.values()];
  }
}
