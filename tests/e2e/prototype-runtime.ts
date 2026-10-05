import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from '@playwright/test';

/**
 * THE VENDORED PROTOTYPE, OPENED AS IT IS (D-468). Shared by the parity
 * screenshots and the round 4 size check: the file is read from
 * `docs/visual-reference/` and never copied or edited; its Google Fonts request
 * is answered with the same @fontsource faces the product self-hosts, so both
 * sides measure the same typefaces whatever the network allows.
 */

export const prototypeFile = (name: string): string =>
  pathToFileURL(path.join(process.cwd(), 'docs/visual-reference/prototype-2026-09-27', name)).href;

export const PROTOTYPE = prototypeFile('Main.dc.html');

const fontsource = createRequire(path.join(process.cwd(), 'apps/dashboard/package.json'));
const FONT_HOST = 'https://fonts.gstatic.com/__fontsource';

function fontCss(): string {
  return (['inter', 'cairo'] as const)
    .flatMap((family) =>
      [400, 500, 600, 700, 800].map((weight) =>
        readFileSync(fontsource.resolve(`@fontsource/${family}/${weight}.css`), 'utf8').replaceAll(
          './files/',
          `${FONT_HOST}/${family}/`,
        ),
      ),
    )
    .join('\n');
}

export async function serveFonts(page: Page): Promise<void> {
  await page.route('https://fonts.googleapis.com/**', (route) =>
    route.fulfill({ contentType: 'text/css', body: fontCss() }),
  );
  await page.route(`${FONT_HOST}/**`, (route) => {
    const [family, file] = new URL(route.request().url()).pathname.split('/').slice(-2);
    return route.fulfill({
      path: path.join(
        path.dirname(fontsource.resolve(`@fontsource/${family}/400.css`)),
        'files',
        file ?? '',
      ),
      headers: { 'access-control-allow-origin': '*' },
    });
  });
}
