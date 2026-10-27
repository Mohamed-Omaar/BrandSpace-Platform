import type { AdapterRegistry, AiModality, AiProviderAdapter } from '../adapter';
import { MockProviderAdapter } from './mock';
import { OPENAI_DESCRIPTOR, OpenAiAdapter, type OpenAiAdapterOptions } from './openai';

/**
 * D-573 — THE ADAPTER REGISTRY, IN ONE PLACE.
 *
 * Before D-573 every process built its own `new Map([['mock', …]])` and the
 * availability route hard-coded `['mock']`, so a provider record could only
 * ever point at the mock. Now:
 *
 *   - the registry is keyed by ADAPTER key, and a provider record names its
 *     adapter (`ai.providers[].adapter`, defaulting to its own key);
 *   - outside production it holds the development double; in production it
 *     never does (D-215: the mock refuses to be constructed there);
 *   - every real adapter is always registered. Registering is not switching
 *     on: a provider is used only when the owner has saved its key, tested it
 *     and activated it, and a route points at one of its models.
 *
 * Adding a second provider is one adapter file and one line in
 * `REAL_ADAPTERS` below. Nothing outside this package names a vendor.
 */

export interface AiAdapterDescriptor {
  readonly key: string;
  readonly displayName: { readonly en: string; readonly ar: string };
  /** Prefilled in the Control Center; the owner may change it within the allow-list. */
  readonly defaultBaseUrl: string | null;
  /** Hosts this adapter may always call; anything else must be on the owner's allow-list. */
  readonly officialHosts: readonly string[];
  readonly modalities: readonly AiModality[];
  /** A development double: never registered or selectable in production. */
  readonly developmentOnly: boolean;
}

const MOCK_DESCRIPTOR: AiAdapterDescriptor = {
  key: 'mock',
  displayName: { en: 'Deterministic AI (development)', ar: 'ذكاء اصطناعي تجريبي (للتطوير)' },
  defaultBaseUrl: null,
  officialHosts: [],
  modalities: ['text', 'image', 'moderation'],
  developmentOnly: true,
};

interface RealAdapter {
  readonly descriptor: AiAdapterDescriptor;
  readonly create: (options: AiAdapterRegistryOptions) => AiProviderAdapter;
}

/** Every real provider adapter. One line per provider. */
const REAL_ADAPTERS: readonly RealAdapter[] = [
  { descriptor: OPENAI_DESCRIPTOR, create: (options) => new OpenAiAdapter(options.openai ?? {}) },
];

export interface AiAdapterRegistryOptions {
  /** A test injects a fake-server transport here; production never passes it. */
  readonly openai?: OpenAiAdapterOptions;
  /** The development double's behaviour (E2E and local work). */
  readonly mock?: ConstructorParameters<typeof MockProviderAdapter>[0];
}

/** What every process registers in this environment. */
export function aiAdapterRegistry(
  environment: 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION',
  options: AiAdapterRegistryOptions = {},
): AdapterRegistry {
  const entries: [string, AiProviderAdapter][] = REAL_ADAPTERS.map((entry) => [
    entry.descriptor.key,
    entry.create(options),
  ]);
  if (environment !== 'PRODUCTION') {
    entries.push(['mock', new MockProviderAdapter(options.mock ?? { answerFromContext: true })]);
  }
  return new Map(entries);
}

/** The adapter keys a process in this environment can serve (availability). */
export function registeredAiAdapterKeys(production: boolean): ReadonlySet<string> {
  return new Set([
    ...REAL_ADAPTERS.map((entry) => entry.descriptor.key),
    ...(production ? [] : [MOCK_DESCRIPTOR.key]),
  ]);
}

/** Every adapter the Control Center may describe, development double included. */
export const AI_ADAPTER_DESCRIPTORS: readonly AiAdapterDescriptor[] = [
  ...REAL_ADAPTERS.map((entry) => entry.descriptor),
  MOCK_DESCRIPTOR,
];

/** The adapter keys that are development doubles. */
export const DEVELOPMENT_ONLY_AI_ADAPTERS: ReadonlySet<string> = new Set(
  AI_ADAPTER_DESCRIPTORS.filter((entry) => entry.developmentOnly).map((entry) => entry.key),
);

/** One descriptor by adapter key. */
export function aiAdapterDescriptor(key: string): AiAdapterDescriptor | undefined {
  return AI_ADAPTER_DESCRIPTORS.find((entry) => entry.key === key);
}

export { OpenAiAdapter, OPENAI_ADAPTER_KEY } from './openai';
export type { OpenAiAdapterOptions } from './openai';
