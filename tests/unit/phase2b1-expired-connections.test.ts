import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfigPayload } from '@brandspace/config';
import { optionalMessage } from '../../apps/dashboard/src/i18n/messages';
import {
  awaitsReconnect,
  isBlocking,
  needsAttention,
} from '../../apps/dashboard/src/server/publish-readiness';

/**
 * Q9 / A11 (prototype v94 Phase 2B-1, D-332) — an expired connection warns and
 * does not block; its channel WAITS for the account and then fails with the
 * reason; a revoked one is refused. The database half is
 * `tests/isolation/phase2b1-reconnect-hold.test.ts`.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('Q9 · what warns and what blocks', () => {
  it('EXPIRED warns; REVOKED, NOT_CONNECTED and UNSUPPORTED block', () => {
    expect(isBlocking('EXPIRED')).toBe(false);
    expect(needsAttention('EXPIRED')).toBe(true);
    expect(isBlocking('REVOKED')).toBe(true);
    expect(needsAttention('EXPIRING')).toBe(false);
  });

  it('an account awaits reconnection when the platform asked, or its token ran out — never when revoked', () => {
    expect(awaitsReconnect({ status: 'NEEDS_REAUTH', publishable: false })).toBe(true);
    expect(awaitsReconnect({ status: 'ACTIVE', publishable: false })).toBe(true);
    expect(awaitsReconnect({ status: 'ACTIVE', publishable: true })).toBe(false);
    expect(awaitsReconnect({ status: 'REVOKED', publishable: false })).toBe(false);
    expect(awaitsReconnect({ status: 'DISABLED', publishable: false })).toBe(false);
  });
});

describe('Q9 · the hold is real', () => {
  const pipeline = read('packages/social-connectors/src/publishing.ts');

  it('materialises a job for an account that needs reconnecting', () => {
    expect(pipeline).toMatch(/status: \{ in: \['ACTIVE', 'NEEDS_REAUTH'\] \}/);
  });

  it('holds before the deadline and fails with the reconnect reason after it', () => {
    // W1 (connectors A): the claim step returns a settled answer, so the hold is wrapped.
    expect(pipeline).toContain(
      'if (preflight === AWAITING_RECONNECT) return settled(await this.#holdForReconnect(job));',
    );
    expect(pipeline).toMatch(
      /preflight === RECONNECT_TOO_LATE\)[\s\S]{0,80}'NOT_CONNECTED', RECONNECT_REQUIRED_CODE/,
    );
  });

  it('re-checks on a configured interval, 60 seconds unless an operator changes it', () => {
    const publishing = parseConfigPayload('publishing', {}) as {
      dispatch: { reconnectRecheckSeconds: number; latenessToleranceMinutes: number };
    };
    expect(publishing.dispatch.reconnectRecheckSeconds).toBe(60);
    expect(publishing.dispatch.latenessToleranceMinutes).toBe(120);
  });

  it('dispatches each scheduled attempt under its own queue id, so a held job is looked at again', () => {
    const scheduler = read('apps/api/src/scheduler.ts');
    expect(scheduler).toContain(
      'idempotencyKey: `${job.idempotencyKey}-${job.nextAttemptAt?.getTime() ?? 0}`',
    );
  });

  it('the publishing log says why a job waits and why it failed, in both languages', () => {
    for (const code of ['preflight.awaiting_reconnect', 'preflight.reconnect_required']) {
      expect(optionalMessage('en', `publishing.code.${code}`), code).toMatch(/reconnect/i);
      expect(optionalMessage('ar', `publishing.code.${code}`), code).toMatch(/[؀-ۿ]/);
    }
  });
});

describe('Q9 · a revoked channel is refused on the server, by every caller', () => {
  it('every production ContentCalendarService is given the channel gate', () => {
    const offenders: string[] = [];
    let total = 0;
    for (const app of ['api', 'dashboard', 'worker']) {
      for (const file of sources(path.join(root, 'apps', app, 'src'))) {
        const source = readFileSync(file, 'utf8');
        const constructions = source.split('new ContentCalendarService({').slice(1);
        total += constructions.length;
        for (const body of constructions) {
          const call = body.slice(0, body.indexOf('})'));
          if (!call.includes('channelGate: unreachableChannelGate(')) {
            offenders.push(path.relative(root, file));
          }
        }
      }
    }
    // The seven places the calendar is built today — found, not assumed.
    expect(total).toBeGreaterThanOrEqual(7);
    expect(offenders).toEqual([]);
  });

  it('the calendar says why, in both languages', () => {
    const actions = read('apps/dashboard/src/app/[locale]/calendar/actions.ts');
    expect(actions).toContain('CHANNEL_DISCONNECTED_REASON');
    const messages = read('apps/dashboard/src/i18n/messages.ts');
    expect(messages).toMatch(/CHANNEL_DISCONNECTED: \{\s+en: '[^']+',\s+ar: '[^']+'/);
  });
});

describe('Q9 · the Studio says "Expired" once, with its explanation as the line\'s tooltip (D-570)', () => {
  it('the status says "Expired"; the explanation is in a tooltip the short line describes itself with', () => {
    const editor = read('apps/dashboard/src/app/[locale]/content/compose/draft-editor.tsx');
    const card = read('apps/dashboard/src/app/[locale]/content/compose/check-card.tsx');
    // The draft hands the card the status word and the explanation, as before.
    expect(editor).toMatch(
      /expiredLabel=\{expired\?\.label\}\s*expiredExplanation=\{expired\?\.explanation\}/,
    );
    // Said once: the issue list no longer repeats "Expired" and its explanation.
    expect(editor).not.toContain('editor-channel-expired-');
    // The explanation is not removed: it is the tooltip's text, and the focusable
    // short line names it as its description (hover, keyboard, screen reader).
    expect(card).toMatch(/role="tooltip"\s*id=\{tipId\}[\s\S]{0,200}\{explanation\}/);
    expect(card).toMatch(
      /tabIndex=\{explanation \? 0 : undefined\}\s*aria-describedby=\{explanation \? tipId : undefined\}/,
    );
    expect(card).toMatch(/onFocus=\{\(\) => setTipOpen\(true\)\}/);
    expect(card).toMatch(/event\.key === 'Escape'/);
    expect(optionalMessage('en', 'calendar.readiness.EXPIRED')).toBe('Expired');
    expect(optionalMessage('en', 'readiness.expiredExplanation')).toMatch(
      /waits[\s\S]*\{minutes\}[\s\S]*other channels go out on time/,
    );
    // And in Arabic: the status word once, the explanation in the tooltip.
    expect(optionalMessage('ar', 'calendar.readiness.EXPIRED')).toBe('منتهي الصلاحية');
    expect(optionalMessage('ar', 'readiness.expiredExplanation')).toContain('{minutes}');
  });
});
