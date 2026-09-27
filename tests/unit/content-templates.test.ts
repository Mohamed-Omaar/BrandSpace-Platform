import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyTemplateToDraft,
  applyTemplateToGeneratedVariant,
  generationDefaults,
  normaliseHashtags,
  type TemplateSource,
} from '@brandspace/content';
import { ALL_PERMISSIONS, ROLE_DEFINITIONS } from '@brandspace/shared';
import {
  generationKeyFor,
  manualKeyFor,
} from '../../apps/dashboard/src/app/[locale]/content/compose/idempotency';

/**
 * POST TEMPLATES — prototype v90 E4 / B2 (Phase 2B-2), the rules as rules. The
 * database half is `tests/isolation/content-templates.test.ts`, and the
 * migration's grants against a fresh bootstrap are in
 * `tests/isolation/q12-notes-manage-migration.test.ts`.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

const TEMPLATE: TemplateSource = {
  id: '00000000-0000-4000-8000-000000000001',
  contentType: 'CAROUSEL',
  platformKeys: ['instagram', 'linkedin'],
  body: 'Skeleton caption',
  hashtags: ['brand', 'launch', 'spring'],
  firstComment: 'Link in bio',
};

const POLICY = {
  platforms: [
    { key: 'instagram', maxHashtags: 2, allowsFirstComment: true },
    { key: 'x', maxHashtags: 1, allowsFirstComment: false },
  ],
} as never;

describe('E4 · templates.manage', () => {
  it('is a workspace permission', () => {
    expect(ALL_PERMISSIONS.find((p) => p.key === 'templates.manage')).toMatchObject({
      resource: 'templates',
      action: 'manage',
      minScope: 'workspace',
    });
  });

  it('is held by Owner, Admin, Marketing Manager and Designer, and by nobody else', () => {
    const holders = ROLE_DEFINITIONS.filter((role) =>
      role.permissionKeys.includes('templates.manage'),
    )
      .map((role) => role.key)
      .sort();
    expect(holders).toEqual([
      'designer',
      'marketing_manager',
      'workspace_admin',
      'workspace_owner',
    ]);
  });

  it('the data migration grants exactly those roles, only when the catalogue exists', () => {
    const sql = read(
      'packages/database/prisma/migrations/20261006090000_templates_manage_permission/migration.sql',
    );
    expect(sql).toContain(
      "WHERE r.\"key\" IN ('workspace_owner', 'workspace_admin', 'marketing_manager', 'designer')",
    );
    expect(sql).toContain(
      'WHERE EXISTS (SELECT 1 FROM "permission" WHERE "key" = \'content.create\')',
    );
    const statements = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(statements.match(/ON CONFLICT[^;]*DO NOTHING/g)).toHaveLength(2);
    expect(sql).toContain('ALTER TABLE "role" NO FORCE ROW LEVEL SECURITY;');
    expect(sql).toContain('ALTER TABLE "role" FORCE ROW LEVEL SECURITY;');
    expect(sql).toMatch(/RAISE EXCEPTION 'role must have RLS ENABLED and FORCED/);
  });

  it('the table migration is tenant-owned: RLS enabled and forced, one default per brand', () => {
    const sql = read(
      'packages/database/prisma/migrations/20261006100000_content_template/migration.sql',
    );
    expect(sql).toContain('ALTER TABLE "content_template" ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('ALTER TABLE "content_template" FORCE  ROW LEVEL SECURITY;');
    expect(sql).toContain('CREATE POLICY tenant_isolation ON "content_template"');
    expect(sql).toContain('WHERE "isDefault" AND "deletedAt" IS NULL');
    expect(sql).toContain('REFERENCES "brand"("workspaceId", "id")');
  });
});

describe('B2 · applying a template to a hand-written post', () => {
  it('fills only blanks, bounded by each channel, and keeps what was typed', () => {
    const applied = applyTemplateToDraft(
      TEMPLATE,
      {
        variants: [
          { platformKey: 'instagram', body: '   ' },
          { platformKey: 'x', body: 'Mine', hashtags: ['own'], firstComment: null },
        ],
      },
      POLICY,
    );
    expect(applied.contentType).toBe('CAROUSEL');
    expect(applied.variants[0]).toMatchObject({
      body: 'Skeleton caption',
      hashtags: ['brand', 'launch'],
      firstComment: 'Link in bio',
    });
    expect(applied.variants[1]).toMatchObject({
      body: 'Mine',
      hashtags: ['own'],
      firstComment: null,
    });
  });

  it('keeps a format the request named', () => {
    expect(
      applyTemplateToDraft(TEMPLATE, { contentType: 'REEL', variants: [] }, POLICY).contentType,
    ).toBe('REEL');
  });
});

describe('B2 · applying a template to an AI generation (non-prompt fields only)', () => {
  it('supplies the format and channels only where the request named none', () => {
    expect(generationDefaults(TEMPLATE, { platformKeys: [] })).toEqual({
      contentType: 'CAROUSEL',
      platformKeys: ['instagram', 'linkedin'],
    });
    expect(generationDefaults(TEMPLATE, { contentType: 'POST', platformKeys: ['x'] })).toEqual({
      contentType: 'POST',
      platformKeys: ['x'],
    });
  });

  it('adds its hashtags first and its first comment where the channel takes one', () => {
    expect(
      applyTemplateToGeneratedVariant(
        TEMPLATE,
        { hashtags: ['model', 'Brand'], firstComment: null },
        { maxHashtags: 4, allowsFirstComment: true },
      ),
    ).toEqual({ hashtags: ['brand', 'launch', 'spring', 'model'], firstComment: 'Link in bio' });
    expect(
      applyTemplateToGeneratedVariant(
        TEMPLATE,
        { hashtags: [], firstComment: null },
        { maxHashtags: 1, allowsFirstComment: false },
      ),
    ).toEqual({ hashtags: ['brand'], firstComment: null });
  });

  it('never passes the caption skeleton into the generation prompt', () => {
    const studio = read('packages/content/src/studio.ts');
    // The only template fields generate() reads are the ones these helpers return.
    expect(studio).toContain('generationDefaults(template, input)');
    expect(studio).not.toMatch(/template\.body|template\?\.body/);
  });
});

describe('hashtags', () => {
  it('one tag, whatever its mark or case; no spaces inside a tag', () => {
    expect(normaliseHashtags(['#Launch', 'launch ', 'LAUNCH', 'two words', '##ok', ''])).toEqual([
      'Launch',
      'ok',
    ]);
  });
});

describe('the composer', () => {
  const ask = {
    brandId: 'b',
    brief: 'words',
    platformKeys: ['instagram'],
    contentLocale: 'EN',
    contentType: 'POST',
  };

  it('keeps every key minted before templates existed, and a template changes the key', () => {
    expect(generationKeyFor(ask, null)).toBe(generationKeyFor({ ...ask }, null));
    expect(generationKeyFor({ ...ask, templateId: 't1' }, null)).not.toBe(
      generationKeyFor(ask, null),
    );
    expect(manualKeyFor({ ...ask, templateId: 't1' }, '')).not.toBe(manualKeyFor(ask, ''));
  });

  it('prefills the caption only when the person writes it themselves', () => {
    const view = read('apps/dashboard/src/app/[locale]/content/compose/composer-view.tsx');
    expect(view).toContain("mode === 'write' && startingTemplate?.body");
    expect(view).toContain("if (mode === 'write' && next.body)");
    // Both create paths carry the chosen template.
    expect(view).toContain('<input type="hidden" name="templateId" value={chosenTemplateId} />');
    expect(view).toContain('...(chosenTemplateId ? { templateId: chosenTemplateId } : {}),');
  });

  it('the manual action passes only a uuid-shaped template id to the library', () => {
    const actions = read('apps/dashboard/src/app/[locale]/content/actions.ts');
    expect(actions).toContain(
      'const templateId = UUID_SHAPE.test(templateValue) ? templateValue : null;',
    );
  });
});
