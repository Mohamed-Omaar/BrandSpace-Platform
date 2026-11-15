import { describe, expect, it } from 'vitest';
import { Markdown, markdownBlocks, safeHref } from '../../packages/ui/src/markdown';

/**
 * COPILOT REPLIES AS SAFE MARKDOWN (owner, 2026-11-14). The renderer returns
 * React elements; these tests walk that tree, so what they see is exactly
 * what React will put on the page.
 */

type Node = { tag: string; props: Record<string, unknown>; children: Tree[] };
type Tree = Node | string;

/** The element tree, with fragments and function components unfolded. */
// `react` resolves from packages/ui, not from here: elements are read by shape.
type Element = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
function tree(node: unknown): Tree[] {
  if (node === null || node === undefined || typeof node === 'boolean') return [];
  if (typeof node === 'string' || typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(tree);
  if (typeof node !== 'object' || !('type' in node) || !('props' in node)) {
    throw new Error('unexpected node');
  }
  const element = node as Element;
  if (typeof element.type === 'function') {
    return tree((element.type as (props: unknown) => unknown)(element.props));
  }
  if (typeof element.type !== 'string') return tree(element.props.children);
  const { children, ...props } = element.props;
  return [{ tag: element.type, props, children: tree(children) }];
}

const render = (text: string, streaming = false) => tree(Markdown({ text, streaming }))[0] as Node;

const all = (root: Tree, tag?: string): Node[] =>
  typeof root === 'string'
    ? []
    : [
        ...(tag === undefined || root.tag === tag ? [root] : []),
        ...root.children.flatMap((c) => all(c, tag)),
      ];

const textOf = (root: Tree): string =>
  typeof root === 'string' ? root : root.children.map(textOf).join('');

describe('a reply with each element renders as elements', () => {
  const reply = [
    '## Your week',
    '',
    'Here is **the plan** for *this week*, see [the guide](https://example.com/guide).',
    'A second line in the same paragraph.',
    '',
    '- Post a **reel** on Monday',
    '- Reply to comments',
    '',
    '1) Draft the caption',
    '2) Pick the image',
    '',
    'Done. `#tags` too: https://brandspace.example/help.',
  ].join('\n');
  const root = render(reply);

  it('heading, paragraphs with a line break, bullets, numbers', () => {
    expect(root.children.map((child) => (child as Node).tag)).toEqual(['h4', 'p', 'ul', 'ol', 'p']);
    expect(textOf(all(root, 'h4')[0]!)).toBe('Your week');
    expect(all(root, 'br')).toHaveLength(1);
    expect(all(root, 'ul')[0]!.children.map(textOf)).toEqual([
      'Post a reel on Monday',
      'Reply to comments',
    ]);
    expect(all(root, 'ol')[0]!.children.map(textOf)).toEqual([
      'Draft the caption',
      'Pick the image',
    ]);
    // No Markdown symbol is left on the page.
    expect(textOf(root)).not.toMatch(/\*\*|^- |1\)|##/m);
  });

  it('bold, italic, code', () => {
    expect(all(root, 'strong').map(textOf)).toEqual(['the plan', 'reel']);
    expect(all(root, 'em').map(textOf)).toEqual(['this week']);
    expect(all(root, 'code').map(textOf)).toEqual(['#tags']);
  });

  it('links open safely in a new tab; a bare link is a link too', () => {
    const links = all(root, 'a');
    expect(links.map((link) => link.props['href'])).toEqual([
      'https://example.com/guide',
      'https://brandspace.example/help',
    ]);
    for (const link of links) {
      expect(link.props['target']).toBe('_blank');
      expect(link.props['rel']).toBe('noopener noreferrer nofollow');
    }
    // The full stop after a bare link is not part of it.
    expect(textOf(root.children[4]!)).toMatch(/help\.$/);
  });

  it('a numbered list keeps its first number', () => {
    expect(all(render('3. third\n4. fourth'), 'ol')[0]!.props['start']).toBe(3);
  });
});

describe('nothing in a reply is ever HTML', () => {
  it('<script> and raw HTML are shown as text, never as elements', () => {
    const reply =
      'Hi <script>alert(1)</script> and <b onclick="x()">bold</b> <img src=x onerror=y>';
    const root = render(reply);
    expect(textOf(root)).toBe(reply);
    expect(all(root).map((node) => node.tag)).toEqual(['div', 'p']);
    // Nowhere does the tree hand React raw HTML.
    expect(all(root).some((node) => 'dangerouslySetInnerHTML' in node.props)).toBe(false);
  });

  it('only http(s) links: javascript:, data: and relative ones stay as words', () => {
    for (const href of [
      'javascript:alert(1)',
      'data:text/html,x',
      '/en/settings',
      'JaVaScRiPt:x',
    ]) {
      const root = render(`[click](${href})`);
      expect(all(root, 'a')).toHaveLength(0);
      expect(textOf(root)).toBe('click');
    }
    expect(safeHref('https://a.example/x')).toBe('https://a.example/x');
    expect(safeHref('ftp://a.example/')).toBeNull();
  });

  it('an image from the model is never loaded: its alt text stands in', () => {
    const root = render('Look ![a cat](https://evil.example/track.png) here');
    expect(all(root, 'img')).toHaveLength(0);
    expect(textOf(root)).toBe('Look a cat here');
  });

  it('`window.__name = 1 … window.__name` is not bold (underscores only at word edges)', () => {
    const reply = 'Raw: <script>window.__pwned = 1</script> <img onerror="window.__pwned = 2">';
    const root = render(reply);
    expect(all(root, 'strong')).toHaveLength(0);
    expect(textOf(root)).toBe(reply);
    expect(all(render('a __real__ word'), 'strong').map(textOf)).toEqual(['real']);
    expect(all(render('(_aside_)'), 'em').map(textOf)).toEqual(['aside']);
  });

  it('ordinary symbols stay as they are: 2 * 3, snake_case, a lone *', () => {
    const root = render('2 * 3 = 6, snake_case_name, and a * star');
    expect(all(root, 'em')).toHaveLength(0);
    expect(textOf(root)).toBe('2 * 3 = 6, snake_case_name, and a * star');
  });
});

describe('Arabic reads right to left, lists included', () => {
  it('every block decides its own direction (dir="auto"), so bullets sit on the right in Arabic', () => {
    const root = render(
      '**خطة الأسبوع**\n\n- انشر مقطعًا يوم الاثنين\n- رد على التعليقات\n\n١) اكتب النص',
    );
    for (const block of root.children as Node[]) expect(block.props['dir']).toBe('auto');
    expect(all(root, 'li').map(textOf)).toEqual(['انشر مقطعًا يوم الاثنين', 'رد على التعليقات']);
    // An Arabic-Indic "١)" is a paragraph, not a list: only Western digits number a list.
    expect(textOf(all(root, 'p').at(-1)!)).toBe('١) اكتب النص');
  });
});

describe('streaming renders progressively, without symbols flashing', () => {
  it('an unclosed ** while streaming is already bold; once complete, the same', () => {
    const partial = render('The plan: **post da', true);
    expect(all(partial, 'strong').map(textOf)).toEqual(['post da']);
    expect(textOf(partial)).not.toContain('**');
    const done = render('The plan: **post daily**', false);
    expect(all(done, 'strong').map(textOf)).toEqual(['post daily']);
  });

  it('an unclosed ** in a FINISHED reply is shown as typed', () => {
    expect(textOf(render('a **b', false))).toBe('a **b');
  });

  it('earlier blocks keep their shape as more arrives', () => {
    const one = markdownBlocks('- one\n- tw');
    const two = markdownBlocks('- one\n- two\n\nAnd then');
    expect(one[0]).toMatchObject({ kind: 'ul', items: ['one', 'tw'] });
    expect(two[0]).toMatchObject({ kind: 'ul', items: ['one', 'two'] });
  });
});
