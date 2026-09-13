/**
 * Object storage for uploaded source documents.
 *
 * THE BYTES NEVER GO IN POSTGRESQL. A brand guidelines PDF is tens of
 * megabytes; putting it in a row would bloat every backup, every replica and
 * every `SELECT *` a future developer writes. The database holds a reference.
 *
 * The interface is PROVIDER-AGNOSTIC on purpose. No storage vendor is approved
 * (the `integrations.storage` configuration domain exists and is empty), so
 * shipping an S3 client here would be exactly the vendor lock-in CLAUDE.md §2.2
 * forbids. `InMemoryObjectStore` is what development and tests run against; a
 * real adapter implements the same three methods.
 */

export interface StoredObject {
  readonly storageKey: string;
  readonly byteSize: number;
  /** SHA-256, lowercase hex. The identity used for duplicate protection. */
  readonly checksum: string;
}

export interface ObjectStore {
  /**
   * Store bytes and return the reference.
   *
   * The key is supplied by the caller rather than invented here, so the layout
   * (`ws/<workspace>/brand/<brand>/<id>`) stays a tenancy decision rather than
   * a storage-driver one — and so a driver can never quietly place two tenants
   * in the same prefix.
   */
  put(storageKey: string, bytes: Uint8Array, contentType: string): Promise<StoredObject>;
  get(storageKey: string): Promise<Uint8Array | null>;
  /** Idempotent: deleting an absent object succeeds. */
  delete(storageKey: string): Promise<void>;
}

/**
 * Build the storage key for a document.
 *
 * WORKSPACE FIRST, and not negotiable: a prefix that starts with the tenant is
 * what lets an object-store policy be written per tenant at all, and what makes
 * a mis-scoped read visible as a wrong prefix rather than as a plausible key.
 */
export function buildStorageKey(input: {
  workspaceId: string;
  brandId: string;
  documentId: string;
}): string {
  return `ws/${input.workspaceId}/brand/${input.brandId}/source/${input.documentId}`;
}

/** SHA-256 of the content, lowercase hex. */
export async function checksumOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Development and test store. Never used when `NODE_ENV=production`: the
 * factory below refuses it, rather than leaving a memory-backed store to be
 * discovered in production by the first restart that loses every upload.
 */
export class InMemoryObjectStore implements ObjectStore {
  readonly #objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

  async put(storageKey: string, bytes: Uint8Array, contentType: string): Promise<StoredObject> {
    this.#objects.set(storageKey, { bytes, contentType });
    return { storageKey, byteSize: bytes.byteLength, checksum: await checksumOf(bytes) };
  }

  async get(storageKey: string): Promise<Uint8Array | null> {
    return this.#objects.get(storageKey)?.bytes ?? null;
  }

  async delete(storageKey: string): Promise<void> {
    this.#objects.delete(storageKey);
  }

  /** Test affordance. Not part of `ObjectStore`. */
  get size(): number {
    return this.#objects.size;
  }
}

/**
 * Resolve the object store for an environment.
 *
 * THE GATE IS THE DEPLOYMENT ENVIRONMENT, NOT THE BUILD MODE.
 *
 * It keyed on `NODE_ENV` first, which was wrong in a way only an end-to-end run
 * could show: `NODE_ENV` is `production` in ANY production build, including the
 * one the E2E suite serves and the one a developer runs to check a bundle. That
 * made the memory store unavailable to every built app, and the whole Brand
 * Brain screen failed with a storage error before it rendered a single read.
 *
 * `APP_ENV` is what the rest of the platform already uses to mean "which
 * deployment is this" — `currentEnvironment()` in both apps reads it — and it is
 * the value that should decide. A real production deployment still refuses:
 * failing there is correct, because the alternative is a memory store that
 * silently loses every customer upload on the next restart.
 */
export function createObjectStore(options: {
  /** The DEPLOYMENT environment: `APP_ENV`, never `NODE_ENV`. */
  appEnv: string;
  store?: ObjectStore;
}): ObjectStore {
  if (options.store) return options.store;
  if (options.appEnv === 'production') {
    throw new Error(
      'No object store is configured. Configure integrations.storage before enabling uploads.',
    );
  }
  return new InMemoryObjectStore();
}
