/**
 * The object-storage boundary — one abstraction for every binary the platform
 * holds on a customer's behalf.
 *
 * THE BYTES NEVER GO IN POSTGRESQL. A brand guidelines PDF or a campaign video
 * is tens of megabytes; putting it in a row would bloat every backup, every
 * replica and every `SELECT *` a future developer writes. The database holds a
 * reference.
 *
 * WHY THIS IS ITS OWN PACKAGE. It was born inside `packages/brand-brain`, where
 * it was the only consumer. The Asset Library is the second, and a second copy
 * of a storage driver is how two halves of one product end up with two key
 * layouts, two safety checks and two answers to "may production run without a
 * real adapter". CLAUDE.md §3 puts shared infrastructure in a package; this is
 * that move, not a rewrite. Brand Brain re-exports what it used to own, so no
 * caller changed.
 *
 * The interface is PROVIDER-AGNOSTIC, and stays that way now that a vendor has
 * been chosen. Cloudflare R2 is the first production target, and it is reached
 * through `S3ObjectStore` — an implementation of these three methods that names
 * no vendor and takes every endpoint, bucket and credential as configuration.
 * `FilesystemObjectStore` is still what development and tests run against, and
 * both stores accept exactly the same keys so a layout cannot work in one and
 * fail in the other.
 *
 * THE FACTORY LIVES IN `factory.ts`, not here. It has to know about both this
 * module and the S3 one, and putting it beside either would make the pair
 * import each other.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
 * Split a storage key into path segments, refusing anything that could escape
 * the root.
 *
 * THIS IS A SECURITY BOUNDARY, NOT TIDINESS. A storage key reaches this store
 * having been built from identifiers, but a filesystem store turns a key into a
 * path, and a path is the one place where `..` stops being a string and starts
 * being a different tenant's directory. The allowed alphabet is deliberately
 * narrower than what a key could legally contain: refusing an unexpected
 * character costs a failed upload in development, while accepting one costs
 * containment.
 */
export function safeStorageKeySegments(storageKey: string): string[] {
  const segments = storageKey.split('/');
  for (const segment of segments) {
    if (!/^[A-Za-z0-9._-]+$/.test(segment) || segment === '.' || segment === '..') {
      throw new Error(`Refusing unsafe storage key segment: ${JSON.stringify(segment)}`);
    }
  }
  return segments;
}

/**
 * Development and test store backed by the local filesystem.
 *
 * IT EXISTS BECAUSE THE MEMORY STORE IS PROCESS-LOCAL, and ingestion stopped
 * being a single process. The dashboard accepts the upload; the worker reads
 * the bytes back in a DIFFERENT process. A `Map` in the dashboard's heap is
 * invisible to the worker, so every queued ingestion failed to read the file it
 * had just been told about — which is precisely how the end-to-end run failed
 * once the queue was wired up and the inline fallback stopped being taken.
 *
 * Content type is not persisted: nothing reads it back (`get` returns bytes,
 * and the database row carries the declared type), so writing a sidecar for it
 * would only add a second file that can disagree with the first.
 */
export class FilesystemObjectStore implements ObjectStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  get root(): string {
    return this.#root;
  }

  #pathFor(storageKey: string): string {
    return path.join(this.#root, ...safeStorageKeySegments(storageKey));
  }

  async put(storageKey: string, bytes: Uint8Array, _contentType: string): Promise<StoredObject> {
    const file = this.#pathFor(storageKey);
    await mkdir(path.dirname(file), { recursive: true });
    /*
     * WRITE THEN RENAME. The reader is another process that may be woken by the
     * queue the instant the row is committed, so a plain `writeFile` races: the
     * worker can open a file that exists but is half-written and report a
     * corrupt document. `rename` within one directory is atomic, so the worker
     * sees either no file or the whole file.
     */
    const staging = `${file}.${crypto.randomUUID()}.tmp`;
    await writeFile(staging, bytes);
    await rename(staging, file);
    return { storageKey, byteSize: bytes.byteLength, checksum: await checksumOf(bytes) };
  }

  async get(storageKey: string): Promise<Uint8Array | null> {
    try {
      const buffer = await readFile(this.#pathFor(storageKey));
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(storageKey: string): Promise<void> {
    await rm(this.#pathFor(storageKey), { force: true });
  }
}

/** Where the development store keeps its bytes when nothing overrides it. */
export function defaultObjectStoreDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env['BRANDSPACE_OBJECT_STORE_DIR'] ?? path.join(tmpdir(), 'brandspace-objects');
}
