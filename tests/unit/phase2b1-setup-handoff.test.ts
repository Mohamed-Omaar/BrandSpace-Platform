import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mayOverwrite, originRank, type PrecedenceSubject } from '@brandspace/brand-brain';
import { optionalMessage } from '../../apps/dashboard/src/i18n/messages';
import { setupBrandFrom } from '../../apps/dashboard/src/server/setup-brand-form';
import { decodeSignupDraft, encodeSignupDraft } from '../../apps/dashboard/src/server/signup-draft';
import {
  goalKnowledge,
  goalLabels,
  storedGoal,
} from '../../apps/dashboard/src/server/setup-wizard-state';

/**
 * G8 / C6 / Q16 (prototype v94 Phase 2B-1, D-335) — the sign-up, reset and
 * setup-wizard handoff, as rules. The writes against PostgreSQL are
 * `tests/isolation/phase2b1-setup-handoff.test.ts`; the flow in a browser is
 * the Phase 2B-1 E2E spec.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

function subject(origin: PrecedenceSubject['origin']): PrecedenceSubject {
  return { memory: 'STRATEGY', origin, version: 1, id: 'x' };
}

describe('D-335 · SETUP ranks with DOCUMENT', () => {
  it('below HUMAN, level with DOCUMENT, above an inference', () => {
    expect(originRank('SETUP')).toBe(originRank('DOCUMENT'));
    expect(originRank('HUMAN')).toBeLessThan(originRank('SETUP'));
    expect(originRank('SETUP')).toBeLessThan(originRank('AI_INFERRED'));
  });

  it('a Brand Brain edit outranks it; a newer document may refresh it; an inference never replaces it', () => {
    expect(mayOverwrite(subject('SETUP'), subject('HUMAN')).allowed).toBe(true);
    expect(mayOverwrite(subject('SETUP'), subject('DOCUMENT')).allowed).toBe(true);
    expect(mayOverwrite(subject('SETUP'), subject('AI_INFERRED'))).toEqual({
      allowed: false,
      reason: 'human_precedence',
    });
    // Setup never lowers what a person wrote in Brand Brain.
    expect(mayOverwrite(subject('HUMAN'), subject('SETUP')).allowed).toBe(false);
  });

  it('review item 15: SETUP is decided on the server — Brand Brain always DOCUMENT, the wizard by its own rule', () => {
    const brandBrain = read('apps/dashboard/src/app/[locale]/brand-brain/actions.ts');
    const review = brandBrain.slice(
      brandBrain.indexOf('export async function reviewCandidateAction'),
    );
    const body = review.slice(0, review.indexOf('\n}\n'));
    // Brand Brain passes a literal false; nothing from the form reaches the origin.
    expect(body).toMatch(
      /applyCandidateReview\([\s\S]*?\(await policy\(\)\)\.staleness,[\s\S]*?false,\s*\)/,
    );
    expect(body).not.toContain('acceptedInSetup');
    expect(body).not.toMatch(/back\.path === '\/onboarding'/);

    const onboarding = read('apps/dashboard/src/app/[locale]/onboarding/actions.ts');
    const setup = onboarding.slice(
      onboarding.indexOf('export async function reviewSetupCandidateAction'),
    );
    expect(setup).toContain(
      'await setupReviewInProgress(db, parsed.candidateId, actor.brandScope)',
    );
    expect(setup).not.toMatch(/formData\.get\('(origin|returnTo|step|setup)'\)/);

    // The wizard's Review forms post to the wizard's own action, and carry no marker.
    const page = read('apps/dashboard/src/app/[locale]/onboarding/page.tsx');
    expect(page).toContain('action={reviewSetupCandidateAction}');
    expect(page).not.toContain('action={reviewCandidateAction}');

    const knowledge = read('packages/brand-brain/src/knowledge.ts');
    // An analytics candidate stays an inference whatever the screen.
    expect(knowledge).toMatch(
      /candidate\.sourceKind === 'ANALYTICS'\s*\?\s*'AI_INFERRED'\s*:\s*input\.acceptedInSetup === true\s*\?\s*'SETUP'\s*:\s*'DOCUMENT'/,
    );
    // An analytics learning that shares a SETUP fact's key is a conflict.
    expect(knowledge).toContain("origin: { in: ['HUMAN', 'DOCUMENT', 'SETUP'] },");
  });
});

describe('D-335 · the goal is read by its key while setup wrote it', () => {
  const labels = goalLabels('en');

  const latest = (changeKind: string) => [{ changeKind }];

  it('by key while setup wrote the latest version, whatever the title says', () => {
    const key = { primaryGoalKey: 'LEADS' };
    // Created by setup and untouched since.
    expect(
      storedGoal({ title: { en: 'x' }, origin: 'SETUP', versions: latest('created'), brand: key }),
    ).toBe('LEADS');
    // Chosen again in setup over setup's own goal.
    expect(
      storedGoal({ title: { en: 'x' }, origin: 'SETUP', versions: latest('setup'), brand: key }),
    ).toBe('LEADS');
  });

  it('by title once anyone else wrote the latest version, or when no key was stored', () => {
    const title = goalKnowledge('TRAFFIC').title;
    const key = { primaryGoalKey: 'LEADS' };
    for (const kind of ['edited', 'rolled_back', 'approved']) {
      expect(storedGoal({ title, origin: 'SETUP', versions: latest(kind), brand: key }), kind).toBe(
        'TRAFFIC',
      );
    }
    // A HUMAN row was last written by a person, not setup — whatever its kind.
    for (const kind of ['created', 'setup', 'edited']) {
      expect(storedGoal({ title, origin: 'HUMAN', versions: latest(kind), brand: key }), kind).toBe(
        'TRAFFIC',
      );
    }
    expect(
      storedGoal({
        title,
        origin: 'SETUP',
        versions: latest('created'),
        brand: { primaryGoalKey: null },
      }),
    ).toBe('TRAFFIC');
    expect(
      storedGoal({
        title: { en: 'My own words' },
        origin: 'SETUP',
        versions: latest('edited'),
        brand: key,
      }),
    ).toBeNull();
    expect(storedGoal(null)).toBeNull();
    expect(labels.TRAFFIC).toBe(title.en);
  });

  it('a key that is not a goal is never trusted', () => {
    for (const primaryGoalKey of ['unsure', 'BOGUS']) {
      expect(
        storedGoal({
          title: { en: 'x' },
          origin: 'SETUP',
          versions: latest('created'),
          brand: { primaryGoalKey },
        }),
      ).toBeNull();
    }
  });

  /*
   * REPLACED (owner review of PR #52, D-354): the Strategy page and the
   * composer read the goal as WRITING input, so they read it through the Brand
   * Brain grounding layer's `writingGoal`, whose `BRAND_GOAL_SELECT` is held
   * equal to `GOAL_ITEM_SELECT` (tests/unit/phase2c-grounding.test.ts). Old:
   * all three files named `GOAL_ITEM_SELECT`. New: setup reads with it; the two
   * writing readers read through `writingGoal`, which selects with the same
   * fields. Every reader still decodes with `storedGoal`, never by title alone.
   */
  it('every reader asks through the one select and the one decoder', () => {
    const setup = read('apps/dashboard/src/server/setup-wizard.ts');
    expect(setup).toContain('GOAL_ITEM_SELECT');
    for (const file of [
      'apps/dashboard/src/app/[locale]/strategy/page.tsx',
      'apps/dashboard/src/app/[locale]/content/compose/page.tsx',
    ]) {
      expect(read(file), file).toMatch(/\bwritingGoal\(/);
    }
    expect(read('packages/brand-brain/src/grounding.ts')).toMatch(
      /export async function writingGoal[\s\S]*?select: BRAND_GOAL_SELECT/,
    );
    for (const file of [
      'apps/dashboard/src/server/setup-wizard.ts',
      'apps/dashboard/src/app/[locale]/strategy/page.tsx',
      'apps/dashboard/src/app/[locale]/content/compose/page.tsx',
    ]) {
      const source = read(file);
      expect(source, file).toContain('storedGoal(');
      expect(source, file).not.toContain('goalFromTitle(');
    }
  });

  it('the goal is written as SETUP, and choosing it again is a SETUP version setup signs', () => {
    const save = read('apps/dashboard/src/server/setup-goal.ts');
    expect(save).toContain("origin: 'SETUP',");
    // Blocker 0: always SETUP — a HUMAN goal is refused, never re-labelled.
    expect(save).toContain("incomingOrigin: 'SETUP',");
    expect(save).not.toMatch(/incomingOrigin: existing\.origin/);
    expect(save).toContain('changeKind: SETUP_GOAL_CHANGE_KIND,');
    expect(save).toContain('data: { primaryGoalKey: goal }');
    expect(save.indexOf('assertBrandInScope(')).toBeLessThan(save.indexOf('db.brand.findFirst('));
  });
});

describe('D-335 · the languages the brand publishes in', () => {
  const form = (supported: readonly string[], defaultLocale = 'EN') => {
    const data = new FormData();
    data.set('name', 'Acme');
    data.set('websiteUrl', '');
    data.set('industry', '');
    data.set('defaultLocale', defaultLocale);
    data.set('colorPalette', '');
    for (const code of supported) data.append('supportedLocales', code);
    return data;
  };

  it('at least one is required — on the server as well as in the browser', () => {
    expect(() => setupBrandFrom(form([]))).toThrow(/at least one language/);
    const fields = read('apps/dashboard/src/components/setup-brand-languages.tsx');
    expect(fields).toContain(
      "first.current?.setCustomValidity(posting.length === 0 ? labels.atLeastOne : '');",
    );
  });

  it('exactly one decides the AI language; both leave it to the select', () => {
    expect(setupBrandFrom(form(['AR'], 'EN')).defaultLocale).toBe('AR');
    expect(setupBrandFrom(form(['EN'], 'AR')).defaultLocale).toBe('EN');
    expect(setupBrandFrom(form(['EN', 'AR'], 'AR')).defaultLocale).toBe('AR');
  });

  it('the wizard offers the activated industry list with "Something else", as Settings does', () => {
    const page = read('apps/dashboard/src/app/[locale]/onboarding/page.tsx');
    expect(page).toContain('<IndustryField');
    expect(page).toContain('<SetupBrandLanguages');
    expect(page).not.toContain('id="setup-brand-industry"');
    expect(read('apps/dashboard/src/app/[locale]/settings/general-fields.tsx')).toContain(
      '<IndustryField',
    );
  });
});

describe('G8 · sign-up keeps what was typed, never the password', () => {
  it('round-trips name, email and time zone, bounded', () => {
    const raw = encodeSignupDraft({
      name: 'Mona',
      email: 'mona@example.com',
      timezone: 'Africa/Cairo',
    });
    expect(decodeSignupDraft(raw)).toEqual({
      name: 'Mona',
      email: 'mona@example.com',
      timezone: 'Africa/Cairo',
    });
    expect(raw).not.toMatch(/password/i);
    expect(
      decodeSignupDraft(encodeSignupDraft({ name: 'x'.repeat(500), email: '', timezone: '' }))
        ?.name,
    ).toHaveLength(120);
    expect(decodeSignupDraft('not json')).toBeNull();
    expect(decodeSignupDraft(undefined)).toBeNull();
    expect(decodeSignupDraft(JSON.stringify({ name: 5, password: 'secret' }))).toEqual({
      name: '',
      email: '',
      timezone: '',
    });
  });

  it('the draft rides a short-lived httpOnly, same-site cookie, set only on a refusal', () => {
    const actions = read('apps/dashboard/src/app/[locale]/(auth)/actions.ts');
    const signUp = actions.slice(actions.indexOf('export async function signUpAction'));
    const body = signUp.slice(0, signUp.indexOf('\n}\n'));
    expect(body).toMatch(
      /\{ httpOnly: true, secure: true, sameSite: 'strict', path: '\/', maxAge: 120 \}/,
    );
    expect(body.indexOf('(await cookies()).delete(SIGNUP_DRAFT_COOKIE);')).toBeLessThan(
      body.indexOf('} catch'),
    );
    expect(body.indexOf('encodeSignupDraft(')).toBeGreaterThan(body.indexOf('} catch'));
    expect(body.slice(body.indexOf('encodeSignupDraft('))).not.toMatch(/password/);
    const page = read('apps/dashboard/src/app/[locale]/(auth)/sign-up/page.tsx');
    expect(page).toContain("defaultValue={draft?.email ?? ''}");
    expect(page).not.toMatch(/draft\?\.password/);
  });
});

describe('G8 / Q16 · a mismatched reset confirmation blocks the submit (D-261 unchanged)', () => {
  it('the confirmation reports itself invalid while it differs', () => {
    const field = read('packages/ui/src/password-field.tsx');
    expect(field).toContain(
      "confirmRef.current?.setCustomValidity(mismatched ? (labels.mismatch ?? ' ') : '');",
    );
    expect(field).toContain('ref={confirmRef}');
  });
});

describe('G8 · a new workspace from inside the app', () => {
  it('has a way back, and asks for a city only for Egypt', () => {
    // Review of #67, round 3: the way back is the Business step's footer
    // "Back", drawn by the form the page hands it to.
    const page = read('apps/dashboard/src/app/[locale]/onboarding/workspace/page.tsx');
    expect(page).toContain("{ href: `/${locale}/overview`, label: t('createWorkspace.back') }");
    const form = read('apps/dashboard/src/app/[locale]/onboarding/workspace/form.tsx');
    expect(form).toContain('data-testid="create-workspace-back"');
    const service = read('packages/onboarding/src/workspace.ts');
    expect(service).toContain('city: cityFor(country, input.city),');
    expect(service).toContain(
      "if (!isEgyptCityCode(value)) throw new AppError('VALIDATION_FAILED'",
    );
  });

  it('says all of it in both languages', () => {
    for (const key of [
      'createWorkspace.back',
      'setup.brand.languagesRequired',
      'bb.origin.SETUP',
    ]) {
      expect(optionalMessage('en', key), key).toBeTruthy();
      expect(optionalMessage('ar', key), key).toMatch(/[؀-ۿ]/);
    }
  });
});

describe('Blocker 0 · an allowed update writes its own origin', () => {
  it('updateItem persists the effective origin; the version copies the updated row', () => {
    const knowledge = read('packages/brand-brain/src/knowledge.ts');
    const update = knowledge.slice(knowledge.indexOf('async updateItem('));
    const body = update.slice(0, update.indexOf('\n  }\n'));
    expect(body).toContain('origin: incomingOrigin,');
    expect(body.indexOf('if (!decision.allowed) throw humanPrecedenceViolation();')).toBeLessThan(
      body.indexOf('brandKnowledgeItem.update('),
    );
    expect(body).toMatch(/await this\.appendVersion\(updated,/);
    expect(knowledge).toMatch(/private async appendVersion[\s\S]*?origin: item\.origin,/);
  });

  it('HUMAN refuses SETUP and DOCUMENT; SETUP and DOCUMENT replace each other; HUMAN replaces both', () => {
    for (const lower of ['SETUP', 'DOCUMENT'] as const) {
      expect(mayOverwrite(subject('HUMAN'), subject(lower)).allowed, lower).toBe(false);
      expect(mayOverwrite(subject(lower), subject('HUMAN')).allowed, lower).toBe(true);
    }
    expect(mayOverwrite(subject('DOCUMENT'), subject('SETUP')).allowed).toBe(true);
    expect(mayOverwrite(subject('SETUP'), subject('DOCUMENT')).allowed).toBe(true);
  });
});
