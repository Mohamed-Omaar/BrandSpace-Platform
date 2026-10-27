import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { route } from './route-contract';

/**
 * D-572 — THE BRANDSPACE ICON, SERVED BY THE API HOST.
 *
 * The API's host is the address a person pastes into Claude or ChatGPT, and it
 * served no icon, so an app that looks one up by host found its hosting
 * provider's instead. It now answers the four addresses an icon is looked for
 * at, with the same mark the dashboard, the website and the Control Center use:
 *
 *   /favicon.svg           the mark itself (a copy of `apps/dashboard/src/app/icon.svg`;
 *                          `tests/unit/brand-icons.test.ts` keeps the two identical)
 *   /favicon.ico           16, 32 and 48 px, PNG-in-ICO
 *   /apple-touch-icon.png  180 px
 *   /icon-48.png           48 px, the PNG the MCP `serverInfo.icons` lists
 *
 * The PNG and ICO files are rendered from the SVG (sharp, density 600) and
 * committed; nothing is generated at run time. Every response is a fixed file:
 * public, cacheable for a day, `nosniff`, and a CSP that lets nothing run.
 */

interface BrandIcon {
  readonly path: string;
  readonly file: string;
  readonly contentType: string;
}

export const BRAND_ICONS: readonly BrandIcon[] = [
  { path: '/favicon.svg', file: 'favicon.svg', contentType: 'image/svg+xml' },
  { path: '/favicon.ico', file: 'favicon.ico', contentType: 'image/x-icon' },
  { path: '/apple-touch-icon.png', file: 'apple-touch-icon.png', contentType: 'image/png' },
  { path: '/icon-48.png', file: 'icon-48.png', contentType: 'image/png' },
];

const bodies = new Map(
  BRAND_ICONS.map((icon) => [
    icon.path,
    readFileSync(new URL(`./brand-icons/${icon.file}`, import.meta.url)),
  ]),
);

/** The bytes served at one icon address (for tests and the routes below). */
export function brandIconBody(path: string): Buffer {
  const body = bodies.get(path);
  if (!body) throw new Error(`No brand icon at ${path}.`);
  return body;
}

/**
 * MCP 2025-11-25 `Implementation.icons` (the `serverInfo` of `initialize`):
 * PNG first (the type every client must support), then the SVG.
 */
export function mcpServerIcons(apiBase: string) {
  return [
    { src: `${apiBase}/icon-48.png`, mimeType: 'image/png', sizes: ['48x48'] },
    { src: `${apiBase}/apple-touch-icon.png`, mimeType: 'image/png', sizes: ['180x180'] },
    { src: `${apiBase}/favicon.svg`, mimeType: 'image/svg+xml', sizes: ['any'] },
  ];
}

/** The fixed response for one icon address: its type, its caching and its bytes. */
export function brandIconResponse(path: string): {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
} {
  const icon = BRAND_ICONS.find((entry) => entry.path === path);
  if (!icon) throw new Error(`No brand icon at ${path}.`);
  return {
    headers: {
      'content-type': icon.contentType,
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    },
    body: brandIconBody(path),
  };
}

export function registerBrandIconRoutes(app: FastifyInstance): void {
  for (const icon of BRAND_ICONS) {
    route(app, 'GET', icon.path, { scope: 'public' }, async (_req, reply) => {
      const { headers, body } = brandIconResponse(icon.path);
      return reply.headers(headers).send(body);
    });
  }
}
