import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pinnedLookup } from '@brandspace/ai-gateway/egress';
import {
  WEB_READER_USER_AGENT,
  WebReader,
  htmlToText,
  parseRobots,
  readWebsite,
  robotsAllows,
  unsafeAddressReason,
  websiteDocument,
} from '@brandspace/brand-brain';

/**
 * PR C (owner, 2026-11-14) — THE WEB READER'S BOUNDARIES, against a local
 * server that stands in for the web. Requests go through the real pinned
 * lookup: names resolve as the table below says, and only the local server's
 * address counts as "public" here, so a name that resolves to a private or
 * metadata address is refused exactly as it would be in production.
 */

const NAMES: Record<string, string> = {
  'brand.example.com': '127.0.0.1',
  'other.example.com': '127.0.0.1',
  'sneaky.example.com': '10.0.0.5', // a public-looking name that resolves privately
  'metadata.example.com': '169.254.169.254',
};
const lookup = pinnedLookup(
  (host, callback) => {
    const address = NAMES[host];
    if (!address) {
      callback(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }), []);
      return;
    }
    callback(null, [{ address, family: 4 }]);
  },
  (address) => address === '127.0.0.1',
);

let server: Server;
let port = 0;
let robots = 'User-agent: *\nDisallow: /private\n';
let robotsStatus = 200;
const seenAgents: string[] = [];

const PAGE = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title><meta name="description" content="About &amp; more"><style>.x{}</style></head><body><script>alert(1)</script>${body}</body></html>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    seenAgents.push(String(req.headers['user-agent']));
    const path = req.url ?? '/';
    const html = (status: number, body: string) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    };
    switch (path) {
      case '/robots.txt':
        res.writeHead(robotsStatus, { 'content-type': 'text/plain' });
        res.end(robots);
        return;
      case '/':
        html(
          200,
          PAGE(
            'Bayt Coffee',
            '<h1>Bayt Coffee</h1><p>Speciality roastery in Riyadh.</p>' +
              '<a href="/blog/post-1">Blog</a><a href="/about-us">About</a>' +
              '<a href="https://brand.example.com/menu">Menu</a><a href="/files/menu.pdf">PDF</a>' +
              '<a href="https://elsewhere.example.org/">Elsewhere</a><a href="/private/x">Hidden</a>',
          ),
        );
        return;
      case '/about-us':
        html(200, PAGE('About', '<p>Founded in 2019 by two baristas.</p>'));
        return;
      case '/menu':
        html(200, PAGE('Menu', '<ul><li>Flat white</li><li>V60</li></ul>'));
        return;
      case '/blog/post-1':
        html(200, PAGE('Blog', '<p>Autumn notes.</p>'));
        return;
      case '/private/x':
        html(200, PAGE('Private', '<p>Should never be read.</p>'));
        return;
      case '/to-private':
        res.writeHead(302, { location: 'https://sneaky.example.com/' });
        res.end();
        return;
      case '/to-metadata':
        res.writeHead(301, { location: 'https://metadata.example.com/latest/meta-data/' });
        res.end();
        return;
      case '/to-about':
        res.writeHead(302, { location: '/about-us' });
        res.end();
        return;
      case '/loop':
        res.writeHead(302, { location: '/loop' });
        res.end();
        return;
      case '/big': {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('a'.repeat(3 * 1024 * 1024));
        return;
      }
      case '/slow':
        setTimeout(() => html(200, PAGE('Slow', '<p>late</p>')), 3_000);
        return;
      case '/image.png':
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        return;
      default:
        html(404, 'missing');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  robots = 'User-agent: *\nDisallow: /private\n';
  robotsStatus = 200;
});

const reader = (timeoutMs = 2_000) =>
  new WebReader({ lookup, request: httpRequest, port, timeoutMs });
const SITE = 'https://brand.example.com';

describe('PR C · only safe addresses are read', () => {
  it.each([
    ['http://brand.example.com/', 'Only https://'],
    ['https://user:pass@brand.example.com/', 'user name or password'],
    ['https://brand.example.com:8443/', 'standard https port'],
    ['https://10.0.0.5/', 'IP address'],
    ['https://169.254.169.254/latest/meta-data/', 'IP address'],
    ['https://[::1]/', 'IP address'],
    ['https://printer.local/', 'private network'],
    ['https://db.internal/', 'private network'],
    ['not a link', 'not a web address'],
  ])('%s is refused before any connection', async (address, words) => {
    expect(unsafeAddressReason(address)).toContain(words);
    await expect(reader().read(address)).rejects.toMatchObject({ reason: 'unsafe_address' });
  });

  it('a public-looking name that resolves to a PRIVATE address is refused at connection', async () => {
    await expect(reader().read('https://sneaky.example.com/')).rejects.toMatchObject({
      reason: 'unsafe_address',
    });
  });

  it('a redirect to a private address is refused; so is one to the metadata service', async () => {
    await expect(reader().read(`${SITE}/to-private`)).rejects.toMatchObject({
      reason: 'unsafe_address',
    });
    await expect(reader().read(`${SITE}/to-metadata`)).rejects.toMatchObject({
      reason: 'unsafe_address',
    });
  });

  it('a safe redirect is followed; more than three are refused', async () => {
    const page = await reader().read(`${SITE}/to-about`);
    expect(page.url).toBe(`${SITE}/about-us`);
    expect(page.text).toContain('Founded in 2019');
    await expect(reader().read(`${SITE}/loop`)).rejects.toMatchObject({
      reason: 'too_many_redirects',
    });
  });
});

describe('PR C · limits', () => {
  it('reading stops at 2 MB and says so', async () => {
    const page = await reader().read(`${SITE}/big`);
    expect(page.truncated).toBe(true);
    expect(page.text.length).toBe(2 * 1024 * 1024);
  });

  it('a page slower than the limit is given up on', async () => {
    await expect(reader(500).read(`${SITE}/slow`)).rejects.toMatchObject({ reason: 'timed_out' });
  });

  it('something that is not a page (an image) is not read', async () => {
    await expect(reader().read(`${SITE}/image.png`)).rejects.toMatchObject({
      reason: 'not_a_page',
    });
  });

  it('it says who it is: BrandSpaceBot', async () => {
    seenAgents.length = 0;
    await reader().read(`${SITE}/`);
    expect(seenAgents.every((agent) => agent === WEB_READER_USER_AGENT)).toBe(true);
  });
});

describe('PR C · robots.txt is respected', () => {
  it('a disallowed path is not read; an allowed one is', async () => {
    await expect(reader().read(`${SITE}/private/x`)).rejects.toMatchObject({
      reason: 'robots_disallowed',
    });
    await expect(reader().read(`${SITE}/about-us`)).resolves.toMatchObject({ title: 'About' });
  });

  it('a group for BrandSpaceBot wins over `*`', async () => {
    robots = 'User-agent: *\nDisallow:\n\nUser-agent: BrandSpaceBot\nDisallow: /\n';
    await expect(reader().read(`${SITE}/about-us`)).rejects.toMatchObject({
      reason: 'robots_disallowed',
    });
  });

  it('no robots.txt (404): the site may be read', async () => {
    robotsStatus = 404;
    await expect(reader().read(`${SITE}/private/x`)).resolves.toMatchObject({ title: 'Private' });
  });

  it('robots.txt failing (5xx): the site is not read', async () => {
    robotsStatus = 503;
    await expect(reader().read(`${SITE}/about-us`)).rejects.toMatchObject({
      reason: 'robots_disallowed',
    });
  });

  it('the rules: longest match wins, allow wins a tie, wildcards and $', () => {
    const rules = parseRobots(
      'User-agent: *\nDisallow: /shop\nAllow: /shop/about\nDisallow: /*.json$\n',
    );
    expect(robotsAllows(rules, '/shop/cart')).toBe(false);
    expect(robotsAllows(rules, '/shop/about')).toBe(true);
    expect(robotsAllows(rules, '/data/feed.json')).toBe(false);
    expect(robotsAllows(rules, '/data/feed.json?x=1')).toBe(true);
    expect(robotsAllows(rules, '/')).toBe(true);
  });
});

describe('PR C · a page becomes text', () => {
  it('scripts and styles are dropped; title, description, text and links are kept', () => {
    const page = htmlToText(
      PAGE(
        'Bayt &amp; Co',
        '<p>Hello&nbsp;world</p><a href="/a#top">A</a><a href="http://x.com">B</a>',
      ),
      'https://brand.example.com/',
    );
    expect(page.title).toBe('Bayt & Co');
    expect(page.description).toBe('About & more');
    expect(page.text).toBe('Hello world\nA B');
    expect(page.text).not.toContain('alert');
    // https links only, absolute, without the fragment.
    expect(page.links).toEqual(['https://brand.example.com/a']);
  });
});

describe('PR C · the brand’s own website', () => {
  it('the home page and up to five pages of the same site, About and Menu first', async () => {
    const reading = await readWebsite(reader(), `${SITE}/`, { totalMs: 10_000 });
    const urls = reading.pages.map((page) => page.url);
    expect(urls[0]).toBe(`${SITE}/`);
    // Preferred pages first; the PDF and the other site are never candidates;
    // the robots-disallowed page is skipped and counted.
    expect(urls.slice(1, 3).sort()).toEqual([`${SITE}/about-us`, `${SITE}/menu`]);
    expect(urls).toContain(`${SITE}/blog/post-1`);
    expect(urls.some((url) => url.includes('elsewhere') || url.endsWith('.pdf'))).toBe(false);
    expect(reading.skipped).toBe(1);
    const document = websiteDocument(reading);
    expect(document).toContain('# Bayt Coffee');
    expect(document).toContain('Founded in 2019');
    expect(document).not.toContain('Should never be read');
  });
});

describe('PR C · the end-to-end double never runs in production', () => {
  it('WEB_READER_FIXTURE_PORT is refused when APP_ENV=production; unset, the real reader is used', async () => {
    const { webReaderFromEnvironment } = await import('@brandspace/brand-brain');
    expect(() =>
      webReaderFromEnvironment({ WEB_READER_FIXTURE_PORT: '3106', APP_ENV: 'production' }),
    ).toThrow();
    expect(webReaderFromEnvironment({ APP_ENV: 'production' })).toBeInstanceOf(WebReader);
    expect(
      webReaderFromEnvironment({ WEB_READER_FIXTURE_PORT: '3106', APP_ENV: 'development' }),
    ).toBeInstanceOf(WebReader);
  });
});
