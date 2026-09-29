import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeBrandCompletion, knowledgeSignatureOf } from '@brandspace/brand-brain';
import { ATTENTION_ACTIONS } from '../../apps/dashboard/src/server/home';
import { messages } from '../../apps/dashboard/src/i18n/messages';

/**
 * PHASE 2C-4 (Item 6) — the rules that need no database: the D13 signature's
 * arithmetic, D12's empty question set and its one review row, and where D11,
 * D12 and D13 are gated. The behaviour against real rows is in
 * `tests/isolation/phase2c4-item6.test.ts`.
 */

const ROOT = path.join(__dirname, '../..');
const source = (relative: string) => readFileSync(path.join(ROOT, relative), 'utf8');

describe('D13 — the signature', () => {
  const a = { itemId: '11111111-1111-4111-8111-111111111111', version: 3 };
  const b = { itemId: '22222222-2222-4222-8222-222222222222', version: 1 };

  it('is SHA-256 over the sorted itemId:version lines', () => {
    const expected = createHash('sha256')
      .update(`${a.itemId}:3\n${b.itemId}:1`, 'utf8')
      .digest('hex');
    expect(knowledgeSignatureOf([a, b])).toBe(expected);
    expect(knowledgeSignatureOf([a, b])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on the order the facts were read in', () => {
    expect(knowledgeSignatureOf([b, a])).toBe(knowledgeSignatureOf([a, b]));
  });

  it('changes with a version, and with a fact leaving or joining the set', () => {
    const base = knowledgeSignatureOf([a, b]);
    expect(knowledgeSignatureOf([{ ...a, version: 4 }, b])).not.toBe(base);
    expect(knowledgeSignatureOf([a])).not.toBe(base);
    expect(knowledgeSignatureOf([])).toBe(createHash('sha256').update('').digest('hex'));
  });

  it('the Strategy page alerts through the layer and offers no client-only dismissal', () => {
    const page = source('apps/dashboard/src/app/[locale]/strategy/page.tsx');
    expect(page).toMatch(/brandBrainChangedSince\(db,/);
    expect(page).not.toMatch(/localStorage|sessionStorage/);
    const strategy = source('packages/intelligence/src/strategy.ts');
    expect(strategy).toMatch(/input\.type === 'STRATEGY' \|\| input\.type === 'MONTHLY_PLAN'/);
    expect(strategy).toMatch(/knowledgeSignatureFor\(/);
  });
});

describe('D12 — Home', () => {
  it('an EMPTY configured question set has nothing missing, so no row', () => {
    const completion = computeBrandCompletion([], new Map());
    expect(completion.missing).toEqual([]);
  });

  it('one review row replaces learnings-pending; both new kinds have an action', () => {
    expect(ATTENTION_ACTIONS['brand-brain-review-waiting']).toBe('review');
    expect(ATTENTION_ACTIONS['brand-brain-missing']).toBe('teach');
    expect(ATTENTION_ACTIONS['learnings-pending']).toBeUndefined();
    const center = source('apps/dashboard/src/server/command-center.ts');
    expect(center).not.toMatch(/kind: 'learnings-pending'/);
    expect(center).toMatch(/permissions: \['brand_brain\.review'\], run: brandBrainReviewWaiting/);
    expect(center).toMatch(
      /permissions: \['brand_brain\.read', 'brand_brain\.edit'\], run: brandBrainMissing/,
    );
  });

  it('both rows read in English and Arabic', () => {
    for (const key of [
      'attention.brand-brain-review-waiting',
      'attention.brand-brain-review-waiting.one',
      'attention.brand-brain-missing',
    ] as const) {
      expect(messages.en[key]).toBeTruthy();
      expect(messages.ar[key]).toBeTruthy();
      expect(messages.ar[key]).not.toBe(messages.en[key]);
    }
  });
});

describe('D11 — Save as learning is brand_brain.edit per card; the batch route is unchanged', () => {
  const routes = source('apps/api/src/routes/analytics.ts');

  it('the per-card route requires brand_brain.edit', () => {
    expect(routes).toMatch(
      /'\/v1\/insights\/save-learning',\s*\{\s*scope: 'workspace',\s*permission: 'brand_brain\.edit'/,
    );
    expect(routes).toMatch(/resolveCaller\(req, reply, 'brand_brain\.edit'\)/);
  });

  it('the batch route keeps brand_brain.review', () => {
    expect(routes).toMatch(
      /'\/v1\/insights\/learnings',\s*\{\s*scope: 'workspace',\s*permission: 'brand_brain\.review'/,
    );
  });

  it('both run the same domain operation', () => {
    expect(routes.match(/learning\.proposeFromInsight\(/g)).toHaveLength(2);
  });

  it('the card offers the button only to brand_brain.edit, and the action re-checks it', () => {
    const page = source('apps/dashboard/src/app/[locale]/analytics/page.tsx');
    expect(page).toMatch(
      /const mayLearn = workspace\.permissionKeys\.includes\('brand_brain\.edit'\)/,
    );
    expect(page).toMatch(/\{mayLearn \? \(\s*<SaveAsLearning/);
    const actions = source('apps/dashboard/src/app/[locale]/analytics/actions.ts');
    expect(actions).toMatch(/requireWorkspace\(locale, 'brand_brain\.edit'\)/);
  });
});

describe('Item 5 — the Remove dialog offers Drop only with brand_brain.edit', () => {
  it('the view passes upload AND edit, and the row renders Drop only then', () => {
    const view = source('apps/dashboard/src/app/[locale]/brand-brain/brand-brain-view.tsx');
    expect(view).toMatch(/canDrop=\{permissions\.upload && permissions\.edit\}/);
    expect(view).toMatch(/canUpload=\{permissions\.upload\}/);
    const row = source('apps/dashboard/src/app/[locale]/brand-brain/source-row.tsx');
    expect(row).toMatch(/\{canDrop \? \(\s*<label>/);
    expect(row).toMatch(/\{canUpload && source\.canReadAgain \? \(/);
    const actions = source('apps/dashboard/src/app/[locale]/brand-brain/actions.ts');
    expect(actions).toMatch(
      /mode === 'drop' && !holdsPermission\(session\.workspace, 'brand_brain\.edit'\)/,
    );
  });
});

describe('D13 acknowledge (owner decision Option 1) — strategy.manage, server-side', () => {
  it('the button is offered only with strategy.manage, inside the alert', () => {
    const page = source('apps/dashboard/src/app/[locale]/strategy/page.tsx');
    expect(page).toMatch(/\{mayManage && data\.accepted \? \(/);
    expect(page).toMatch(/action=\{acknowledgeKnowledgeChangeAction\}/);
    expect(page).toMatch(/const mayManage = may\('strategy\.manage'\)/);
  });

  it('the action and the route both require strategy.manage', () => {
    const actions = source('apps/dashboard/src/app/[locale]/strategy/actions.ts');
    expect(actions).toMatch(
      /acknowledgeKnowledgeChangeAction[\s\S]*?requireWorkspace\(locale, 'strategy\.manage'\)/,
    );
    const routes = source('apps/api/src/routes/analytics.ts');
    expect(routes).toMatch(
      /'\/v1\/strategy\/acknowledge-knowledge',\s*\{\s*scope: 'workspace',\s*permission: STRATEGY_MANAGE/,
    );
  });

  it('re-baselines to the layer’s current signature, conditionally, and audits both values', () => {
    const domain = source('packages/intelligence/src/knowledge-acknowledge.ts');
    expect(domain).toMatch(/knowledgeSignatureFor\(db, \{ brandId: strategy\.brandId \}, clock\)/);
    expect(domain).toMatch(/if \(current === previous\) return \{ acknowledged: false/);
    expect(domain).toMatch(/where: \{ id: strategy\.id, knowledgeSignature: previous \}/);
    expect(domain).toMatch(/before: \{ knowledgeBaseline: previous \}/);
    expect(domain).toMatch(/after: \{ knowledgeBaseline: current \}/);
    // No client-only dismissal anywhere on the page.
    const page = source('apps/dashboard/src/app/[locale]/strategy/page.tsx');
    expect(page).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
  });
});
