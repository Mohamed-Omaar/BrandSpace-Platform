import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  BRAND_ICONS,
  brandIconBody,
  brandIconResponse,
  mcpServerIcons,
} from '../../apps/api/src/brand-icons';
import { buildMcpServer, type McpCaller } from '../../apps/api/src/ai-apps/tools';
import type { AiAppsContext } from '../../apps/api/src/ai-apps/context';

/**
 * D-572 — THE API HOST SERVES THE BRANDSPACE ICON. Claude showed the hosting
 * provider's icon for the connector because the API's host served none. Each
 * address answers 200 with the right type and the Brandspace mark; the MCP
 * `initialize` response lists the icons (MCP 2025-11-25 `Implementation.icons`).
 */

const root = path.resolve(__dirname, '../..');
const API = 'https://api.brandspace.example';

/** Width and height from a PNG's IHDR chunk. */
function pngSize(png: Buffer): { width: number; height: number } {
  expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe('D-572 · every icon address on the API host', () => {
  it('each answers with its type, a day of caching, nosniff and a CSP that runs nothing', () => {
    const expected: Record<string, string> = {
      '/favicon.svg': 'image/svg+xml',
      '/favicon.ico': 'image/x-icon',
      '/apple-touch-icon.png': 'image/png',
      '/icon-48.png': 'image/png',
    };
    expect(BRAND_ICONS.map((icon) => icon.path)).toEqual(Object.keys(expected));
    for (const [url, type] of Object.entries(expected)) {
      const { headers, body } = brandIconResponse(url);
      expect(headers['content-type'], url).toBe(type);
      expect(headers['cache-control'], url).toBe('public, max-age=86400');
      expect(headers['x-content-type-options'], url).toBe('nosniff');
      expect(headers['content-security-policy'], url).toContain("default-src 'none'");
      expect(body.length, url).toBeGreaterThan(0);
    }
    expect(() => brandIconResponse('/favicon.gif')).toThrow();
  });

  it('the routes serve exactly these responses (registered as public, nothing else)', () => {
    const source = readFileSync(path.join(root, 'apps/api/src/brand-icons.ts'), 'utf8');
    expect(source).toMatch(
      /route\(app, 'GET', icon\.path, \{ scope: 'public' \}[\s\S]{0,160}brandIconResponse\(icon\.path\)/,
    );
    expect(readFileSync(path.join(root, 'apps/api/src/server.ts'), 'utf8')).toContain(
      'registerBrandIconRoutes(app);',
    );
  });

  it('the SVG is the dashboard’s own mark, byte for byte', () => {
    expect(brandIconBody('/favicon.svg').toString('utf8')).toBe(
      readFileSync(path.join(root, 'apps/dashboard/src/app/icon.svg'), 'utf8'),
    );
  });

  it('the PNGs are 180 and 48 px; the ICO holds 16, 32 and 48 px PNGs', () => {
    expect(pngSize(brandIconBody('/apple-touch-icon.png'))).toEqual({ width: 180, height: 180 });
    expect(pngSize(brandIconBody('/icon-48.png'))).toEqual({ width: 48, height: 48 });
    const ico = brandIconBody('/favicon.ico');
    expect(ico.readUInt16LE(2)).toBe(1);
    const count = ico.readUInt16LE(4);
    const sizes = Array.from({ length: count }, (_, i) => {
      const entry = 6 + 16 * i;
      const size = ico.readUInt8(entry);
      const offset = ico.readUInt32LE(entry + 12);
      const length = ico.readUInt32LE(entry + 8);
      expect(pngSize(ico.subarray(offset, offset + length))).toEqual({ width: size, height: size });
      return size;
    });
    expect(sizes).toEqual([16, 32, 48]);
  });
});

describe('D-572 · the MCP server announces its icons', () => {
  it('serverInfo carries the icons (PNG first) and the website, as MCP 2025-11-25 allows', async () => {
    expect(mcpServerIcons(API)).toEqual([
      { src: `${API}/icon-48.png`, mimeType: 'image/png', sizes: ['48x48'] },
      { src: `${API}/apple-touch-icon.png`, mimeType: 'image/png', sizes: ['180x180'] },
      { src: `${API}/favicon.svg`, mimeType: 'image/svg+xml', sizes: ['any'] },
    ]);
    const ctx = {
      addresses: () => ({ api: API, dashboard: 'https://app.brandspace.example' }),
    } as unknown as AiAppsContext;
    const caller = {
      locale: 'en',
      permissionKeys: [],
      memberBrandScope: [],
      connectionBrandIds: [],
      scopes: [],
    } as unknown as McpCaller;
    const server = buildMcpServer(caller, ctx);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide as unknown as Transport);
    const client = new Client({ name: 'unit', version: '1.0.0' });
    await client.connect(clientSide as unknown as Transport);
    const info = client.getServerVersion();
    expect(info?.name).toBe('brandspace');
    expect(info?.icons).toEqual(mcpServerIcons(API));
    expect(info?.websiteUrl).toBe('https://app.brandspace.example');
    await client.close();
  });
});
