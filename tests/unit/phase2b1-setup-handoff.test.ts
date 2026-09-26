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

  it('the Review step decides SETUP from the closed-set return path, not from a field', () => {
    const actions = read('apps/dashboard/src/app/[locale]/brand-brain/actions.ts');
    expect(actions).toContain("acceptedInSetup: back.path === '/onboarding',");
    expect(actions).not.toMatch(/formData\.get\('origin'\)/);
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
    // Chosen again in setup — also over a goal written before SETUP existed.
    expect(
      storedGoal({ title: { en: 'x' }, origin: 'HUMAN', versions: latest('setup'), brand: key }),
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
    // A HUMAN row's first version was a person, not setup.
    expect(storedGoal({ title, origin: 'HUMAN', versions: latest('created'), brand: key })).toBe(
      'TRAFFIC',
    );
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

  it('every reader asks through the one select and the one decoder', () => {
    for (const file of [
      'apps/dashboard/src/server/setup-wizard.ts',
      'apps/dashboard/src/app/[locale]/strategy/page.tsx',
      'apps/dashboard/src/app/[locale]/content/compose/page.tsx',
    ]) {
      const source = read(file);
      expect(source, file).toContain('GOAL_ITEM_SELECT');
      expect(source, file).toContain('storedGoal(');
      expect(source, file).not.toContain('goalFromTitle(');
    }
  });

  it('the goal is written as SETUP, and choosing it again is a version setup signs', () => {
    const save = read('apps/dashboard/src/server/setup-goal.ts');
    expect(save).toContain("origin: 'SETUP',");
    expect(save).toContain("incomingOrigin: existing.origin === 'HUMAN' ? 'HUMAN' : 'SETUP',");
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
    const page = read('apps/dashboard/src/app/[locale]/onboarding/workspace/page.tsx');
    expect(page).toContain('data-testid="create-workspace-back"');
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
