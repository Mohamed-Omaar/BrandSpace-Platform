import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createObjectStore, type ObjectStore } from '@brandspace/storage';
import { createLogger, internalErrorFields } from '@brandspace/shared';
import { route } from '../route-contract';
import { callerIsTrusted } from './internal-caller';

/**
 * THE STORAGE SELF-TEST — asked for by the Control Center, run here (PR F).
 *
 * WHY HERE. The Integrations Hub's Test button for object storage has to prove
 * that bytes can be written, read back and deleted with the bucket credential
 * the platform actually uses. The Control Center deliberately holds no
 * `STORAGE_*` variable (docs/SECURITY.md §2.4): a bucket credential in the one
 * service that already holds the platform database identity and the secret
 * vault key would widen its blast radius to buy nothing. The API already holds
 * that credential, because it moves bytes. So the Control Center asks, over the
 * service token, and the API runs the test against its OWN store — the same
 * factory every upload in this process goes through.
 *
 * WHAT IT DOES. Writes 32 random bytes under a reserved key
 * (`_brandspace/self-test/<uuid>.bin`), reads them back, compares, deletes, and
 * reads once more to confirm the object is gone. The delete is attempted in a
 * `finally` once the write succeeded, so a failed read never leaves the test
 * file behind. The reserved prefix sits outside every tenant layout
 * (`ws/<workspace>/…`), so the key can never collide with a customer file.
 *
 * WHAT IT ANSWERS, AND NOTHING ELSE: `{ ok, latencyMs, step? }`, plus
 * `notConfigured: true` when this process has no object store at all. No
 * endpoint, no bucket, no key id, no region, no object key and no error text —
 * the answer is shown to an operator and stored in a health-check row, and an
 * S3 error routinely names the bucket and the endpoint. The failure is logged
 * here with the step and the redacted error fields, which is where an operator
 * who needs the detail looks.
 *
 * GUARDED LIKE THE EMAIL ROUTE: the shared service token, compared in constant
 * time, and a 404 shaped like any missing path to anybody without it.
 */

const log = createLogger({ context: { component: 'api.internal.storage' } });

/** Where the test object lives. Outside every tenant prefix, on purpose. */
export const SELF_TEST_PREFIX = '_brandspace/self-test';

const PROBE_BYTES = 32;

export type SelfTestStep = 'write' | 'read' | 'compare' | 'delete';

export interface SelfTestResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly step?: SelfTestStep;
  readonly notConfigured?: true;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Write, read back, compare and delete one small object.
 *
 * Exported so the steps can be exercised against a store that fails on
 * purpose; the route below is a thin, guarded wrapper around it.
 */
export async function runStorageSelfTest(store: ObjectStore): Promise<SelfTestResult> {
  const startedAt = Date.now();
  const key = `${SELF_TEST_PREFIX}/${randomUUID()}.bin`;
  const probe = new Uint8Array(randomBytes(PROBE_BYTES));
  let step: SelfTestStep = 'write';
  let written = false;

  const failed = (error: unknown): SelfTestResult => {
    log.error('storage self-test failed', { step, ...internalErrorFields(error) });
    return { ok: false, latencyMs: Date.now() - startedAt, step };
  };

  try {
    await store.put(key, probe, 'application/octet-stream');
    written = true;

    step = 'read';
    const back = await store.get(key);
    if (back === null) return failed(new Error('The test object was not found after writing.'));

    step = 'compare';
    if (!sameBytes(back, probe)) {
      return failed(new Error('The test object read back differs from what was written.'));
    }

    step = 'delete';
    await store.delete(key);
    written = false;
    // The cheap existence check every store has: a read of the deleted key.
    if ((await store.get(key)) !== null) {
      return failed(new Error('The test object is still present after deleting it.'));
    }
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error: unknown) {
    return failed(error);
  } finally {
    /*
     * NEVER LEAVE THE TEST FILE BEHIND. Reached with `written` still true only
     * when a step after the write failed. A failure here is logged and
     * swallowed: the answer already says the test failed, and at which step.
     */
    if (written) {
      await store.delete(key).catch((error: unknown) => {
        log.error('storage self-test could not remove its test object', {
          ...internalErrorFields(error),
        });
      });
    }
  }
}

export function registerInternalStorageRoutes(app: FastifyInstance): void {
  route(
    app,
    'POST',
    '/v1/internal/storage/self-test',
    { scope: 'internal', idempotent: false },
    async (req, reply) => {
      if (!callerIsTrusted(req)) {
        // 404, not 401 — the same reasoning as the email delivery route.
        return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      }

      let store: ObjectStore;
      try {
        /*
         * Built per request, from the same factory and the same environment
         * every upload in this process uses. A test is rare; holding a second
         * cached client for it would buy nothing.
         */
        store = createObjectStore({ appEnv: process.env['APP_ENV'] ?? 'development' });
      } catch (error: unknown) {
        // Production with incomplete STORAGE_*: the factory refuses, by design.
        log.error('storage self-test: no object store is configured', {
          ...internalErrorFields(error),
        });
        const answer: SelfTestResult = {
          ok: false,
          latencyMs: 0,
          step: 'write',
          notConfigured: true,
        };
        return reply.send(answer);
      }

      const answer = await runStorageSelfTest(store);
      return reply.send(answer);
    },
  );
}
