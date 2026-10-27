import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appLogoSrc } from '../../apps/dashboard/src/app/[locale]/settings/ai-apps/app-icon';

/**
 * D-572 (owner's edits list, item 3) — SETTINGS → CONNECTED AI APPS: the notes
 * clear the header's divider as Security's do, each connection shows the app's
 * icon, and Revoke is the platform's secondary button, keeping its second step.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const PAGE = 'apps/dashboard/src/app/[locale]/settings/ai-apps/page.tsx';
const DASHBOARD = 'https://app.brandspace.example';

describe('the app’s logo passes only the existing image rule', () => {
  it('https on the dashboard’s own origin (CSP img-src self) is shown', () => {
    expect(appLogoSrc(`${DASHBOARD}/logos/app.png`, DASHBOARD)).toBe(`${DASHBOARD}/logos/app.png`);
  });

  it('anything else draws the neutral icon: another host, http, a data URL, junk, nothing', () => {
    for (const logo of [
      'https://claude.ai/logo.png',
      'http://app.brandspace.example/logo.png',
      'data:image/svg+xml;base64,PHN2Zy8+',
      'javascript:alert(1)',
      'not a url',
      '',
      null,
      undefined,
    ]) {
      expect(appLogoSrc(logo, DASHBOARD), String(logo)).toBeNull();
    }
    expect(appLogoSrc(`${DASHBOARD}/logo.png`, null)).toBeNull();
  });

  it('the dashboard’s image rule is still self, data and blob only', () => {
    expect(read('packages/shared/src/security-headers.ts')).toContain(
      `"img-src 'self' data: blob:"`,
    );
  });
});

describe('the card', () => {
  const page = read(PAGE);

  it('every note is inside the header block, before any connection row', () => {
    const head = page.indexOf('data-testid="ai-apps-head"');
    const firstRow = page.indexOf('data-testid={`ai-app-${row.id}`}');
    expect(head).toBeGreaterThan(0);
    for (const note of [
      'ai-apps-unavailable',
      'ai-apps-refusal',
      'ai-apps-manage-all',
      'ai-apps-empty',
    ]) {
      const at = page.indexOf(`data-testid="${note}"`);
      expect(at, note).toBeGreaterThan(head);
      expect(at, note).toBeLessThan(firstRow);
    }
  });

  it('each row leads with the app’s icon: its logo through the rule, else the neutral spark tile', () => {
    expect(page).toMatch(/appLogoSrc\(row\.logoUri, process\.env\['PUBLIC_DASHBOARD_BASE_URL'\]\)/);
    expect(page).toMatch(/className="bsp-acc-ic"[\s\S]{0,200}data-testid="ai-app-icon"/);
    expect(page).toMatch(/<PrototypeIcon glyph="spark" size=\{18\} \/>/);
    expect(read('apps/api/src/ai-apps/consent-routes.ts')).toMatch(
      /client: \{ select: \{ clientName: true, logoUri: true \} \}/,
    );
  });

  it('Revoke is the secondary button, and confirming stays a separate danger button', () => {
    expect(page).toMatch(
      /<summary\s+className="bsp-btn bsp-sm bsp-sec"\s+data-testid=\{`ai-app-revoke-\$\{row\.id\}`\}/,
    );
    expect(page).toMatch(
      /className="bsp-btn bsp-sm bsp-acc-danger"\s+data-testid=\{`ai-app-revoke-confirm-\$\{row\.id\}`\}/,
    );
    expect(page).toContain('<input type="hidden" name="intent" value="REVOKE" />');
  });
});
