import { createHmac } from 'node:crypto';

/**
 * CONNECTORS A (W10) — THE PLATFORM USER, KEPT ONLY AS A KEYED HASH.
 *
 * Meta's "this person removed your app" and "delete this person's data"
 * callbacks name an app-scoped USER id, not the page that was connected; a
 * connection must be findable from it (step B). The id itself is never stored:
 * a connection keeps `v<version>:` + HMAC-SHA256 of it, under a key held in the
 * Secret Service and resolved only by the API.
 *
 * THE VERSION IS PART OF THE VALUE (owner requirement, schema approval), so a
 * key can rotate without breaking a lookup: new connections are written under
 * the current version, every version still listed in configuration is tried
 * when looking one up, and an old key is removed only once no row carries its
 * prefix. The database CHECK accepts exactly `^v[0-9]{1,4}:[0-9a-f]{64}$`.
 */
export interface SubjectHashKey {
  readonly version: number;
  /** The key material, resolved from the Secret Service. Never logged. */
  readonly secret: string;
}

export function subjectHash(subjectId: string, key: SubjectHashKey): string {
  if (!Number.isInteger(key.version) || key.version < 1 || key.version > 9_999) {
    throw new Error('A subject-hash key version is a whole number from 1 to 9999.');
  }
  if (subjectId.length === 0) throw new Error('A subject id cannot be empty.');
  const digest = createHmac('sha256', key.secret).update(subjectId, 'utf8').digest('hex');
  return `v${key.version}:${digest}`;
}

/**
 * Every hash a subject could be stored under, one per key still listed — what
 * a lookup asks for (step B), so a rotation in progress finds both old and new
 * rows.
 */
export function subjectHashCandidates(
  subjectId: string,
  keys: readonly SubjectHashKey[],
): string[] {
  return keys.map((key) => subjectHash(subjectId, key));
}

/**
 * How a service turns a platform user id into its stored hash. Null when no
 * key is configured: the connection is still made, and simply cannot be found
 * by a platform callback until it is reconnected under a key.
 */
export type SubjectHasher = (subjectId: string) => Promise<string | null>;
