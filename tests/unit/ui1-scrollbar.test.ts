import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { colorTokens } from '@brandspace/ui';

/**
 * UI-1 (prototype v94) — ONE GLOBAL SCROLLBAR STYLE, AND THE HIDDEN ONES STAY
 * HIDDEN.
 *
 * The style lives once, in the design system's global stylesheet, never per
 * screen. Chrome/Edge draw it with the `::-webkit-scrollbar` pseudo-elements;
 * Firefox with `scrollbar-width` / `scrollbar-color`, scoped to engines that
 * lack the pseudo-elements (setting the standard properties globally would
 * make Chromium 121+ ignore the pseudo-elements and lose the hover state).
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const tokens = read('packages/ui/src/tokens.css');

/** Build output and dependencies are not source. */
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.next',
  '.turbo',
  'dist',
  'build',
  'coverage',
  'test-results',
  'playwright-report',
]);
const SOURCE_EXTENSIONS = /\.(?:css|scss|ts|tsx|js|jsx|mjs|cjs)$/;

/** Every source file under `apps/**` and `packages/**` (never `docs/visual-reference/**`). */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) found.push(...sourceFiles(relative));
    } else if (SOURCE_EXTENSIONS.test(entry.name)) {
      found.push(relative);
    }
  }
  return found;
}

/**
 * The ONLY scrollbar declarations allowed outside `tokens.css`: hiding the bar
 * on an element that is deliberately bar-less, alongside its
 * `::-webkit-scrollbar { display: none }` twin.
 */
const KNOWN_HIDDEN = [
  { file: 'packages/ui/src/brand-brain.css', selector: '.bb-chat-suggestions' },
  // D-468: the collapsed rail, `.sb.min nav{…scrollbar-width:none}` in the prototype.
  { file: 'packages/ui/src/prototype.css', selector: '.bsp-sb.bsp-min .bsp-sbnav' },
];

interface Declaration {
  readonly file: string;
  readonly selector: string;
  readonly declaration: string;
}

/** Every `scrollbar-width` / `scrollbar-color` declaration, CSS or inline style, with its rule. */
function scrollbarDeclarations(file: string, source: string = read(file)): Declaration[] {
  const found: Declaration[] = [];
  if (/\.s?css$/.test(file)) {
    const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const declaration of (match[2] ?? '').matchAll(/scrollbar-(?:width|color)\s*:[^;]*/g)) {
        found.push({
          file,
          selector: (match[1] ?? '').trim(),
          declaration: declaration[0].trim(),
        });
      }
    }
    return found;
  }
  for (const declaration of source.matchAll(
    /(?:scrollbar-(?:width|color)|scrollbar(?:Width|Color))['"]?\s*:\s*[^,;}\n]+/g,
  )) {
    found.push({ file, selector: '(inline style)', declaration: declaration[0].trim() });
  }
  return found;
}

/** The body of the FIRST rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `${selector} is defined`).not.toBeNull();
  return match?.[1] ?? '';
}

/** `scrollbar-width: none` on a known hidden class — nothing else — is allowed. */
function allowed(found: Declaration): boolean {
  return (
    /^scrollbar-width\s*:\s*none$/.test(found.declaration) &&
    KNOWN_HIDDEN.some((known) => known.file === found.file && known.selector === found.selector)
  );
}

describe('UI-1 · the global scrollbar', () => {
  it('is thin, has no arrow buttons and a transparent track (Chrome/Edge)', () => {
    expect(rule(tokens, '*::-webkit-scrollbar')).toMatch(/width:\s*8px/);
    expect(rule(tokens, '*::-webkit-scrollbar')).toMatch(/height:\s*8px/);
    expect(rule(tokens, '*::-webkit-scrollbar-button')).toMatch(/display:\s*none/);
    expect(tokens).toMatch(
      /\*::-webkit-scrollbar-track,\s*\*::-webkit-scrollbar-corner\s*\{\s*background:\s*transparent;/,
    );
  });

  it('has a subtle thumb that darkens on hover, from tokens', () => {
    expect(rule(tokens, '*::-webkit-scrollbar-thumb')).toContain('var(--bs-scrollbar-thumb)');
    expect(rule(tokens, '*::-webkit-scrollbar-thumb:hover')).toContain(
      'var(--bs-scrollbar-thumb-hover)',
    );
    expect(tokens).toMatch(/--bs-scrollbar-thumb:\s*#9a9aa2;/);
    expect(tokens).toMatch(/--bs-scrollbar-thumb-hover:\s*#6a6a72;/);
    expect(colorTokens.scrollbarThumb.toLowerCase()).toBe('#9a9aa2');
    expect(colorTokens.scrollbarThumbHover.toLowerCase()).toBe('#6a6a72');
  });

  it('uses scrollbar-width / scrollbar-color only where the pseudo-elements do not exist (Firefox)', () => {
    const block = tokens.match(/@supports not selector\(::-webkit-scrollbar\)\s*\{([\s\S]*?)\n\}/);
    expect(block, 'the Firefox block exists').not.toBeNull();
    expect(block?.[1]).toMatch(/scrollbar-width:\s*thin/);
    expect(block?.[1]).toMatch(/scrollbar-color:\s*var\(--bs-scrollbar-thumb\) transparent/);
    expect(block?.[1]).toMatch(/scrollbar-color:\s*var\(--bs-scrollbar-thumb-hover\) transparent/);
    // Never on the universal selector outside that block: Chromium would then
    // ignore every pseudo-element rule above.
    const outside = tokens.replace(block?.[0] ?? '', '');
    expect(outside).not.toMatch(/(?:^|\n)\*\s*\{[^}]*scrollbar-(?:width|color)/);
  });

  it('scrollbar-width / scrollbar-color appear nowhere outside tokens.css, except hiding a known bar-less element', () => {
    const files = [...sourceFiles('apps'), ...sourceFiles('packages')];
    // The scan really covers the screens' stylesheets, and never the vendored demo.
    expect(files).toContain('packages/ui/src/brand-brain.css');
    expect(files).toContain('packages/ui/src/content-studio.css');
    expect(files.some((file) => file.startsWith('docs/'))).toBe(false);

    expect(
      files
        .filter((file) => file !== 'packages/ui/src/tokens.css')
        .flatMap((file) => scrollbarDeclarations(file))
        .filter((found) => !allowed(found)),
    ).toEqual([]);
  });

  it('the scan reports a per-screen scrollbar, and allows only `none` on a known hidden class', () => {
    const screen = 'packages/ui/src/brand-brain.css';
    const css = [
      '/* scrollbar-width: thin; in a comment is not a declaration */',
      '.bb-chat-messages {\n  overflow-y: auto;\n  scrollbar-width: thin;\n  scrollbar-color: #3a3a44 transparent;\n}',
      '.bb-chat-suggestions {\n  scrollbar-width: none;\n}',
      '.bb-other {\n  scrollbar-width: none;\n}',
      '@media (max-width: 600px) {\n  .bb-chat-suggestions {\n    scrollbar-width: thin;\n  }\n}',
    ].join('\n');
    expect(
      scrollbarDeclarations(screen, css)
        .filter((found) => !allowed(found))
        .map((found) => `${found.selector} → ${found.declaration}`),
    ).toEqual([
      '.bb-chat-messages → scrollbar-width: thin',
      '.bb-chat-messages → scrollbar-color: #3a3a44 transparent',
      '.bb-other → scrollbar-width: none',
      '.bb-chat-suggestions → scrollbar-width: thin',
    ]);
    // An inline style in a component is caught too.
    expect(
      scrollbarDeclarations(
        'apps/dashboard/src/x.tsx',
        "<div style={{ scrollbarWidth: 'thin' }} />",
      ),
    ).toHaveLength(1);
  });

  it('the Brand Brain chat messages use the global scrollbar: no rule of their own', () => {
    const brain = read('packages/ui/src/brand-brain.css');
    const messages = rule(brain, '.bb-chat-messages');
    expect(messages).toMatch(/overflow-y:\s*auto/);
    expect(messages).not.toMatch(/scrollbar-/);
    // And no second, per-element scrollbar rule in its place.
    expect(brain).not.toMatch(/\.bb-chat-messages[^{]*::-webkit-scrollbar/);
    expect(brain).not.toMatch(/\.bb-chat-messages[^{]*\{[^}]*scrollbar-/);
  });

  it('is defined once, in the design system, not per screen', () => {
    for (const file of ['packages/ui/src/brand-brain.css', 'packages/ui/src/content-studio.css']) {
      expect(read(file), file).not.toMatch(/\*::-webkit-scrollbar/);
    }
  });
});

describe('UI-1 · deliberately hidden scrollbars stay hidden', () => {
  it('the sidebar navigation hides its bar in every engine', () => {
    expect(rule(tokens, '.bs-nav-scroll')).toMatch(/scrollbar-width:\s*none/);
    expect(rule(tokens, '.bs-nav-scroll::-webkit-scrollbar')).toMatch(/display:\s*none/);
    const shell = read('packages/ui/src/app-shell.tsx');
    expect(shell).toContain('className="bs-nav-scroll"');
  });

  it('the Brand Brain chat suggestions keep both hiding rules', () => {
    const brain = read('packages/ui/src/brand-brain.css');
    expect(rule(brain, '.bb-chat-suggestions')).toMatch(/scrollbar-width:\s*none/);
    expect(rule(brain, '.bb-chat-suggestions::-webkit-scrollbar')).toMatch(/display:\s*none/);
  });
});
