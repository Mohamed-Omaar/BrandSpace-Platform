import { AppError } from '@brandspace/shared';
import { findIntegration, type IntegrationCategory, type IntegrationEnvironment } from './registry';

/**
 * Which provider is active, and what it was configured with.
 *
 * ONE ANSWER, ONE PLACE. Before this, "which email provider is live" was a
 * question each caller answered for itself — the API constructed an outbox, the
 * Control Center constructed an outbox, and the dashboard constructed a third.
 * Three answers to one question is how a platform ends up sending through a
 * provider nobody activated.
 *
 * IT RESOLVES NOTHING SECRET, AND THAT IS THE POINT. It returns secret
 * REFERENCES, exactly as they sit in the configuration document. Turning a
 * reference into a credential needs the Secret Service and the key domain
 * behind it, and this package deliberately cannot do that — the same boundary
 * that keeps `IntegrationTester` in the app layer (F-07). The caller that is
 * permitted to decrypt does so; the caller that is not gets a reference it
 * cannot use.
 *
 * WHY IT LIVES HERE AND NOT IN `auth`. `packages/auth` may not import
 * `@brandspace/config`, and it should not: an email adapter has no business
 * reading a configuration document. This package already reads that document
 * for the Hub, so the reader is one function beside the writer rather than a
 * fourth copy of the same shape.
 */

/** A provider record as the configuration document stores it. */
export interface ActiveProviderSelection {
  readonly category: IntegrationCategory;
  readonly providerKey: string;
  readonly environment: IntegrationEnvironment;
  /** Non-secret settings, exactly as configured. */
  readonly settings: Readonly<Record<string, string>>;
  /** Secret REFERENCES. Never values. The caller resolves these, if it may. */
  readonly secretRefs: Readonly<Record<string, string>>;
}

/** The shape `providerIntegrationSchema()` produces. Read-only here. */
interface ProviderDocument {
  readonly activeProviderKey?: string | null;
  readonly providers?: readonly {
    readonly key: string;
    readonly status?: string;
    readonly settings?: Record<string, unknown>;
    readonly secretRefs?: Record<string, string>;
  }[];
}

function stringSettings(settings: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(settings ?? {})) {
    // The schema permits string | number | boolean. Adapters take strings, so
    // the conversion happens once here rather than at each call site.
    if (value !== null && value !== undefined) out[key] = String(value);
  }
  return out;
}

/**
 * Read the active provider for a category out of its configuration document.
 *
 * `null` means "nothing is active", which is a legitimate state and not an
 * error: a deployment before its first activation is exactly that. What the
 * caller does about it is the caller's decision — production refuses, and
 * development falls back to a double.
 *
 * TWO CONDITIONS, BOTH REQUIRED. A provider is active when the document names
 * it in `activeProviderKey` AND its own record says `status: 'active'`. The
 * pair matters: disabling a provider sets its status without necessarily
 * clearing the pointer, and honouring the pointer alone would keep sending
 * through something an owner switched off.
 */
export function activeProviderSelection(
  category: IntegrationCategory,
  environment: IntegrationEnvironment,
  document: unknown,
): ActiveProviderSelection | null {
  const doc = (document ?? {}) as ProviderDocument;
  const key = doc.activeProviderKey;
  if (!key) return null;

  const record = (doc.providers ?? []).find((provider) => provider.key === key);
  if (!record || record.status !== 'active') return null;

  /*
   * THE REGISTRY HAS THE LAST WORD ON WHETHER THIS MAY RUN HERE. A development
   * double named as active in a production document is a configuration that
   * should never have been activated — but documents are edited, restored and
   * copied between environments, so the refusal belongs at the point of use as
   * well as at the point of activation.
   */
  const definition = findIntegration(category, key);
  if (!definition) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Configuration names "${key}" as the active ${category} provider, but no adapter is registered for it.`,
    );
  }
  if (definition.developmentOnly && environment === 'PRODUCTION') {
    throw new AppError(
      'VALIDATION_FAILED',
      `"${key}" is a development-only ${category} provider and cannot serve production traffic.`,
    );
  }

  return {
    category,
    providerKey: key,
    environment,
    settings: stringSettings(record.settings),
    secretRefs: { ...(record.secretRefs ?? {}) },
  };
}
