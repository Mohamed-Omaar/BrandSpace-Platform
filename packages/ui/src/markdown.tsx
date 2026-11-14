import { Fragment, type ReactNode } from 'react';

/**
 * COPILOT REPLIES AS SAFE MARKDOWN (owner, 2026-11-14).
 *
 * The model writes Markdown — `**bold**`, `- ` bullets, `1)` lists — and the
 * bubble showed it as literal symbols, run together in one block. This turns
 * the small part of Markdown a chat answer needs into React ELEMENTS:
 *
 *   paragraphs and line breaks · `#`–`###` headings · `-`/`*`/`•` bullets ·
 *   `1.`/`1)` numbered lists · `**bold**`/`__bold__` · `*italic*`/`_italic_` ·
 *   `` `code` `` · `[text](https://…)` links and bare https links.
 *
 * WHAT MAKES IT SAFE — it never produces HTML. Every piece of the model's text
 * becomes a React text node, which React escapes, so `<script>` or any raw HTML
 * in a reply is SHOWN as those characters and never parsed. There is no
 * `dangerouslySetInnerHTML` anywhere on this path.
 *   - A link is drawn only for `http:`/`https:` (parsed with `URL`), opening in
 *     a new tab with `rel="noopener noreferrer nofollow"`; any other scheme
 *     (`javascript:`, `data:`…) leaves the words as plain text.
 *   - An image (`![alt](url)`) is never loaded: only its alt text is shown.
 *
 * STREAMING — while a reply is still arriving (`streaming`), a marker that has
 * opened but not yet closed (`**bold so f`) is drawn as already styled, so
 * the symbols never flash on screen and then vanish when the closing `**`
 * arrives. Blocks are keyed by position, so earlier ones keep their nodes.
 *
 * DIRECTION — every block carries `dir="auto"`, so an Arabic list puts its
 * bullets and numbers on the right and an English one on the left, each by
 * its own first letter; the CSS uses logical properties only.
 */

type Block =
  | { readonly kind: 'p'; readonly lines: readonly string[] }
  | { readonly kind: 'h'; readonly level: 1 | 2 | 3; readonly text: string }
  | { readonly kind: 'ul' | 'ol'; readonly items: readonly string[]; readonly start: number };

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s{0,3}[-*•+]\s+(.*)$/;
const NUMBERED = /^\s{0,3}(\d{1,3})[.)]\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

/** Splits a reply into paragraphs, headings and lists. */
export function markdownBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { kind: 'ul' | 'ol'; items: string[]; start: number } | null = null;
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'p', lines: paragraph });
    if (list) blocks.push(list);
    paragraph = [];
    list = null;
  };
  for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (line.trim() === '' || RULE.test(line)) {
      flush();
      continue;
    }
    const heading = HEADING.exec(line.trim());
    if (heading) {
      flush();
      const level = Math.min(heading[1]!.length, 3) as 1 | 2 | 3;
      blocks.push({ kind: 'h', level, text: heading[2]! });
      continue;
    }
    const bullet = RULE.test(line) ? null : BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      const kind = bullet ? 'ul' : 'ol';
      if (paragraph.length > 0 || (list && list.kind !== kind)) flush();
      if (!list) list = { kind, items: [], start: numbered ? Number(numbered[1]) : 1 };
      list.items.push(bullet ? bullet[1]! : numbered![2]!);
      continue;
    }
    if (list && /^\s{2,}\S/.test(raw)) {
      // An indented line continues the list item above it.
      const items = list.items;
      items[items.length - 1] = `${items[items.length - 1]} ${line.trim()}`;
      continue;
    }
    if (list) flush();
    paragraph.push(line);
  }
  flush();
  return blocks;
}

/** Only an absolute http(s) address is a link. */
export function safeHref(address: string): string | null {
  try {
    const url = new URL(address.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** A link target: no spaces, one level of balanced brackets (`f(1)`). */
const TARGET = '((?:[^()\\s]|\\([^()\\s]*\\))+)';
const IMAGE = new RegExp(`^!\\[([^\\]]*)\\]\\(${TARGET}?\\)`);
const LINK = new RegExp(`^\\[([^\\]]+)\\]\\(${TARGET}\\)`);

const BARE_URL = /https?:\/\/[^\s<>()[\]]+[^\s<>()[\].,;:!?'"،؛؟]/y;

type Hit = { readonly length: number } & (
  { readonly plain: string } | { readonly node: ReactNode }
);

/**
 * Inline text → React nodes. `open` = streaming: an unclosed marker styles
 * the rest instead of showing its symbols.
 */
function inline(text: string, open: boolean, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let plain = '';
  let n = 0;

  const at = (rest: string): Hit | null => {
    // ![alt](url) — an image is never loaded; its alt text stands in.
    const image = IMAGE.exec(rest);
    if (image) return { length: image[0].length, plain: image[1]! };
    // [text](url) — a link only for http(s); otherwise just the words.
    const link = LINK.exec(rest);
    if (link) {
      const href = safeHref(link[2]!);
      return href
        ? {
            length: link[0].length,
            node: (
              <a href={href} target="_blank" rel="noopener noreferrer nofollow">
                {inline(link[1]!, false, `${key}.${n}`)}
              </a>
            ),
          }
        : { length: link[0].length, plain: link[1]! };
    }
    // A bare http(s) link, at a word start.
    if (/^https?:\/\//.test(rest) && !/[\p{L}\p{N}]$/u.test(plain)) {
      BARE_URL.lastIndex = 0;
      const bare = BARE_URL.exec(rest);
      const href = bare ? safeHref(bare[0]) : null;
      if (bare && href) {
        return {
          length: bare[0].length,
          node: (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow">
              {bare[0]}
            </a>
          ),
        };
      }
    }
    // `code`
    if (rest[0] === '`' && rest.length > 1) {
      const end = rest.indexOf('`', 1);
      if (end > 1) return { length: end + 1, node: <code>{rest.slice(1, end)}</code> };
      if (open) return { length: rest.length, node: <code>{rest.slice(1)}</code> };
      return null;
    }
    // **bold** / __bold__, then *italic* / _italic_.
    const marker = (['**', '__', '*', '_'] as const).find((m) => rest.startsWith(m));
    if (!marker) return null;
    const after = rest[marker.length];
    // A marker must touch a word: "2 * 3" and "snake_case" stay as they are.
    if (after === undefined || /\s/.test(after)) return null;
    // `_`/`__` only at a word's edges (CommonMark): `snake_case` and
    // `window.__name` stay as they are.
    const underscore = marker[0] === '_';
    if (underscore && plain !== '' && !/[\s([{"'«]$/u.test(plain)) return null;
    let end = rest.indexOf(marker, marker.length);
    const closes = (at: number) =>
      at > marker.length &&
      !/\s/.test(rest[at - 1]!) &&
      // A single marker does not close on the first half of a double one.
      !(marker.length === 1 && rest[at + 1] === marker) &&
      !(underscore && /[\p{L}\p{N}_]/u.test(rest[at + marker.length] ?? ''));
    while (end > 0 && !closes(end)) end = rest.indexOf(marker, end + 1);
    const closed = end > 0;
    if (!closed && !open) return null;
    const inner = closed ? rest.slice(marker.length, end) : rest.slice(marker.length);
    const content = inline(inner, open && !closed, `${key}.${n}`);
    return {
      length: closed ? end + marker.length : rest.length,
      node: marker.length === 2 ? <strong>{content}</strong> : <em>{content}</em>,
    };
  };

  let i = 0;
  while (i < text.length) {
    const hit = at(text.slice(i));
    if (!hit) {
      plain += text[i]!;
      i += 1;
      continue;
    }
    if ('plain' in hit) {
      plain += hit.plain;
    } else {
      if (plain !== '') out.push(plain);
      plain = '';
      out.push(<Fragment key={`${key}.${n++}`}>{hit.node}</Fragment>);
    }
    i += hit.length;
  }
  if (plain !== '') out.push(plain);
  return out;
}

/** A Markdown reply as elements. Nothing in `text` is ever parsed as HTML. */
export function Markdown({
  text,
  streaming = false,
}: {
  readonly text: string;
  readonly streaming?: boolean;
}) {
  const blocks = markdownBlocks(text);
  return (
    <div className="bs-md" data-testid="copilot-markdown">
      {blocks.map((block, index) => {
        const open = streaming && index === blocks.length - 1;
        const key = `b${index}`;
        if (block.kind === 'h') {
          const Tag = block.level === 1 ? 'h3' : block.level === 2 ? 'h4' : 'h5';
          return (
            <Tag key={key} dir="auto" className="bs-md-h">
              {inline(block.text, open, key)}
            </Tag>
          );
        }
        if (block.kind === 'p') {
          return (
            <p key={key} dir="auto">
              {block.lines.map((line, at) => (
                <Fragment key={at}>
                  {at > 0 ? <br /> : null}
                  {inline(line, open && at === block.lines.length - 1, `${key}.${at}`)}
                </Fragment>
              ))}
            </p>
          );
        }
        const items = block.items.map((item, at) => (
          <li key={at}>{inline(item, open && at === block.items.length - 1, `${key}.${at}`)}</li>
        ));
        return block.kind === 'ul' ? (
          <ul key={key} dir="auto">
            {items}
          </ul>
        ) : (
          <ol key={key} dir="auto" start={block.start === 1 ? undefined : block.start}>
            {items}
          </ol>
        );
      })}
    </div>
  );
}
