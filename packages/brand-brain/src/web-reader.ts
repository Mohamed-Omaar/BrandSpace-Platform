import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { pinnedLookup } from '@brandspace/ai-gateway/egress';
import {
  assertNotProduction,
  isIpAddressLiteral,
  unsafeProviderUrlReason,
} from '@brandspace/shared';

/**
 * PR C (owner, 2026-11-14) — THE ONE WAY BRANDSPACE READS A WEB PAGE.
 *
 * Used for the brand's own website (Brand Brain → Sources, and the Copilot's
 * "read our website") and for a public link pasted in the Copilot. A page is
 * a stranger's content on a stranger's server, so every rule below is a
 * boundary, not a nicety:
 *
 *   - https on the standard port only; no IP-literal host, no credentials, no
 *     private name (`unsafeProviderUrlReason`, the provider rule);
 *   - every address the host resolves to must be PUBLIC — never loopback,
 *     private, link-local (the cloud metadata service), CGNAT or multicast —
 *     checked inside the socket's own lookup (`pinnedLookup`), so there is no
 *     DNS-rebinding window between the check and the connection;
 *   - a redirect is followed at most 3 times, and its target passes every
 *     rule above again: a redirect to a private or metadata address is
 *     refused like the address itself;
 *   - robots.txt is respected (RFC 9309): BrandSpaceBot's group, else `*`;
 *     a missing robots.txt (4xx) allows; an unreachable one (5xx, timeout)
 *     refuses;
 *   - at most 10 seconds for the whole read, at most 2 MB (reading stops
 *     there), HTML or plain text only;
 *   - the page becomes TEXT here (scripts, styles and markup dropped). What a
 *     page says is DATA: callers fence it, and nothing acts on it.
 */

export const WEB_READER_USER_AGENT = 'BrandSpaceBot/1.0 (+brand reading for BrandSpace)';
const ROBOTS_AGENT = 'brandspacebot';
export const WEB_READ_TIMEOUT_MS = 10_000;
export const WEB_READ_MAX_BYTES = 2 * 1024 * 1024;
export const WEB_READ_MAX_REDIRECTS = 3;
const ROBOTS_MAX_BYTES = 256 * 1024;

export type WebReadRefusal =
  | 'unsafe_address'
  | 'robots_disallowed'
  | 'too_many_redirects'
  | 'not_a_page'
  | 'http_error'
  | 'timed_out'
  | 'unreachable';

/** Why a page was not read, in words a person can be shown. */
export class WebReadRefusedError extends Error {
  readonly reason: WebReadRefusal;
  constructor(reason: WebReadRefusal, message: string) {
    super(message);
    this.name = 'WebReadRefusedError';
    this.reason = reason;
  }
}

export interface WebReaderOptions {
  /** The socket's lookup. Default: public addresses only (`pinnedLookup`). */
  readonly lookup?: LookupFunction;
  /** Injected by tests (plain http against a local server). */
  readonly request?: typeof httpsRequest;
  readonly port?: number;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

export interface WebPage {
  /** The address the text came from, after redirects. */
  readonly url: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly text: string;
  /** Absolute https links found on the page, in order, without duplicates. */
  readonly links: readonly string[];
  /** True when reading stopped at the size limit. */
  readonly truncated: boolean;
}

interface Fetched {
  readonly status: number;
  readonly contentType: string;
  readonly location: string | null;
  readonly body: string;
  readonly truncated: boolean;
}

// ---------------------------------------------------------------------------
// HTML → text, without a parser library (D-588).
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code =
        name[1] === 'x' || name[1] === 'X'
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

const DROPPED_BLOCKS =
  /<(script|style|noscript|template|svg|iframe|object|canvas)\b[\s\S]*?<\/\1\s*>/gi;
const BLOCK_TAGS =
  /<\/?(p|div|section|article|header|footer|main|nav|aside|li|ul|ol|h[1-6]|br|tr|table|blockquote|figure|figcaption|address|dd|dt|dl)\b[^>]*>/gi;

/** The readable text of an HTML page, its title and description, and its links. */
export function htmlToText(
  html: string,
  base: string,
): { title: string | null; description: string | null; text: string; links: string[] } {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, ' ');
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(withoutComments)?.[1];
  const description =
    /<meta\b[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["'][^>]*>/i.exec(
      withoutComments,
    )?.[1] ??
    /<meta\b[^>]*content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']description["'][^>]*>/i.exec(
      withoutComments,
    )?.[1];
  const links: string[] = [];
  const seen = new Set<string>();
  for (const match of withoutComments.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#][^"']*)["']/gi)) {
    try {
      const url = new URL(decodeEntities(match[1]!.trim()), base);
      if (url.protocol !== 'https:') continue;
      url.hash = '';
      const href = url.toString();
      if (!seen.has(href)) {
        seen.add(href);
        links.push(href);
      }
    } catch {
      // Not a URL: skipped.
    }
  }
  const body = withoutComments
    .replace(/<head\b[\s\S]*?<\/head\s*>/i, ' ')
    .replace(DROPPED_BLOCKS, ' ')
    .replace(BLOCK_TAGS, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(body)
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v\u00a0]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
  const clean = (value: string | undefined) => {
    const tidy = value ? decodeEntities(value).replace(/\s+/g, ' ').trim() : '';
    return tidy === '' ? null : tidy;
  };
  return { title: clean(title), description: clean(description), text, links };
}

// ---------------------------------------------------------------------------
// robots.txt (RFC 9309), the parts a reader needs.
// ---------------------------------------------------------------------------

interface RobotsRule {
  readonly allow: boolean;
  readonly pattern: RegExp;
  readonly length: number;
}

function ruleFor(allow: boolean, path: string): RobotsRule {
  const anchored = path.endsWith('$');
  const body = (anchored ? path.slice(0, -1) : path)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return { allow, pattern: new RegExp(`^${body}${anchored ? '$' : ''}`), length: path.length };
}

/** The rules for BrandSpaceBot (its own group, else `*`). */
export function parseRobots(text: string): readonly RobotsRule[] {
  const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
  let current: { agents: string[]; rules: RobotsRule[] } | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === 'allow' && value !== '') current.rules.push(ruleFor(true, value));
    if (field === 'disallow' && value !== '') current.rules.push(ruleFor(false, value));
  }
  const ours = groups.filter((group) => group.agents.some((agent) => agent === ROBOTS_AGENT));
  const chosen = ours.length > 0 ? ours : groups.filter((group) => group.agents.includes('*'));
  return chosen.flatMap((group) => group.rules);
}

/** Whether a path may be read: the longest matching rule wins; allow wins a tie. */
export function robotsAllows(rules: readonly RobotsRule[], path: string): boolean {
  let best: RobotsRule | null = null;
  for (const rule of rules) {
    if (!rule.pattern.test(path)) continue;
    if (
      !best ||
      rule.length > best.length ||
      (rule.length === best.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

/**
 * Why this address may not be read, in a reader's words — or null. The rule
 * is the provider rule (`unsafeProviderUrlReason`); only the wording differs.
 */
export function unsafeAddressReason(address: string): string | null {
  const refusal = unsafeProviderUrlReason(address);
  if (!refusal) return null;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return 'That is not a web address.';
  }
  if (url.protocol !== 'https:') return 'Only https:// links can be read.';
  if (url.username || url.password) return 'A link with a user name or password cannot be read.';
  if (url.port !== '' && url.port !== '443')
    return 'Only links on the standard https port can be read.';
  if (isIpAddressLiteral(url.hostname.replace(/^\[|\]$/g, ''))) {
    return 'A link with an IP address instead of a site name cannot be read.';
  }
  return 'That address only exists on a private network, so it cannot be read.';
}

// ---------------------------------------------------------------------------
// The reader.
// ---------------------------------------------------------------------------

export class WebReader {
  readonly #lookup: LookupFunction;
  readonly #request: typeof httpsRequest;
  readonly #port: number | undefined;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #robots = new Map<string, readonly RobotsRule[] | 'refuse'>();

  constructor(options: WebReaderOptions = {}) {
    this.#lookup = options.lookup ?? pinnedLookup();
    this.#request = options.request ?? httpsRequest;
    this.#port = options.port;
    this.#timeoutMs = options.timeoutMs ?? WEB_READ_TIMEOUT_MS;
    this.#maxBytes = options.maxBytes ?? WEB_READ_MAX_BYTES;
  }

  /** Read one page: its text, title, description and links. */
  async read(address: string, deadlineAt?: number): Promise<WebPage> {
    const deadline = deadlineAt ?? Date.now() + this.#timeoutMs;
    let url = address.trim();
    for (let hop = 0; ; hop += 1) {
      const refusal = unsafeAddressReason(url);
      if (refusal) throw new WebReadRefusedError('unsafe_address', refusal);
      if (!(await this.#robotsAllow(new URL(url), deadline))) {
        throw new WebReadRefusedError(
          'robots_disallowed',
          "The site's robots.txt asks robots not to read this page.",
        );
      }
      const fetched = await this.#fetch(url, deadline, this.#maxBytes);
      if (fetched.status >= 300 && fetched.status < 400 && fetched.location) {
        if (hop >= WEB_READ_MAX_REDIRECTS) {
          throw new WebReadRefusedError('too_many_redirects', 'The page redirects too many times.');
        }
        url = new URL(fetched.location, url).toString();
        continue;
      }
      if (fetched.status < 200 || fetched.status >= 300) {
        throw new WebReadRefusedError(
          'http_error',
          `The site answered ${fetched.status}, so the page could not be read.`,
        );
      }
      const type = fetched.contentType.toLowerCase();
      if (type.includes('text/plain')) {
        return {
          url,
          title: null,
          description: null,
          text: fetched.body.trim(),
          links: [],
          truncated: fetched.truncated,
        };
      }
      if (!type.includes('text/html') && !type.includes('application/xhtml+xml')) {
        throw new WebReadRefusedError('not_a_page', 'The link is not a web page.');
      }
      return { url, ...htmlToText(fetched.body, url), truncated: fetched.truncated };
    }
  }

  async #robotsAllow(url: URL, deadline: number): Promise<boolean> {
    const origin = url.origin;
    let rules = this.#robots.get(origin);
    if (!rules) {
      try {
        const fetched = await this.#fetch(`${origin}/robots.txt`, deadline, ROBOTS_MAX_BYTES);
        rules =
          fetched.status >= 200 && fetched.status < 300
            ? parseRobots(fetched.body)
            : fetched.status >= 300 && fetched.status < 500
              ? [] // missing (or moved): read as no rules
              : 'refuse'; // the server failed: assume it refuses
      } catch (error: unknown) {
        if (error instanceof WebReadRefusedError && error.reason === 'unsafe_address') throw error;
        rules = 'refuse';
      }
      this.#robots.set(origin, rules);
    }
    return rules !== 'refuse' && robotsAllows(rules, `${url.pathname}${url.search}`);
  }

  #fetch(address: string, deadline: number, maxBytes: number): Promise<Fetched> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return Promise.reject(
        new WebReadRefusedError('timed_out', 'Reading the page took too long.'),
      );
    }
    const url = new URL(address);
    return new Promise<Fetched>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(() => {
        request.destroy();
        fail(new WebReadRefusedError('timed_out', 'Reading the page took too long.'));
      }, remaining);
      const request = this.#request(
        {
          protocol: this.#port === undefined ? 'https:' : 'http:',
          hostname: url.hostname,
          port: this.#port ?? 443,
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers: {
            'user-agent': WEB_READER_USER_AGENT,
            accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
            'accept-encoding': 'identity',
          },
          lookup: this.#lookup,
          agent: false,
          ...(this.#port === undefined ? { servername: url.hostname } : {}),
        },
        (response: IncomingMessage) => {
          const status = response.statusCode ?? 0;
          const location =
            typeof response.headers.location === 'string' ? response.headers.location : null;
          if (status >= 300 && status < 400) {
            response.resume();
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ status, contentType: '', location, body: '', truncated: false });
            return;
          }
          const decoder = new StringDecoder('utf8');
          let size = 0;
          let body = '';
          let truncated = false;
          response.on('data', (chunk: Buffer) => {
            if (truncated) return;
            const room = maxBytes - size;
            if (chunk.length > room) {
              body += decoder.write(chunk.subarray(0, room));
              size = maxBytes;
              truncated = true;
              response.destroy();
              finish();
              return;
            }
            size += chunk.length;
            body += decoder.write(chunk);
          });
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({
              status,
              contentType: String(response.headers['content-type'] ?? ''),
              location,
              body: body + decoder.end(),
              truncated,
            });
          };
          response.on('end', finish);
          response.on('error', (error) => (truncated ? finish() : fail(error)));
        },
      );
      request.on('error', (error: Error) => {
        if (error.name === 'EgressRefusedError') {
          fail(
            new WebReadRefusedError(
              'unsafe_address',
              'The address leads somewhere BrandSpace may not reach (a private or internal address).',
            ),
          );
          return;
        }
        fail(new WebReadRefusedError('unreachable', 'The site could not be reached.'));
      });
      request.end();
    });
  }
}

// ---------------------------------------------------------------------------
// A brand's own site: the home page and up to five more of the same site.
// ---------------------------------------------------------------------------

export const WEBSITE_EXTRA_PAGES = 5;
const WEBSITE_TOTAL_MS = 45_000;
const NOT_A_PAGE = /\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4|mp3|docx?|xlsx?|pptx?)(\?|$)/i;
const PREFERRED =
  /about|story|who-we-are|services|service|products|product|menu|offer|pricing|contact|team|من-نحن|خدمات|منتجات|تواصل/i;

function sameSite(a: URL, b: URL): boolean {
  const host = (url: URL) => url.hostname.toLowerCase().replace(/^www\./, '');
  return host(a) === host(b);
}

export interface WebsiteReading {
  readonly home: string;
  readonly pages: readonly WebPage[];
  /** Pages found but not read (robots, refusals, errors), counted. */
  readonly skipped: number;
}

/**
 * The brand's own site: its home page and up to five more pages of the SAME
 * site, preferring About, Services, Products, Menu, Pricing and Contact. A
 * page that cannot be read is skipped and counted; the home page must read.
 */
export async function readWebsite(
  reader: WebReader,
  home: string,
  options: { readonly extraPages?: number; readonly totalMs?: number } = {},
): Promise<WebsiteReading> {
  const deadline = Date.now() + (options.totalMs ?? WEBSITE_TOTAL_MS);
  const first = await reader.read(home);
  const base = new URL(first.url);
  const candidates = first.links
    .map((link) => new URL(link))
    .filter((url) => sameSite(url, base) && !NOT_A_PAGE.test(url.pathname))
    .map((url) => {
      url.search = '';
      return url.toString();
    })
    .filter((link, index, all) => all.indexOf(link) === index && link !== first.url);
  const ordered = [
    ...candidates.filter((link) => PREFERRED.test(decodeURI(link))),
    ...candidates.filter((link) => !PREFERRED.test(decodeURI(link))),
  ].slice(0, options.extraPages ?? WEBSITE_EXTRA_PAGES);
  const pages: WebPage[] = [first];
  let skipped = 0;
  for (const link of ordered) {
    if (Date.now() >= deadline) {
      skipped += 1;
      continue;
    }
    try {
      pages.push(await reader.read(link, Math.min(deadline, Date.now() + WEB_READ_TIMEOUT_MS)));
    } catch {
      skipped += 1;
    }
  }
  return { home: first.url, pages, skipped };
}

/** The pages as one plain-text document, each under its own heading. */
export function websiteDocument(reading: WebsiteReading, maxChars = 200_000): string {
  return reading.pages
    .map((page) =>
      [
        `# ${page.title ?? new URL(page.url).pathname}`,
        page.url,
        page.description ? `\n${page.description}` : '',
        '',
        page.text,
      ].join('\n'),
    )
    .join('\n\n---\n\n')
    .slice(0, maxChars);
}

// ---------------------------------------------------------------------------
// Which reader a process uses.
// ---------------------------------------------------------------------------

/**
 * The reader for this process: the real one — or, when
 * `WEB_READER_FIXTURE_PORT` is set, a DEVELOPMENT DOUBLE that reaches the
 * end-to-end suite's stand-in web site (`tests/e2e/fake-web.ts`) on
 * 127.0.0.1. Every other rule (https names, robots.txt, redirects re-checked,
 * limits) still applies; only the address the names resolve to is the local
 * one. Like every other double (CLAUDE.md §2.2, D-215) it REFUSES to be built
 * when `APP_ENV=production`.
 */
export function webReaderFromEnvironment(
  source: Record<string, string | undefined> = process.env,
): WebReader {
  const port = source['WEB_READER_FIXTURE_PORT'];
  if (!port) return new WebReader();
  assertNotProduction(
    'the web reader fixture',
    'Unset WEB_READER_FIXTURE_PORT: production reads the real web.',
    source,
  );
  return new WebReader({
    port: Number(port),
    request: httpRequest,
    lookup: pinnedLookup(
      (_host, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]),
      (address) => address === '127.0.0.1',
    ),
  });
}
