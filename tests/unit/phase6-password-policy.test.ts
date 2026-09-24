import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ABSOLUTE_MAX_PASSWORD_LENGTH, ABSOLUTE_MIN_PASSWORD_LENGTH } from '@brandspace/shared';
import { hashPassword, verifyPassword } from '@brandspace/auth';
import { CONFIG_DOMAINS } from '@brandspace/config';

/**
 * PHASE 6 · P6-03a — THE PASSWORD MINIMUM IS CONFIGURATION, AND ONE NUMBER.
 *
 * The owner asked for the customer floor to come down from 12 to 8 while the
 * hashing and the server-side validation stayed exactly as strong. The reason
 * the change was more than editing a literal is that the literal appeared FIVE
 * times, in four of which it was invisible to configuration:
 *
 *   packages/auth/src/password.ts            `plaintext.length < 12`
 *   (auth)/actions.ts  ×2                    `password.length < 12`
 *   reset/[token]/page.tsx                   `minLength={12}`
 *   invitations/[token]/page.tsx             `minLength={12}`
 *
 * and once, on the sign-up page alone, as the configured value. So an operator
 * lowering `onboarding.signup.minPasswordLength` changed ONE of the five
 * screens, and lowering it below the domain's own hard-coded floor produced a
 * form that accepted a password the domain then refused to hash — which
 * presents to the customer as the site being broken, on the single screen where
 * they have the least patience for it.
 *
 * WHAT THIS FILE PINS:
 *
 *   - the floor is 8 and the two consumers of it cannot drift;
 *   - the configuration schema cannot be set below the floor or above the
 *     ceiling, and its DEFAULT is the floor;
 *   - `hashPassword` refuses below the floor and above the ceiling;
 *   - a passphrase with spaces is valid and round-trips;
 *   - NO source file compares a password length against a literal any more;
 *   - Platform Admin's rules are untouched.
 */

describe('P6-03a · the floor is one number, shared', () => {
  it('is 8, which is what the owner asked for', () => {
    expect(ABSOLUTE_MIN_PASSWORD_LENGTH).toBe(8);
  });

  it('bounds the configuration schema at both ends, and defaults to the floor', () => {
    const schema = CONFIG_DOMAINS['onboarding'];
    expect(schema, 'the onboarding domain is not registered').toBeDefined();

    // The DEFAULT is the floor: the owner's instruction is that the minimum is
    // 8, so an environment nobody has configured is already at 8 rather than
    // silently keeping the old 12.
    const parsed = schema?.schema.parse({}) as {
      signup: { minPasswordLength: number };
    };
    expect(parsed.signup.minPasswordLength).toBe(ABSOLUTE_MIN_PASSWORD_LENGTH);

    // Below the floor is refused rather than clamped. A silently-raised value
    // is a configuration screen that lies about what it saved.
    expect(() =>
      schema?.schema.parse({ signup: { minPasswordLength: ABSOLUTE_MIN_PASSWORD_LENGTH - 1 } }),
    ).toThrow();
    expect(() =>
      schema?.schema.parse({ signup: { minPasswordLength: ABSOLUTE_MAX_PASSWORD_LENGTH + 1 } }),
    ).toThrow();

    // And an operator may still set anything in between — the NUMBER is theirs
    // (CLAUDE.md §2.2); only the bounds are code.
    const raised = schema?.schema.parse({ signup: { minPasswordLength: 20 } }) as {
      signup: { minPasswordLength: number };
    };
    expect(raised.signup.minPasswordLength).toBe(20);
  });
});

describe('P6-03a · hashing enforces the floor and nothing weaker', () => {
  it('refuses a password below the floor', async () => {
    await expect(hashPassword('a'.repeat(ABSOLUTE_MIN_PASSWORD_LENGTH - 1))).rejects.toThrow();
  });

  it('accepts one exactly at the floor', async () => {
    const hashed = await hashPassword('a'.repeat(ABSOLUTE_MIN_PASSWORD_LENGTH));
    expect(hashed.startsWith('$argon2id$')).toBe(true);
  });

  it('refuses one above the ceiling, so a login cannot be made expensive', async () => {
    // Argon2id hashes whatever it is given. Unbounded input on an unauthenticated
    // endpoint is a cheap way to spend the server's memory budget.
    await expect(hashPassword('a'.repeat(ABSOLUTE_MAX_PASSWORD_LENGTH + 1))).rejects.toThrow();
  });

  it('accepts a passphrase with spaces, and it round-trips', async () => {
    // The whole point of lowering a length floor is that memorable passphrases
    // become expressible. One that hashes but does not verify would be worse
    // than refusing it.
    const passphrase = 'correct horse battery staple';
    const hashed = await hashPassword(passphrase);
    expect(await verifyPassword(hashed, passphrase)).toBe(true);
    expect(await verifyPassword(hashed, 'correct horse battery stapler')).toBe(false);
  });

  it('still uses Argon2id — the floor moved, the hashing did not', async () => {
    const hashed = await hashPassword('a passphrase with spaces');
    expect(hashed).toContain('$argon2id$');
    expect(hashed).toContain('m=19456');
    expect(hashed).toContain('t=2');
    expect(hashed).toContain('p=1');
  });
});

/**
 * Every source file, so a literal cannot come back in a file nobody listed.
 */
function sourceFiles(dir: string, extensions: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path, extensions));
    else if (extensions.some((extension) => entry.endsWith(extension))) out.push(path);
  }
  return out;
}

describe('P6-03a · no source compares a password length against a literal', () => {
  it('finds no hard-coded minimum anywhere in the customer auth path', () => {
    /*
     * The shape of the defect, rather than the number 12: writing `< 8` instead
     * would be the same mistake with a friendlier value, and would pass a test
     * that only looked for twelve.
     *
     * Comments are blanked first, for the reason
     * `phase6-control-consistency.test.ts` records — prose about the old rule is
     * not the old rule.
     */
    const pattern = /(password|plaintext)[\w.]*\.length\s*[<>]=?\s*\d+/gi;
    const offenders: string[] = [];

    for (const root of ['apps/dashboard/src', 'packages/auth/src', 'packages/onboarding/src']) {
      for (const file of sourceFiles(root, ['.ts', '.tsx'])) {
        const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (block) =>
          block.replace(/[^\n]/g, ' '),
        );
        for (const match of source.matchAll(pattern)) {
          const line = source.slice(0, match.index).split('\n').length;
          offenders.push(`${file}:${line}  ${match[0]}`);
        }
      }
    }

    expect(
      offenders,
      `A password length is compared against a literal. The minimum is ` +
        `configuration (onboarding.signup.minPasswordLength) and the absolute ` +
        `floor is ABSOLUTE_MIN_PASSWORD_LENGTH:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('no screen writes minLength={12} — or any other literal — on a password', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles('apps/dashboard/src', ['.tsx'])) {
      const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (block) =>
        block.replace(/[^\n]/g, ' '),
      );
      // A password control, then a literal minLength within the same tag.
      for (const match of source.matchAll(/type="password"[^>]*minLength=\{\d+\}/g)) {
        offenders.push(`${file}:${source.slice(0, match.index).split('\n').length}`);
      }
      for (const match of source.matchAll(/minLength=\{\d+\}[^>]*type="password"/g)) {
        offenders.push(`${file}:${source.slice(0, match.index).split('\n').length}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('P6-03a · the confirmation is never trusted by the server', () => {
  it('no server action reads a confirmation field from the form data', () => {
    /*
     * THE PROPERTY THAT MATTERS MOST HERE. A confirmed password is a courtesy
     * to somebody who might have mistyped; it is not evidence of anything,
     * because the client sends both values and can send whatever it likes. An
     * action that read `confirmPassword` and compared it would be checking the
     * caller's input against the caller's input.
     *
     * The component does not even submit the field — it is deliberately
     * unnamed — so this asserts the other half: that nothing on the server has
     * started expecting it.
     */
    const offenders: string[] = [];
    for (const file of sourceFiles('apps/dashboard/src', ['.ts', '.tsx'])) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(
        /formData\.get\(\s*['"](confirm\w*|\w*[Cc]onfirm)['"]/g,
      )) {
        offenders.push(`${file}:${source.slice(0, match.index).split('\n').length}  ${match[0]}`);
      }
    }
    expect(
      offenders,
      `A server action is reading a password confirmation. The server validates ` +
        `the password itself; a client-side match proves nothing:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the shared control does not submit the confirmation at all', () => {
    const component = readFileSync('packages/ui/src/password-field.tsx', 'utf8');
    // The confirm input carries no `name`, so it is not in the form data. The
    // password input does.
    const confirmBlock = component.slice(component.indexOf('id={confirmId}'));
    const confirmTag = confirmBlock.slice(0, confirmBlock.indexOf('/>'));
    expect(confirmTag).not.toMatch(/\sname=/);
  });
});

describe('P6-03a · Platform Admin is untouched', () => {
  it('the platform owner bootstraps keep their OWN, stricter floors', () => {
    /*
     * A PLATFORM OWNER IS NOT A CUSTOMER, and D-261 lowered the CUSTOMER floor.
     *
     * These create the account that can reach every tenant's data, behind
     * mandatory MFA (D-27). Both already carry their own explicit minimum —
     * 16 for production, 12 for staging — so neither was ever relying on
     * `hashPassword`'s floor and neither moved when that floor did. Pinned
     * here because the natural next step for somebody tidying up after D-261
     * is to "make them consistent", which would weaken the one account the
     * brief says must not weaken.
     *
     * The literal-scanning guard above deliberately does NOT reach these files;
     * this is what keeps them honest instead.
     */
    const guards = readFileSync('packages/database/prisma/bootstrap-owner-guards.ts', 'utf8');
    const production = guards.match(/MIN_OWNER_PASSWORD_LENGTH\s*=\s*(\d+)/);
    expect(production, 'the production owner floor is gone entirely').not.toBeNull();
    expect(
      Number(production?.[1]),
      'the production Platform Owner floor must stay above the customer floor',
    ).toBeGreaterThanOrEqual(16);

    const staging = readFileSync('packages/database/prisma/bootstrap-staging-owner.ts', 'utf8');
    const stagingFloor = staging.match(/password\.length\s*<\s*(\d+)/);
    expect(stagingFloor, 'the staging owner floor is gone entirely').not.toBeNull();
    expect(Number(stagingFloor?.[1])).toBeGreaterThanOrEqual(12);

    // And both are strictly above what a customer may use, which is the
    // property that actually matters.
    expect(Number(production?.[1])).toBeGreaterThan(ABSOLUTE_MIN_PASSWORD_LENGTH);
    expect(Number(stagingFloor?.[1])).toBeGreaterThan(ABSOLUTE_MIN_PASSWORD_LENGTH);
  });

  it('no platform auth path reads the customer signup policy', () => {
    // The brief is explicit that Platform Admin MFA and security rules do not
    // weaken. The customer floor lives in the `onboarding` domain, which the
    // admin application has no reason to read.
    const offenders: string[] = [];
    for (const file of sourceFiles('apps/admin/src', ['.ts', '.tsx'])) {
      const source = readFileSync(file, 'utf8');
      if (source.includes('minPasswordLength')) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
