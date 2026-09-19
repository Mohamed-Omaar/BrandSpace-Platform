/**
 * The S3-compatible object store — the first production implementation of
 * `ObjectStore`.
 *
 * CLOUDFLARE R2 IS THE FIRST TARGET, NOT THE ONLY ONE. Nothing in this file
 * names Cloudflare: no account id, no `r2.cloudflarestorage.com`, no bucket. It
 * speaks S3, and R2 is one S3-compatible endpoint among several — MinIO, AWS
 * S3 itself, Backblaze B2. Every vendor-specific value arrives as configuration
 * (`STORAGE_*`), which is what CLAUDE.md §2.2 requires and what makes changing
 * provider a settings change rather than a release.
 *
 * WHAT STAYS TRUE ACROSS THE SWAP. `ObjectStore` is three methods and a
 * caller-supplied key. This class adds no capability to that interface: no
 * presigned URLs, no listing, no versioning, and no reachability probe. Product
 * code that works against `FilesystemObjectStore` in development works against
 * this in production because there is nothing extra to reach for — and the one
 * extra method that briefly existed here, a `HeadBucket` for the Control
 * Center's Test Connection, went away with the screen that would have called
 * it: object storage is configured by the deployment, and the Control Center is
 * deliberately not given a bucket credential to test with.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import {
  checksumOf,
  safeStorageKeySegments,
  type ObjectStore,
  type StoredObject,
} from './object-store';

export interface S3ObjectStoreOptions {
  /** Full origin of the S3-compatible API. R2: `https://<account>.r2.cloudflarestorage.com`. */
  readonly endpoint: string;
  /** R2 requires `auto`. AWS S3 wants a real region. The schema defaults to `auto`. */
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /**
   * Path-style addressing (`https://host/bucket/key`) instead of virtual-host
   * style (`https://bucket.host/key`).
   *
   * THIS IS THE ONE SETTING S3 COMPATIBILITY GENUINELY NEEDS. R2 and AWS serve
   * virtual-host style; MinIO and several self-hosted gateways serve only
   * path-style, and a client that guesses wrong gets a DNS failure rather than
   * a useful error. Default false, which is what R2 wants.
   */
  readonly forcePathStyle?: boolean;
  /** Test seam. Never set in production code — the options above build the client. */
  readonly client?: S3Client;
}

/**
 * Does this error mean "the object is not there", as opposed to "we could not
 * ask"?
 *
 * THE DISTINCTION IS THE WHOLE POINT OF THIS FUNCTION. `get()` returns `null`
 * for a genuine miss, and a caller reads that as "no such object". If an
 * expired credential or a DNS failure also returned `null`, a transient outage
 * would look exactly like a deleted file — and the ingestion pipeline would
 * mark a document permanently missing because the network blinked.
 *
 * Only two things count: the S3 `NoSuchKey` / `NotFound` codes, and a bare 404.
 * A 403 does NOT: on a bucket that denies `ListBucket`, S3 answers 403 for an
 * absent key to avoid leaking existence, and treating that as a miss would hide
 * a broken credential behind an empty result.
 */
function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const named = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  if (named.name === 'NoSuchKey' || named.name === 'NotFound') return true;
  return named.$metadata?.httpStatusCode === 404;
}

export class S3ObjectStore implements ObjectStore {
  readonly #client: S3Client;
  readonly #bucket: string;

  constructor(options: S3ObjectStoreOptions) {
    this.#bucket = options.bucket;
    if (options.client) {
      this.#client = options.client;
      return;
    }
    const config: S3ClientConfig = {
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle ?? false,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    };
    this.#client = new S3Client(config);
  }

  /** The bucket this store writes to. Not a credential; useful in an operator log. */
  get bucket(): string {
    return this.#bucket;
  }

  /**
   * Store bytes under the caller's key.
   *
   * THE KEY GOES THROUGH THE SAME SAFETY BOUNDARY THE FILESYSTEM STORE USES,
   * even though S3 has no directories and `..` is an ordinary character in a
   * key. Two reasons, and neither is theoretical: the development store and the
   * production store must accept exactly the same keys, or a layout that worked
   * locally fails on deploy; and a key that survives here is later joined into
   * paths by anything that mirrors, backs up or syncs the bucket to a disk.
   *
   * THE CHECKSUM IS OURS, NOT THE ETAG. An ETag is MD5 only for a single-part
   * upload — for a multipart one it is a digest of digests with a `-N` suffix —
   * and it is the provider's claim about what it stored. `checksumOf` is
   * SHA-256 of the bytes we were handed, computed here, which is what the
   * duplicate-protection index and every integrity check in the product already
   * mean by "checksum".
   */
  async put(storageKey: string, bytes: Uint8Array, contentType: string): Promise<StoredObject> {
    safeStorageKeySegments(storageKey);
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: storageKey,
        Body: bytes,
        ContentType: contentType,
        ContentLength: bytes.byteLength,
      }),
    );
    return { storageKey, byteSize: bytes.byteLength, checksum: await checksumOf(bytes) };
  }

  /** The exact bytes, or `null` only for a genuine miss. See `isNotFound`. */
  async get(storageKey: string): Promise<Uint8Array | null> {
    safeStorageKeySegments(storageKey);
    try {
      const response = await this.#client.send(
        new GetObjectCommand({ Bucket: this.#bucket, Key: storageKey }),
      );
      if (!response.Body) return null;
      const bytes = await response.Body.transformToByteArray();
      return bytes;
    } catch (error: unknown) {
      if (isNotFound(error)) return null;
      /*
       * EVERYTHING ELSE PROPAGATES. Authentication, throttling, DNS, a bucket
       * that no longer exists — each is a condition an operator must see. The
       * caller's error path logs it through the redacting logger; swallowing it
       * here would convert an outage into silent data loss.
       */
      throw error;
    }
  }

  /**
   * Idempotent delete.
   *
   * S3 answers 204 whether or not the key existed, so deleting an absent object
   * already succeeds and there is nothing to special-case. The `isNotFound`
   * guard is there for gateways that answer 404 instead, which some
   * S3-compatible implementations do.
   */
  async delete(storageKey: string): Promise<void> {
    safeStorageKeySegments(storageKey);
    try {
      await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: storageKey }));
    } catch (error: unknown) {
      if (isNotFound(error)) return;
      throw error;
    }
  }
}
