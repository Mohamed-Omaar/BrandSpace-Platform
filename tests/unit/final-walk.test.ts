import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { messages } from '../../apps/dashboard/src/i18n/messages';

/**
 * FINAL WALK (master plan item 7) — what the walk on the beta configuration
 * found, pinned where a source-level check is the honest test. The rendered
 * result is in the walk's screenshots; the floating Copilot and the opaque
 * notifications popover also have their own E2E checks
 * (`final-walk-copilot-clear`, `f103-notification-contrast`).
 */

const read = (path: string) => readFileSync(path, 'utf8');
const css = read('packages/ui/src/prototype.css');

/** The declarations of the first top-level rule for `selector`. */
function rule(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, selector).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('\n}', start));
}

describe('every overlay is fully opaque (owner, must-check 2)', () => {
  for (const selector of [
    '.bsp-ntf',
    '.bsp-menu',
    '.bsp-cal-pop',
    '.bsp-cal-popx',
    '.bsp-post-menu',
    '.bsp-fdis-panel',
    '.bsp-st-when',
    '.bsp-au-menu',
    '.bsp-toast',
    '.bsp-lbx',
  ]) {
    it(`${selector} has a solid background and no backdrop filter`, () => {
      const body = rule(selector);
      expect(body).toMatch(/background: #fff;/);
      expect(body).not.toMatch(/background: rgba\(255, 255, 255, 0\./);
      expect(body).not.toMatch(/backdrop-filter/);
    });
  }
});

describe('nothing AI-only is drawn while no AI task can run (must-check 3, Q9)', () => {
  it('Home draws the AI credits figure only while some AI task can run', () => {
    const home = read('apps/dashboard/src/app/[locale]/overview/page.tsx');
    expect(home).toContain('const anyAi = Object.values(await aiAvailability()).some(Boolean);');
    expect(home).toContain(
      'const mayReadCredits = mayReadCreditBalance(workspace.permissionKeys) && anyAi;',
    );
    expect(home).toContain('repeat(${anyAi ? 4 : 3}, minmax(0, 1fr))');
  });

  it('Media: the AI chip, the AI images row and the subtitle follow image generation', () => {
    const view = read('apps/dashboard/src/app/[locale]/assets/asset-library-view.tsx');
    const page = read('apps/dashboard/src/app/[locale]/assets/page.tsx');
    expect(view).toContain(
      ".filter(([id]) => id !== 'ai' || can.generate || filters.view === 'ai')",
    );
    expect(view).toContain(".filter((row) => row.key !== 'ai' || can.generate || row.files > 0)");
    expect(page).toContain("t(imageAi ? 'assets.media.subtitle' : 'assets.media.subtitleNoAi')");
  });

  it('Posts, Automations and Intelligence empty states promise AI only while it can run', () => {
    expect(read('apps/dashboard/src/app/[locale]/content/page.tsx')).toContain(
      "key === 'content.emptyBody' && !aiCaption ? t('content.emptyBodyManual') : t(key)",
    );
    expect(read('apps/dashboard/src/app/[locale]/automations/page.tsx')).toContain(
      "t(mayCopilot ? 'automations.emptyBody' : 'automations.emptyBodyManual')",
    );
    expect(read('apps/dashboard/src/app/[locale]/intelligence/page.tsx')).toContain(
      "t(aiAnalyse ? 'intelligence.emptyBody' : 'intelligence.emptyBodyManual')",
    );
  });

  it('Brand Brain offers no chat (tab, Ask the brand, the orb centre) while it cannot run', () => {
    const view = read('apps/dashboard/src/app/[locale]/brand-brain/brand-brain-view.tsx');
    expect(view).toContain(
      "...(chatOff ? [] : [{ id: 'chat' as const, label: t('bb.tab.chat') }]),",
    );
    expect(view).toContain('onOpenChat={chatOff ? null : () => openChat(null)}');
    expect(view).toMatch(
      /\{chatOff \? null : \(\s*<button[\s\S]*?data-testid="brand-brain-ask-brand"/,
    );
    expect(read('apps/dashboard/src/app/[locale]/brand-brain/page.tsx')).toContain(
      "t(aiChat ? 'hint.brain' : 'hint.brainNoChat')",
    );
  });

  it('none of the AI-off wording mentions AI, the Copilot or an analysis', () => {
    for (const locale of ['en', 'ar'] as const) {
      for (const key of [
        'assets.media.subtitleNoAi',
        'content.emptyBodyManual',
        'automations.emptyBodyManual',
        'intelligence.emptyBodyManual',
        'hint.brainNoChat',
        'bb.orbHintNoChat',
      ] as const) {
        const text = (messages[locale] as Record<string, string>)[key];
        expect(text, `${locale} ${key}`).toBeTruthy();
        expect(text, `${locale} ${key}`).not.toMatch(
          /\bAI\b|Copilot|generat|analys|ذكاء|المساعد|تحليل|تحدّث مع العلامة/i,
        );
      }
    }
  });
});

describe('the beta never claims a scan it does not run (D-511)', () => {
  it('an empty library and a new version say nothing about scanning', () => {
    const view = read('apps/dashboard/src/app/[locale]/assets/asset-library-view.tsx');
    expect(view).toContain("? t('assets.emptyBodyNotScanned')");
    for (const locale of ['en', 'ar'] as const) {
      const text = (messages[locale] as Record<string, string>)['assets.emptyBodyNotScanned'];
      expect(text).toBeTruthy();
      expect(text).not.toMatch(/scan|فحص|يُفحص/i);
    }
    expect(read('apps/dashboard/src/i18n/messages.ts')).toContain(
      "en: 'New version uploaded. It replaces the current file once it is ready.',",
    );
  });
});

describe('small defects the walk found', () => {
  it('one fact and one account read in the singular', () => {
    expect(messages.en['bb.chatSubFacts.one']).toBe('Answers from 1 approved fact');
    expect(messages.en['setup.wz.ready.facts.one']).toBe('approved fact');
    expect(messages.en['setup.wz.ready.accounts.one']).toBe('account connected');
  });

  it('the preview handle keeps only letters, digits, "." and "_"', () => {
    const composer = read('apps/dashboard/src/app/[locale]/content/compose/composer-view.tsx');
    expect(composer).toContain("brandName.replace(/[^\\p{L}\\p{N}._]+/gu, '').toLowerCase()");
    const handle = (name: string) => `@${name.replace(/[^\p{L}\p{N}._]+/gu, '').toLowerCase()}`;
    expect(handle("Sara's Bakery")).toBe('@sarasbakery');
    expect(handle('مخبز سارة')).toBe('@مخبزسارة');
  });

  it('a key question answered from Brand Brain sends its key hidden, never as a field', () => {
    const drawer = read('apps/dashboard/src/app/[locale]/brand-brain/area-drawer.tsx');
    expect(drawer).toMatch(/type="hidden"\s*name="itemKey"\s*value=\{chosen\.itemKey\}/);
  });

  it('"Mark all as read" is offered only while something is unread', () => {
    const bell = read('apps/dashboard/src/components/notifications-bell.tsx');
    expect(bell).toMatch(
      /\{shown\.some\(\(item\) => item\.unread\) \? \(\s*<form action=\{markAllNotificationsReadAction\}>/,
    );
  });

  it('an empty library says no "Latest 0 of 0 files" and offers no "Videos (largest)"', () => {
    const page = read('apps/dashboard/src/app/[locale]/assets/page.tsx');
    expect(page).toContain('page.total === null || page.total === 0');
    const view = read('apps/dashboard/src/app/[locale]/assets/asset-library-view.tsx');
    expect(view).toMatch(
      /props\.storageCategories\.some\(\(row\) => row\.key === 'videos' && row\.files > 0\) \? \(\s*<a/,
    );
  });

  it('Home says nothing is waiting and no channel is connected in words, never "0"', () => {
    const home = read('apps/dashboard/src/app/[locale]/overview/page.tsx');
    expect(home).toMatch(/pendingApprovals > 0 \? \([\s\S]*?t\('home\.p\.waitingApprovalNone'\)/);
    expect(home).toMatch(
      /'home\.p\.kPubSub\.none',\s*'home\.p\.kPubSub\.one',\s*'home\.p\.kPubSub\.two',/,
    );
    expect(messages.en['home.p.waitingApprovalNone']).toBe('Nothing waiting for your approval');
    expect(messages.en['home.p.kPubSub.none']).toBe('Last 28 days · no channels connected');
    expect(messages.en['home.p.kPubSub.one']).toBe('Last 28 days · 1 channel');
    for (const key of [
      'home.p.waitingApprovalNone',
      'home.p.kPubSub.none',
      'home.p.kPubSub.one',
      'home.p.kPubSub.two',
    ] as const) {
      expect(messages.ar[key], key).toBeTruthy();
      expect(messages.ar[key], key).not.toMatch(/\b0\b/);
    }
  });

  it('Brand Brain says what uses its facts only while AI can run', () => {
    const drawer = read('apps/dashboard/src/app/[locale]/brand-brain/area-drawer.tsx');
    expect(drawer).toMatch(
      /permissions\.aiOff === true \? null : \(?\s*<p className="bsp-bb-wait-foot">/,
    );
    const page = read('apps/dashboard/src/app/[locale]/brand-brain/page.tsx');
    expect(page).toContain('const aiAny = Object.values(await aiAvailability()).some(Boolean);');
    expect(page).toContain('aiOff: !aiAny,');
  });

  it('Brand Brain promises no AI writing, and Performance shows no red badge, on the beta', () => {
    const page = read('apps/dashboard/src/app/[locale]/brand-brain/page.tsx');
    expect(page).toContain("t(aiAny ? 'bb.pageSub' : 'bb.pageSubNoAi')");
    const view = read('apps/dashboard/src/app/[locale]/brand-brain/brand-brain-view.tsx');
    expect(view).toContain("t(permissions.aiOff === true ? 'bb.leadNoAi' : 'bb.lead')");
    for (const locale of ['en', 'ar'] as const) {
      for (const key of ['bb.pageSubNoAi', 'bb.leadNoAi'] as const) {
        const text = (messages[locale] as Record<string, string>)[key];
        expect(text, `${locale} ${key}`).toBeTruthy();
        expect(text, `${locale} ${key}`).not.toMatch(/draft|writes|مسود|يكتب/i);
      }
    }
    expect(read('apps/dashboard/src/app/[locale]/analytics/page.tsx')).toContain(
      "data.summary.connectionCount === 0 ? 'bsp-neu'",
    );
  });

  it("Home's checklist offers no step that cannot be done on the beta", () => {
    const home = read('apps/dashboard/src/app/[locale]/overview/page.tsx');
    expect(home).toContain(
      "ok: may('integrations.manage') && (connectable.length > 0 || setup.connections > 0),",
    );
    expect(home).toContain(
      "const canScheduleStep = may('content.schedule') && connectable.length > 0;",
    );
    expect(home).toContain(
      "label: canScheduleStep ? t('home.p.stepSchedule') : t('home.p.stepSubmit'),",
    );
  });

  it('a derived figure with no connected account says so, like every other figure', () => {
    const queries = read('packages/analytics/src/queries.ts');
    const reason = queries.slice(queries.indexOf('#absenceReason(metricKey'));
    expect(reason.indexOf("return 'no_connection'")).toBeLessThan(
      reason.indexOf("return 'components_missing'"),
    );
  });
});
