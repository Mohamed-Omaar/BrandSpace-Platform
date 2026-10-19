import { translator, type MessageKey } from '../i18n/messages';
import { simpleCopy, type SimpleKey } from '../i18n/simple';
import type { ConsoleMode } from '../server/console-mode';

/**
 * THE CONTROL CENTER'S TWO NAVIGATIONS, AS DATA (D-308).
 *
 * Plain data so it can be tested without rendering: which routes each mode
 * lists, in what order, behind which permission. The shell turns it into
 * links and icons.
 *
 * FILTERING BY PERMISSION HERE IS A CONVENIENCE. Every page calls
 * `requirePageActor` and answers 404 without its permission, and every action
 * calls `requirePlatformActor`. The mode changes which of the reader's
 * permitted screens are LISTED, never which they may open.
 */

export type ConsoleIcon =
  | 'home'
  | 'building'
  | 'lifebuoy'
  | 'sliders'
  | 'key'
  | 'flag'
  | 'layers'
  | 'plug'
  | 'spark'
  | 'route'
  | 'list'
  | 'pulse'
  | 'credit';

export interface ConsoleNavItem {
  /** Path after `/console`. */
  readonly href: string;
  readonly permission: string;
  readonly icon: ConsoleIcon;
  /** The rail label and the longer top-bar title, in the reader's language. */
  readonly label: (locale: string) => string;
  readonly title: (locale: string) => string;
  /** The end-to-end hook. Advanced keeps the existing `nav-nav.*` names. */
  readonly testId: string;
  /** Known to the shell for its title, never drawn (D-308). */
  readonly hidden?: boolean;
}

export interface ConsoleNavSection {
  readonly title?: { readonly ar: string; readonly en: string };
  readonly items: readonly ConsoleNavItem[];
}

function advanced(
  href: string,
  key: MessageKey,
  titleKey: MessageKey,
  permission: string,
  icon: ConsoleIcon,
): ConsoleNavItem {
  return {
    href,
    permission,
    icon,
    label: (locale) => translator(locale)(key),
    title: (locale) => translator(locale)(titleKey),
    testId: `nav-${key}`,
  };
}

function simple(
  href: string,
  key: SimpleKey,
  titleKey: SimpleKey,
  permission: string,
  icon: ConsoleIcon,
  hidden = false,
): ConsoleNavItem {
  return {
    href,
    permission,
    icon,
    label: (locale) => simpleCopy(locale)(key),
    title: (locale) => simpleCopy(locale)(titleKey),
    testId: `nav-${key}`,
    ...(hidden ? { hidden: true } : {}),
  };
}

/**
 * SIMPLE — the owner's everyday control panel (owner decision, Control Center
 * Simple mode; was the contract's eight destinations, §4). Grouped the way the
 * owner thinks about the business: what is sold, what customers use, the
 * rules around sign-up and email, and running the platform. Support and the
 * raw audit log stay Advanced tools (§19); the change history here is the
 * configuration changes only, in plain words.
 */
export const SIMPLE_SECTIONS: readonly ConsoleNavSection[] = [
  {
    items: [
      simple('', 'nav.home', 'page.home', 'platform.workspace.read', 'home'),
      simple(
        '/workspaces',
        'nav.customers',
        'page.customers',
        'platform.workspace.read',
        'building',
      ),
      simple(
        '/manage',
        'nav.manage',
        'page.manage',
        'platform.configuration.read',
        'sliders',
        true,
      ),
    ],
  },
  {
    title: { ar: 'ما تبيعه', en: 'What you sell' },
    items: [
      simple('/plans', 'nav.plans', 'page.plans', 'platform.configuration.read', 'layers'),
      simple('/manage/trial', 'nav.trial', 'page.trial', 'platform.configuration.read', 'credit'),
      simple('/features', 'nav.features', 'page.features', 'platform.configuration.read', 'flag'),
    ],
  },
  {
    title: { ar: 'ما يستخدمه العملاء', en: 'What customers use' },
    items: [
      simple(
        '/manage/channels',
        'nav.channels',
        'page.channels',
        'platform.configuration.read',
        'route',
      ),
      simple(
        '/manage/publishing',
        'nav.publishing',
        'page.publishing',
        'platform.configuration.read',
        'plug',
      ),
      simple(
        '/manage/content',
        'nav.content',
        'page.content',
        'platform.configuration.read',
        'list',
      ),
      simple(
        '/manage/uploads',
        'nav.uploads',
        'page.uploads',
        'platform.configuration.read',
        'layers',
      ),
      simple('/ai', 'nav.ai', 'page.ai', 'platform.configuration.read', 'spark'),
      simple(
        '/ai/connect',
        'nav.ai',
        'page.aiConnect',
        'platform.configuration.read',
        'spark',
        true,
      ),
      simple(
        '/ai/profile',
        'nav.ai',
        'page.aiProfile',
        'platform.configuration.read',
        'spark',
        true,
      ),
      // D-566 — customers connecting Claude, ChatGPT or another AI app.
      simple('/manage/ai-apps', 'nav.aiApps', 'page.aiApps', 'platform.configuration.read', 'plug'),
    ],
  },
  {
    title: { ar: 'التسجيل والبريد والقواعد', en: 'Sign-up, email and rules' },
    items: [
      simple(
        '/manage/signups',
        'nav.signups',
        'page.signups',
        'platform.configuration.read',
        'key',
      ),
      simple('/manage/email', 'nav.email', 'page.email', 'platform.configuration.read', 'lifebuoy'),
      simple('/manage/legal', 'nav.legal', 'page.legal', 'platform.configuration.read', 'list'),
      simple(
        '/integrations',
        'nav.integrations',
        'page.integrations',
        'platform.configuration.read',
        'plug',
      ),
    ],
  },
  {
    title: { ar: 'تشغيل المنصة', en: 'Running the platform' },
    items: [
      simple('/usage', 'nav.usage', 'page.usage', 'platform.workspace.read', 'credit'),
      simple('/health', 'nav.system', 'page.system', 'platform.workspace.read', 'pulse'),
      simple('/team', 'nav.team', 'page.team', 'platform.user.read', 'building'),
      simple('/changes', 'nav.changes', 'page.changes', 'platform.audit.read', 'list'),
    ],
  },
];

/**
 * ADVANCED — the existing technical navigation, unchanged in order, labels,
 * permissions and test hooks.
 */
export const ADVANCED_SECTIONS: readonly ConsoleNavSection[] = [
  {
    title: { ar: 'العملاء', en: 'Customers' },
    items: [
      advanced('', 'nav.overview', 'page.overview', 'platform.workspace.read', 'home'),
      advanced(
        '/workspaces',
        'nav.workspaces',
        'page.workspaces',
        'platform.workspace.read',
        'building',
      ),
      advanced(
        '/support',
        'nav.support',
        'page.support',
        'platform.support_mode.enter',
        'lifebuoy',
      ),
    ],
  },
  {
    title: { ar: 'المنصة', en: 'Platform' },
    items: [
      advanced(
        '/configuration',
        'nav.configuration',
        'page.configuration',
        'platform.configuration.read',
        'sliders',
      ),
      advanced('/secrets', 'nav.secrets', 'page.secrets', 'platform.secret.read', 'key'),
      advanced('/flags', 'nav.flags', 'page.flags', 'platform.configuration.read', 'flag'),
      advanced('/plans', 'nav.plans', 'page.plans', 'platform.configuration.read', 'layers'),
      advanced(
        '/features',
        'nav.features',
        'page.features',
        'platform.configuration.read',
        'sliders',
      ),
    ],
  },
  {
    title: { ar: 'الذكاء الاصطناعي والتكاملات', en: 'AI & integrations' },
    items: [
      /*
       * Phase 10 — the Integrations Hub, FIRST in this section deliberately.
       * It is the one screen that answers "what is this platform connected
       * to"; the three below it are the detailed views of one slice each.
       */
      advanced(
        '/integrations',
        'nav.integrations',
        'page.integrations',
        'platform.configuration.read',
        'plug',
      ),
      advanced(
        '/providers',
        'nav.providers',
        'page.providers',
        'platform.configuration.read',
        'layers',
      ),
      advanced(
        '/ai-models',
        'nav.aiRegistry',
        'page.aiRegistry',
        'platform.configuration.read',
        'spark',
      ),
      advanced('/routing', 'nav.routing', 'page.routing', 'platform.configuration.read', 'route'),
    ],
  },
  {
    title: { ar: 'العمليات', en: 'Operations' },
    items: [
      advanced('/audit', 'nav.audit', 'page.audit', 'platform.audit.read', 'list'),
      // Its own authority, not "View any workspace": AI usage is a
      // per-workspace financial record (R-02's lesson).
      advanced('/ai-usage', 'nav.aiUsage', 'page.aiUsage', 'platform.ai.usage.read', 'spark'),
      advanced('/health', 'nav.health', 'page.health', 'platform.workspace.read', 'pulse'),
    ],
  },
];

function hideAll(sections: readonly ConsoleNavSection[]): ConsoleNavItem[] {
  return sections.flatMap((section) => section.items.map((item) => ({ ...item, hidden: true })));
}

/**
 * The sections a mode draws, plus — hidden — every route of the other mode,
 * so a screen opened by URL still carries its title in the top bar.
 */
export function consoleNavigation(mode: ConsoleMode): readonly ConsoleNavSection[] {
  const own = mode === 'simple' ? SIMPLE_SECTIONS : ADVANCED_SECTIONS;
  const other = mode === 'simple' ? ADVANCED_SECTIONS : SIMPLE_SECTIONS;
  const ownHrefs = new Set(own.flatMap((section) => section.items.map((item) => item.href)));
  const extra = hideAll(other).filter((item) => !ownHrefs.has(item.href));
  return extra.length > 0 ? [...own, { items: extra }] : own;
}

/**
 * Routes that exist only as Advanced screens. Opened in Simple mode they
 * render normally, with a note offering the switch — never a redirect and
 * never a 404, because the mode is not an access control.
 */
export const ADVANCED_ONLY_PATHS: readonly string[] = (() => {
  const simpleHrefs = new Set(SIMPLE_SECTIONS.flatMap((s) => s.items.map((i) => i.href)));
  return ADVANCED_SECTIONS.flatMap((s) => s.items.map((i) => i.href)).filter(
    (href) => !simpleHrefs.has(href),
  );
})();
