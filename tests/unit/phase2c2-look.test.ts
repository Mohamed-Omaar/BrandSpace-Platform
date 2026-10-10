import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError } from '@brandspace/shared';
import {
  paletteFromForm,
  slotField,
  typographySlotsFromForm,
} from '../../apps/dashboard/src/server/brand-look';

/**
 * PHASE 2C-2, ITEM 3 — the Look & voice decoders and the permission gate.
 */

const ROOT = path.resolve(import.meta.dirname, '../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

const form = (entries: Record<string, string | readonly string[]>): FormData => {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    for (const one of typeof value === 'string' ? [value] : value) data.append(key, one);
  }
  return data;
};

const FONT_EN = '11111111-2222-4333-8444-555555555555';
const FONT_AR = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const context = {
  policy: { brandFonts: { catalogue: ['inter', 'poppins', 'cairo', 'amiri'] } },
  activeFonts: [
    { id: FONT_EN, language: 'EN' },
    { id: FONT_AR, language: 'AR' },
  ],
};

const slots = (overrides: Record<string, string> = {}) =>
  form({
    [slotField('en', 'heading')]: 'catalogue:poppins',
    [slotField('en', 'body')]: `uploaded:${FONT_EN}`,
    [slotField('ar', 'heading')]: 'catalogue:amiri',
    [slotField('ar', 'body')]: `uploaded:${FONT_AR}`,
    ...overrides,
  });

describe('the four slots from the Look & voice form', () => {
  it('reads typed catalogue and uploaded references for every slot', () => {
    expect(typographySlotsFromForm(slots(), context)).toEqual({
      en: {
        heading: { kind: 'catalogue', key: 'poppins' },
        body: { kind: 'uploaded', brandFontId: FONT_EN },
      },
      ar: {
        heading: { kind: 'catalogue', key: 'amiri' },
        body: { kind: 'uploaded', brandFontId: FONT_AR },
      },
    });
  });

  it('refuses a catalogue font not offered, or of the other language', () => {
    expect(() =>
      typographySlotsFromForm(slots({ [slotField('en', 'heading')]: 'catalogue:lora' }), context),
    ).toThrow(AppError);
    expect(() =>
      typographySlotsFromForm(slots({ [slotField('en', 'heading')]: 'catalogue:cairo' }), context),
    ).toThrow(AppError);
  });

  it('refuses an uploaded font that is not this brand’s active font of that language', () => {
    expect(() =>
      typographySlotsFromForm(slots({ [slotField('en', 'body')]: `uploaded:${FONT_AR}` }), context),
    ).toThrow(AppError);
    expect(() =>
      typographySlotsFromForm(
        slots({ [slotField('ar', 'body')]: 'uploaded:00000000-0000-4000-8000-000000000000' }),
        context,
      ),
    ).toThrow(AppError);
  });

  it('refuses a missing slot or a bare family name', () => {
    const missing = slots();
    missing.delete(slotField('ar', 'heading'));
    expect(() => typographySlotsFromForm(missing, context)).toThrow(AppError);
    expect(() =>
      typographySlotsFromForm(slots({ [slotField('en', 'heading')]: 'Poppins' }), context),
    ).toThrow(AppError);
  });
});

describe('the palette — one rule for both screens', () => {
  it('accepts hex colours, de-duplicates, and bounds at twelve', () => {
    expect(paletteFromForm(form({ colorPalette: ['#7935FE', '#FFDD15', '#7935FE'] }))).toEqual([
      '#7935FE',
      '#FFDD15',
    ]);
    expect(() => paletteFromForm(form({ colorPalette: 'red' }))).toThrow(AppError);
    expect(() =>
      paletteFromForm(
        form({
          colorPalette: Array.from({ length: 13 }, (_, i) => `#0000${String(i).padStart(2, '0')}`),
        }),
      ),
    ).toThrow(AppError);
  });

  it('Settings → Brand uses the same rule', () => {
    expect(read('apps/dashboard/src/server/brand-profile.ts')).toMatch(
      /paletteFromForm\(formData\)/,
    );
  });
});

describe('the permission gate — brand.manage, before anything is read', () => {
  const actions = read('apps/dashboard/src/app/[locale]/brand-brain/look-actions.ts');

  it('`begin` requires brand.manage and the BrandScope first', () => {
    expect(actions).toMatch(/requireWorkspaceAction\(locale, 'brand\.manage'\)/);
    expect(actions.indexOf("requireWorkspaceAction(locale, 'brand.manage')")).toBeLessThan(
      actions.indexOf('assertBrandInScope(session.workspace.brandScope, brandId)'),
    );
  });

  it('every exported Look & voice action goes through `begin`', () => {
    const exported = [
      ...actions.matchAll(/export async function (\w+)\(formData: FormData\)/g),
    ].map((match) => match[1]!);
    expect(exported.sort()).toEqual([
      'addBrandFontAction',
      // Batch 7 PR C (2c): the logo slot attaches a file once its scan passes.
      'attachBrandLogoAction',
      'chooseBrandLogoAction',
      'removeBrandFontAction',
      'renameBrandFontAction',
      'replaceBrandFontAction',
      'saveBrandColoursAction',
      'saveBrandTypographyAction',
      'uploadBrandLogoAction',
    ]);
    for (const name of exported) {
      const start = actions.indexOf(`export async function ${name}(`);
      const next = actions.indexOf('export async function', start + 1);
      const body = actions.slice(start, next === -1 ? undefined : next);
      expect(body, name).toMatch(/await begin\(formData\)/);
    }
  });

  it('the controls are offered only with brand.manage (and uploads only with assets.upload)', () => {
    const page = read('apps/dashboard/src/app/[locale]/brand-brain/page.tsx');
    expect(page).toMatch(/canManage: can\('brand\.manage'\)/);
    expect(page).toMatch(/canUpload: can\('assets\.upload'\)/);
    const card = read('apps/dashboard/src/app/[locale]/brand-brain/look-card.tsx');
    expect(card).toMatch(/if \(!canManage\) \{/);
    expect(card).toMatch(/canUpload=\{canManage && canUpload\}/);
  });
});
