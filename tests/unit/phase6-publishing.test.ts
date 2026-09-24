import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAILURE_BEHAVIOUR } from '@brandspace/social-connectors';
import { messages } from '../../apps/dashboard/src/i18n/messages';

/**
 * PHASE 6 FINAL · D-277 §33, D-291 — PUBLISHING.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('D-291 · reconnect, then retry', () => {
  const pipeline = read('packages/social-connectors/src/publishing.ts');

  it('only account failures qualify, and none of them is indeterminate', () => {
    const classes = /RECONNECT_RETRY_CLASSES[^[]*\[([^\]]*)\]/.exec(pipeline)?.[1] ?? '';
    const listed = [...classes.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]);
    expect(listed.sort()).toEqual(['AUTH_EXPIRED', 'AUTH_REVOKED', 'INSUFFICIENT_SCOPE']);
    for (const failureClass of listed) {
      expect(FAILURE_BEHAVIOUR[failureClass as keyof typeof FAILURE_BEHAVIOUR].indeterminate).toBe(
        false,
      );
    }
  });

  it('the same account reconnects in place instead of colliding with its live row', () => {
    const oauth = read('packages/social-connectors/src/oauth.ts');
    expect(oauth).toContain("action: 'social.connection.reconnected'");
    expect(oauth).toMatch(/status: \{ in: \['PENDING', 'ACTIVE', 'NEEDS_REAUTH'\] \}/);
  });

  it('the screen retries only on a person’s click — no effect, no timer', () => {
    const page = read('apps/dashboard/src/app/[locale]/publishing/page.tsx');
    expect(page).toContain('retryOnReconnectedAction');
    expect(page).not.toMatch(/useEffect|setTimeout|setInterval/);
  });

  it('every new Publishing string exists in both languages', () => {
    for (const key of [
      'publishingHub.readiness.ready',
      'publishingHub.readiness.reconnect',
      'publishingHub.reconnected',
      'publishingHub.retryAfterReconnect',
      'publishingHub.retryAfterReconnectLink',
    ] as const) {
      expect(messages.en[key], key).toBeTruthy();
      expect(messages.ar[key], key).toBeTruthy();
    }
  });
});
