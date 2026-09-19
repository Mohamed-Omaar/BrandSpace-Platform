import {
  FilesystemObjectStore,
  defaultObjectStoreDirectory,
  type ObjectStore,
} from './object-store';
import { S3ObjectStore } from './s3-object-store';

/**
 * Read the S3 configuration out of the environment, or say what is missing.
 *
 * ALL FIVE OR NONE. A partially configured store is the worst of the three
 * outcomes: it constructs, it accepts an upload, and it fails at the provider
 * with an error that names a bucket rather than a missing variable. Returning
 * the list of absent names lets the factory refuse with a message an operator
 * can act on in one reading.
 */
export interface S3EnvironmentConfiguration {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
}

export function readS3Configuration(
  env: NodeJS.ProcessEnv = process.env,
):
  | { readonly ok: true; readonly config: S3EnvironmentConfiguration }
  | { readonly ok: false; readonly missing: readonly string[] } {
  const endpoint = env['STORAGE_ENDPOINT']?.trim();
  const bucket = env['STORAGE_BUCKET']?.trim();
  const accessKeyId = env['STORAGE_ACCESS_KEY_ID']?.trim();
  const secretAccessKey = env['STORAGE_SECRET_ACCESS_KEY']?.trim();
  // `auto` is what R2 requires and what the schema already defaults to, so an
  // unset region is a default rather than an omission.
  const region = env['STORAGE_REGION']?.trim() || 'auto';

  const missing: string[] = [];
  if (!endpoint) missing.push('STORAGE_ENDPOINT');
  if (!bucket) missing.push('STORAGE_BUCKET');
  if (!accessKeyId) missing.push('STORAGE_ACCESS_KEY_ID');
  if (!secretAccessKey) missing.push('STORAGE_SECRET_ACCESS_KEY');
  if (missing.length > 0) return { ok: false, missing };

  return {
    ok: true,
    config: {
      endpoint: endpoint as string,
      region,
      bucket: bucket as string,
      accessKeyId: accessKeyId as string,
      secretAccessKey: secretAccessKey as string,
      // Only the explicit string `true` turns it on. An accidental `0`, `no` or
      // empty value must not silently change the addressing style.
      forcePathStyle: env['STORAGE_FORCE_PATH_STYLE']?.trim().toLowerCase() === 'true',
    },
  };
}

export function createObjectStore(options: {
  /** The DEPLOYMENT environment: `APP_ENV`, never `NODE_ENV`. */
  appEnv: string;
  store?: ObjectStore;
  /** Override the development root. Defaults to `defaultObjectStoreDirectory()`. */
  directory?: string;
  /** Where the S3 settings are read from. Injected by tests; `process.env` otherwise. */
  env?: NodeJS.ProcessEnv;
}): ObjectStore {
  if (options.store) return options.store;

  const source = options.env ?? process.env;
  const s3 = readS3Configuration(source);

  if (options.appEnv === 'production') {
    /*
     * PRODUCTION HAS EXACTLY TWO OUTCOMES: a configured S3 store, or a refusal.
     *
     * There is no third branch here and there must never be one. A fallback to
     * the filesystem would put customer files on a container disk that the next
     * deploy discards, and it would do it silently — the upload succeeds, the
     * row is written, and the bytes are gone by the time anybody reads them
     * back. The whole reason this factory exists rather than a `new` at each
     * call site is to make that fallback impossible to reintroduce by accident.
     */
    if (!s3.ok) {
      throw new Error(
        'No object store is configured. Set ' +
          s3.missing.join(', ') +
          ' (Cloudflare R2 or another S3-compatible endpoint), or configure integrations.storage. ' +
          'Production never falls back to local disk: the first restart would lose every upload.',
      );
    }
    return new S3ObjectStore(s3.config);
  }

  /*
   * OUTSIDE PRODUCTION, A CONFIGURED S3 STORE STILL WINS. Staging is the reason:
   * it runs `APP_ENV=staging` against its own bucket and its own credentials,
   * and it must exercise the same adapter production will use. Without this,
   * staging would prove the filesystem store works and nothing else.
   */
  if (s3.ok) return new S3ObjectStore(s3.config);

  /*
   * NOT `InMemoryObjectStore`, deliberately. The producer (dashboard) and the
   * consumer (worker) are separate processes; a store only one of them can read
   * is not a store. `InMemoryObjectStore` stays exported for unit and isolation
   * tests, which run producer and consumer in one process on purpose.
   */
  return new FilesystemObjectStore(options.directory ?? defaultObjectStoreDirectory());
}
