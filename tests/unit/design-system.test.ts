import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PLATFORM_ASPECTS,
  breakpointTokens,
  colorTokens,
  layoutTokens,
  mediaAtLeast,
  mediaBelow,
  motionTokens,
  radiusTokens,
  spacingTokens,
  statusTone,
  typographyTokens,
  webfontHref,
  zIndexTokens,
} from '@brandspace/ui';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function read(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

/**
 * The file with its comments removed.
 *
 * Several assertions below are about what the CODE does, and this file's own
 * documentation legitimately names the things they forbid — `next/font`,
 * `design-system`, hex values. Scanning the raw text made two of these tests
 * fail on their own explanation, which is a test measuring prose rather than
 * behaviour.
 */
function readCode(relative: string): string {
  return read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Every `.ts`/`.tsx` file under a directory, as repository-relative paths.
 *
 * Walks the real source tree rather than `git ls-files`, so a file added and
 * not yet committed is still covered by the scans that use it.
 */
function collectSourceFiles(directory: string): string[] {
  const absolute = path.join(REPO_ROOT, directory);
  if (!existsSync(absolute)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(absolute)) {
    const full = path.join(absolute, entry);
    if (statSync(full).isDirectory()) {
      found.push(...collectSourceFiles(path.join(directory, entry)));
    } else if (/\.tsx?$/.test(entry)) {
      found.push(path.join(directory, entry));
    }
  }
  return found;
}

/**
 * The design system's structural promises.
 *
 * These are the rules a reviewer would otherwise have to re-check by eye on
 * every pull request: that colours live in one file, that the CSS and the
 * TypeScript agree, that RTL uses logical properties, and that the showcase
 * cannot run in production. Each one has already been broken at least once in
 * this repository, which is why each one is a test rather than a paragraph.
 */

describe('the token scale is complete and coherent', () => {
  it('exposes every scale the shell and its tests depend on', () => {
    expect(Object.keys(spacingTokens).length).toBeGreaterThanOrEqual(8);
    expect(Object.keys(typographyTokens).length).toBeGreaterThanOrEqual(9);
    expect(Object.keys(radiusTokens)).toContain('full');
    expect(Object.keys(motionTokens)).toContain('easeOut');
    expect(layoutTokens.sidebarExpanded).not.toBe(layoutTokens.sidebarCollapsed);
  });

  it('covers the four widths the quality gate exercises', () => {
    // 390 (phone), 768 (tablet), 1280 and 1440 (desktop) — §9.
    expect(breakpointTokens.md).toBe(768);
    expect(breakpointTokens.xl).toBe(1280);
    expect(breakpointTokens['2xl']).toBe(1440);
    expect(mediaAtLeast('md')).toBe('(min-width: 768px)');
    // `mediaBelow` must not overlap `mediaAtLeast`, or a layout is briefly both.
    expect(mediaBelow('md')).toBe('(max-width: 767px)');
  });

  it('orders the stacking scale so an overlay cannot land behind a header', () => {
    expect(zIndexTokens.sticky).toBeLessThan(zIndexTokens.drawer);
    expect(zIndexTokens.drawer).toBeLessThan(zIndexTokens.dialog);
    expect(zIndexTokens.dialog).toBeLessThan(zIndexTokens.toast);
    expect(zIndexTokens.toast).toBeLessThan(zIndexTokens.tooltip);
    expect(zIndexTokens.tooltip).toBeLessThan(zIndexTokens.skipLink);
  });

  it('keeps every pointer target at or above the WCAG 2.2 minimum', () => {
    expect(layoutTokens.minTargetSize).toBe('24px');
    expect(parseFloat(layoutTokens.controlHeight)).toBeGreaterThanOrEqual(2);
  });
});

describe('the CSS mirror cannot drift from the TypeScript tokens', () => {
  const css = read('packages/ui/src/tokens.css');

  it.each([
    ['--bs-brand-purple', colorTokens.brandPurple],
    ['--bs-brand-purple-tint', colorTokens.brandPurpleTint],
    ['--bs-brand-yellow', colorTokens.brandYellow],
    ['--bs-surface', colorTokens.surface],
    ['--bs-app-background', colorTokens.appBackground],
    ['--bs-border-strong', colorTokens.borderStrong],
    ['--bs-text-primary', colorTokens.textPrimary],
    ['--bs-danger', colorTokens.danger],
    ['--bs-focus-ring', colorTokens.focusRing],
  ])('%s matches its TypeScript token', (variable, value) => {
    const match = css.match(new RegExp(`${variable}:\\s*([^;]+);`));
    expect(match, `${variable} is missing from tokens.css`).not.toBeNull();
    expect(match?.[1]?.trim().toLowerCase()).toBe(value.toLowerCase());
  });

  it('honours prefers-reduced-motion once, globally', () => {
    // Honoured in the stylesheet so no component has to remember (WCAG 2.3.3).
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('never removes the focus indicator', () => {
    expect(css).toContain(':focus-visible');
    expect(css).not.toMatch(/outline:\s*(none|0)\s*;/);
  });

  it('switches the sidebar and the drawer at the md breakpoint, in CSS', () => {
    // A layout decided by measuring the viewport in JavaScript flickers on
    // first paint and differs between server and client.
    expect(css).toContain(`@media (min-width: ${breakpointTokens.md}px)`);
    expect(css).toContain('.bs-sidebar');
    expect(css).toContain('.bs-drawer-trigger');
  });
});

describe('applications hold no colour literals', () => {
  /**
   * THE RULE THIS ENFORCES: CLAUDE.md §4 — brand colours are design tokens,
   * never literals in components. Before Phase 2C, seven semantic tints were
   * hard-coded across three files, and the two consoles had drifted.
   *
   * The scan walks the real source tree rather than `git ls-files`, so a file
   * added and not yet committed is still covered.
   */
  const SOURCE_DIRECTORIES = ['apps/dashboard/src', 'apps/admin/src', 'apps/web/src'];

  const files = SOURCE_DIRECTORIES.flatMap(collectSourceFiles);

  it('scans a meaningful number of files, so a passing result is not vacuous', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('contains no hex colour literal outside the design system', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = read(file);
      for (const [index, line] of source.split('\n').entries()) {
        // Skip comments: the token documentation legitimately names hex values.
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
        const match = line.match(/#[0-9a-fA-F]{6}\b/);
        if (match) offenders.push(`${file}:${index + 1} ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('detects a planted literal, so the scan is known to work', () => {
    const planted = "const brandColour = '#FF00FF';";
    expect(planted.match(/#[0-9a-fA-F]{6}\b/)).not.toBeNull();
  });

  it('strips comments but keeps code, so the code scans are not vacuous', () => {
    // Both halves matter: a stripper that removed everything would make every
    // `not.toContain` assertion above pass for the wrong reason.
    const shell = readCode('apps/dashboard/src/components/workspace-shell.tsx');
    expect(shell).toContain('AppShell');
    expect(shell).not.toContain('Composes `AppShell` from the design system');
  });
});

/*
 * THE BORDERLESS DIRECTION'S ONE FRAGILE JOINT.
 *
 * A control is no longer identified by an outline. Its fill, its hover, its
 * disabled state and its focus ring all come from the `.bs-control` class in
 * `tokens.css`; `inputStyle()` supplies only the geometry. So an input styled
 * with `inputStyle()` and NO class is not a slightly-off input — it is a
 * transparent rectangle on a white page, invisible until it is focused.
 *
 * This was not hypothetical: forty-three controls across the two consoles were
 * in exactly that state after the token change, because they had been written
 * when the border was doing the work. They are fixed, and this test is why the
 * next one cannot ship.
 */
describe('every form control carries the class that makes it visible', () => {
  const controlPattern = /<(input|textarea|select)\b((?:[^<>]|\{[^{}]*\})*?)\/?>/gs;
  const stylePattern = /(inputStyle|textareaStyle|authInputStyle|selectStyle)/;

  const sources = [
    ...collectSourceFiles('apps/dashboard/src'),
    ...collectSourceFiles('apps/admin/src'),
    ...collectSourceFiles('packages/ui/src'),
  ].filter((file) => file.endsWith('.tsx'));

  it('scans a meaningful number of files', () => {
    expect(sources.length).toBeGreaterThan(20);
  });

  it('gives every styled control the bs-control class', () => {
    const offenders: string[] = [];
    let scanned = 0;

    for (const file of sources) {
      const source = read(file);
      for (const match of source.matchAll(controlPattern)) {
        const attributes = match[2] ?? '';
        if (!stylePattern.test(attributes)) continue;
        scanned += 1;
        if (attributes.includes('bs-control') || attributes.includes('CONTROL_CLASS')) continue;
        const line = source.slice(0, match.index).split('\n').length;
        offenders.push(`${file}:${line} <${match[1]}>`);
      }
    }

    expect(scanned, 'no styled controls were found; the scan is broken').toBeGreaterThan(30);
    expect(offenders, 'these controls would render invisible on a white page').toEqual([]);
  });

  it('defines the class it depends on, with a fill and a focus state', () => {
    const css = read('packages/ui/src/tokens.css');
    expect(css).toContain('.bs-control {');
    expect(css).toMatch(/\.bs-control:focus-visible/);
    expect(css).toMatch(/\.bs-control:disabled/);
  });
});

describe('RTL correctness is structural, not a second stylesheet', () => {
  const shell = read('packages/ui/src/app-shell.tsx');
  const primitives = read('packages/ui/src/primitives.tsx');

  it('the shell and the primitives use logical properties', () => {
    expect(shell).toContain('insetInlineStart');
    // A logical BORDER side, whichever side the current design uses. The
    // borderless direction moved the shell's one visible edge from the
    // sidebar's start to the drawer's end, so pinning the assertion to a
    // specific side tested the design, not the property model.
    expect(shell).toMatch(/border(Inline|Block)(Start|End)/);
    expect(primitives).toContain('paddingInline');
  });

  /*
   * WIDENED, not narrowed. The scan now covers every module in the design
   * system rather than four of them, because the prototype screens added in
   * this revision (calendar, composer, Design Studio, post cards, media) lay
   * out just as much as the originals and are just as capable of pinning a
   * margin to the left.
   */
  it('uses no physical left/right layout property', () => {
    const modules = readdirSync(path.join(REPO_ROOT, 'packages/ui/src'))
      .filter((file) => file.endsWith('.tsx') || file.endsWith('.ts'))
      // `readCode`, because this very test file's neighbours document the
      // physical properties they avoid, and a comment is not a layout.
      .map((file) => [file, readCode(`packages/ui/src/${file}`)] as const);

    expect(modules.length, 'the scan found no modules to check').toBeGreaterThan(15);

    for (const [name, source] of modules) {
      // `marginLeft`, `paddingRight`, `borderLeft`, `left:`/`right:` as offsets.
      const physical = source.match(
        /\b(marginLeft|marginRight|paddingLeft|paddingRight|borderLeft|borderRight|textAlign:\s*'(left|right)')\b/,
      );
      expect(physical, `${name} uses a physical property: ${physical?.[0]}`).toBeNull();
    }
  });
});

/*
 * F-25, closed structurally.
 *
 * THE HAZARD. Everything exported from a module whose first line is
 * `'use client'` becomes a CLIENT REFERENCE. A server component that imports a
 * plain lookup table or a style helper from such a module does not get the
 * table — it gets a proxy, and either the build fails or the whole component
 * tree behind that module is dragged into the browser bundle. This has already
 * happened twice in this repository, which is why `menu-style.ts`,
 * `social-post-types.ts`, `copilot-types.ts` and `studio-presets.ts` exist as
 * neutral modules beside their components.
 *
 * THE RULE. A `'use client'` module may export React components (PascalCase),
 * hooks (`use…`), and types — which are erased at compile time and cost
 * nothing. It may NOT export a runtime value that is neither: a `const` table,
 * a `let`, or a lowercase helper function. Those belong in a neutral module,
 * where both sides of the boundary can read them.
 *
 * This is a structural test rather than an ESLint rule because the property is
 * about a module's FIRST LINE and its export names together — cheap to check
 * by reading, awkward to express as a lint rule, and impossible to forget when
 * it fails the suite.
 */
describe('a client module exports no value a server component would want', () => {
  const uiDir = path.join(REPO_ROOT, 'packages/ui/src');

  /** Every export name a module declares, with the keyword that declared it. */
  function exportsOf(source: string): readonly { kind: string; name: string }[] {
    const found: { kind: string; name: string }[] = [];
    const pattern =
      /^export\s+(async\s+)?(const|let|var|function|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm;
    for (const match of source.matchAll(pattern)) {
      found.push({ kind: match[2] ?? '', name: match[3] ?? '' });
    }
    return found;
  }

  const clientModules = readdirSync(uiDir)
    .filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'))
    .map((file) => [file, read(`packages/ui/src/${file}`)] as const)
    .filter(([, source]) => source.trimStart().startsWith("'use client'"));

  it('finds the client modules, so the check is not vacuous', () => {
    expect(clientModules.length).toBeGreaterThan(3);
  });

  it.each(clientModules.map(([file]) => file))(
    '%s exports only components, hooks and types',
    (file) => {
      const source = read(`packages/ui/src/${file}`);
      const offenders = exportsOf(source).filter(({ kind, name }) => {
        if (kind === 'type' || kind === 'interface') return false; // erased
        if (/^use[A-Z]/.test(name)) return false; // a hook
        if (/^[A-Z]/.test(name) && (kind === 'function' || kind === 'class')) return false;
        return true;
      });

      expect(
        offenders.map((o) => `${o.kind} ${o.name}`),
        `${file} is a 'use client' module: move these into a neutral module beside it`,
      ).toEqual([]);
    },
  );

  it('detects a planted violation, so the rule is known to work', () => {
    const planted = "'use client';\nexport const LOOKUP = { a: 1 };\n";
    const offenders = exportsOf(planted).filter(
      ({ kind, name }) =>
        !(kind === 'type' || kind === 'interface') &&
        !/^use[A-Z]/.test(name) &&
        !(/^[A-Z]/.test(name) && (kind === 'function' || kind === 'class')),
    );
    expect(offenders).toEqual([{ kind: 'const', name: 'LOOKUP' }]);
  });

  it('keeps the neutral tables OUT of the client modules that use them', () => {
    // The four neutral modules that exist precisely because of this rule.
    for (const neutral of [
      'menu-style.ts',
      'social-post-types.ts',
      'copilot-types.ts',
      'studio-presets.ts',
    ]) {
      const source = read(`packages/ui/src/${neutral}`);
      expect(
        source.trimStart().startsWith("'use client'"),
        `${neutral} became a client module`,
      ).toBe(false);
    }
  });
});

describe('the social preview offers only ratios a platform accepts', () => {
  it('never offers a landscape TikTok', () => {
    // Offering it would be a lie about what the platform takes.
    expect(PLATFORM_ASPECTS.tiktok).toEqual(['9:16']);
    expect(PLATFORM_ASPECTS.tiktok).not.toContain('16:9');
  });

  it('gives every platform at least one ratio', () => {
    for (const [platform, aspects] of Object.entries(PLATFORM_ASPECTS)) {
      expect(aspects.length, `${platform} has no aspect ratio`).toBeGreaterThan(0);
    }
  });

  it('covers the ratios the brief requires across the set', () => {
    const all = new Set(Object.values(PLATFORM_ASPECTS).flat());
    for (const required of ['1:1', '4:5', '16:9', '9:16']) {
      expect(all.has(required as never), `${required} is offered by no platform`).toBe(true);
    }
  });
});

describe('status tones are decided in one place', () => {
  it('maps the lifecycle statuses both consoles display', () => {
    expect(statusTone('ACTIVE')).toBe('success');
    expect(statusTone('SUSPENDED')).toBe('danger');
    expect(statusTone('TRIALING')).toBe('warning');
    expect(statusTone('ARCHIVED')).toBe('neutral');
  });

  it('falls back to neutral rather than throwing on an unknown status', () => {
    // A new status must not crash a directory page before its tone is chosen.
    expect(statusTone('SOMETHING_NEW')).toBe('neutral');
  });

  it('maps the post statuses the preview renders', () => {
    expect(statusTone('PUBLISHED')).toBe('success');
    expect(statusTone('SCHEDULED')).toBe('warning');
    expect(statusTone('FAILED')).toBe('danger');
    expect(statusTone('DRAFT')).toBe('neutral');
  });
});

describe('webfonts are optional and never a build dependency', () => {
  it('returns a stylesheet only when configuration opts in', () => {
    expect(webfontHref('google')).toContain('fonts.googleapis.com');
    expect(webfontHref(undefined)).toBeNull();
    expect(webfontHref('')).toBeNull();
    expect(webfontHref('anything-else')).toBeNull();
  });

  it('requests both approved families', () => {
    const href = webfontHref('google') ?? '';
    expect(href).toContain('Cairo');
    expect(href).toContain('Inter');
  });

  it('never uses next/font, which would fetch at build time', () => {
    // F-06 in a new costume: a build that only succeeds with network access.
    for (const layout of [
      'apps/dashboard/src/app/[locale]/layout.tsx',
      'apps/admin/src/app/[locale]/layout.tsx',
    ]) {
      expect(readCode(layout)).not.toContain('next/font');
    }
  });

  it('declares system fallbacks, so a blocked CDN still renders both scripts', () => {
    const css = read('packages/ui/src/tokens.css');
    expect(css).toContain('--bs-font-arabic');
    expect(css).toMatch(/--bs-font-arabic:[^;]*system-ui/);
    expect(css).toMatch(/--bs-font-latin:[^;]*system-ui/);
  });
});

describe('the design showcase cannot reach production', () => {
  const gate = read('apps/dashboard/src/app/[locale]/design-system/showcase-enabled.ts');
  const page = read('apps/dashboard/src/app/[locale]/design-system/page.tsx');

  it('refuses a real deployment environment regardless of the opt-in flag', () => {
    expect(gate).toContain("'production'");
    expect(gate).toContain("'staging'");
    expect(gate).toContain('PROTECTED_ENVIRONMENTS.has(appEnv)');
  });

  it('keys on APP_ENV, not NODE_ENV', () => {
    // `next start` always sets NODE_ENV=production, so a gate keyed on it is a
    // deletion rather than a gate: the route could never be served from a
    // production build, including in the end-to-end suite. The suite caught
    // exactly that.
    expect(gate).toContain("process.env['APP_ENV']");
    expect(gate).not.toContain("process.env['NODE_ENV']");
  });

  it('additionally requires an explicit opt-in', () => {
    expect(gate).toContain('BRANDSPACE_DESIGN_SHOWCASE');
  });

  it('answers notFound, so a probe cannot tell it apart from a missing route', () => {
    expect(page).toContain('notFound()');
  });

  it('is linked from no navigation in either application', () => {
    for (const shell of [
      'apps/dashboard/src/components/workspace-shell.tsx',
      'apps/admin/src/components/admin-shell.tsx',
    ]) {
      expect(readCode(shell)).not.toContain('design-system');
    }
  });

  it('touches no database and no session', () => {
    // The showcase renders fixtures. If it ever imports the customer context or
    // a Prisma client, it stops being a static gallery and starts being a
    // surface that needs authorization.
    for (const file of [
      'apps/dashboard/src/app/[locale]/design-system/page.tsx',
      'apps/dashboard/src/app/[locale]/design-system/showcase-client.tsx',
      'apps/dashboard/src/app/[locale]/design-system/fixtures.ts',
    ]) {
      const source = readCode(file);
      expect(source, `${file} imports the customer context`).not.toContain('customer-context');
      expect(source, `${file} imports a database client`).not.toContain('@brandspace/database');
      expect(source, `${file} imports auth`).not.toContain('@brandspace/auth');
    }
  });

  /*
   * §19, enforced.
   *
   * The prototype screens (features hub, calendar, posts library, composer,
   * Design Studio) show flows the backend cannot yet perform. They are safe to
   * have only while they are reachable ONLY through the gated showcase. The
   * moment one of them is imported by a production route, the gate stops being
   * the thing that decides whether a customer can see a button that does
   * nothing.
   *
   * So: every prototype component may appear in exactly one file in either
   * application, and that file is the showcase's own client component.
   */
  it('renders the prototype screens from the gated showcase and nowhere else', () => {
    const prototypes = [
      'ContentCalendar',
      'PostComposer',
      'DesignStudio',
      'PostGridCard',
      'PostListRow',
      'FeatureCard',
    ];
    const showcase = 'apps/dashboard/src/app/[locale]/design-system/showcase-client.tsx';

    const appFiles = [
      ...collectSourceFiles('apps/dashboard/src'),
      ...collectSourceFiles('apps/admin/src'),
    ];
    expect(appFiles.length, 'no application files were scanned').toBeGreaterThan(20);

    for (const component of prototypes) {
      const users = appFiles.filter((file) =>
        new RegExp(`\\b${component}\\b`).test(readCode(file)),
      );
      expect(users, `${component} is used outside the gated showcase`).toEqual([showcase]);
    }
  });

  it('states on every prototype screen that it performs nothing', () => {
    const client = read('apps/dashboard/src/app/[locale]/design-system/showcase-client.tsx');
    // One shared notice component, used by each prototype section.
    for (const testId of [
      'features-prototype-notice',
      'calendar-prototype-notice',
      'library-prototype-notice',
      'composer-prototype-notice',
      'studio-prototype-banner',
    ]) {
      expect(client, `the ${testId} notice is missing`).toContain(testId);
    }
  });

  it('uses reserved example addresses in its fixtures, never a real-looking one', () => {
    const fixtures = read('apps/dashboard/src/app/[locale]/design-system/fixtures.ts');
    const addresses = fixtures.match(/[\w.+-]+@[\w.-]+/g) ?? [];
    for (const address of addresses) {
      expect(address, `${address} is not a reserved example domain`).toMatch(
        /@(example\.(test|com|org)|sample\.brand)$/,
      );
    }
  });
});
