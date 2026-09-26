import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLE_DEFINITIONS, isOwnerOnlyPermission } from '@brandspace/shared';
import { optionalMessage } from '../../apps/dashboard/src/i18n/messages';

/**
 * G4 / Q23 (prototype v94 Phase 2B-1, D-333) — two-step verification, as
 * rules on the source. The behaviour against PostgreSQL is
 * `tests/isolation/phase2b1-mfa.test.ts`; the flow in a browser is the Phase
 * 2B-1 E2E spec.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const ACTIONS = 'apps/dashboard/src/app/[locale]/settings/security/actions.ts';
const PAGE = 'apps/dashboard/src/app/[locale]/settings/security/page.tsx';

describe('G4 · no seed and no recovery code in a URL', () => {
  it('the actions put neither the otpauth URI nor the codes in a redirect', () => {
    const actions = read(ACTIONS);
    expect(actions).not.toMatch(/otpauth:/);
    expect(actions).not.toMatch(/codes: [a-zA-Z.]+\.join\(' '\)\s*[,}]/);
    expect(read(PAGE)).not.toMatch(/query\['(otpauth|codes)'\]/);
  });

  it('the codes ride a short-lived httpOnly, same-site cookie that "I have saved them" deletes', () => {
    const actions = read(ACTIONS);
    expect(actions).toMatch(
      /store\.set\(RECOVERY_CODES_COOKIE, codes\.join\(' '\), \{\s*httpOnly: true,\s*secure: true,\s*sameSite: 'strict',\s*path: '\/',\s*maxAge: 300,/,
    );
    expect(actions).toContain('(await cookies()).delete(RECOVERY_CODES_COOKIE);');
  });

  it('the QR code is drawn from the server-held enrolment, with the key to type beside it', () => {
    const panel = read('apps/dashboard/src/components/mfa-enrolment.tsx');
    expect(panel).toContain('await QRCode.toDataURL(otpauthUri');
    expect(panel).toMatch(/data-testid=\{`\$\{testId\}-key`\}/);
    expect(panel).not.toContain('dangerouslySetInnerHTML');
    expect(read(PAGE)).toContain('await signup.pendingEnrolment(customer.userId)');
  });
});

describe('G4 · turning it off, and "New phone", go through the counted step-up', () => {
  it('every proof-taking action uses withStepUp', () => {
    const actions = read(ACTIONS);
    for (const name of [
      'disableMfaAction',
      'regenerateRecoveryCodesAction',
      'beginNewPhoneAction',
      'confirmNewPhoneAction',
    ]) {
      const body = actions.slice(actions.indexOf(`export async function ${name}`));
      expect(body.slice(0, body.indexOf('\n}\n')), name).toContain('await withStepUp(');
    }
  });

  it('turning off accepts a code or the password, and is refused while a workspace requires it', () => {
    const actions = read(ACTIONS);
    expect(actions).toContain("code !== '' ? { code } : { password }");
    const disable = actions.slice(actions.indexOf('export async function disableMfaAction'));
    expect(disable.indexOf("reason: 'MFA_REQUIRED_BY_WORKSPACE'")).toBeLessThan(
      disable.indexOf('await withStepUp('),
    );
    const api = read('apps/api/src/routes/account.ts');
    expect(api).toContain("reason: 'MFA_REQUIRED_BY_WORKSPACE'");
  });
});

describe('G4 · the workspace requirement', () => {
  it('workspace.security.manage is the Owner’s alone, and on the Admin’s deny list', () => {
    expect(isOwnerOnlyPermission('workspace.security.manage')).toBe(true);
    const owner = ROLE_DEFINITIONS.find((role) => role.key === 'workspace_owner');
    const admin = ROLE_DEFINITIONS.find((role) => role.key === 'workspace_admin');
    expect(owner?.permissionKeys).toContain('workspace.security.manage');
    expect(admin?.permissionKeys).not.toContain('workspace.security.manage');
    expect(read('packages/shared/src/roles.ts')).toContain("k !== 'workspace.security.manage'");
  });

  it('every workspace page and action sends a member without it to set it up first', () => {
    const context = read('apps/dashboard/src/server/customer-context.ts');
    expect(context).toContain(
      'if (workspace.requireMfa && !customer.mfaEnabled) redirect(`/${locale}/mfa-setup`);',
    );
    // The gate asks for the workspace explicitly; everything else fails closed.
    expect(context).toMatch(
      /\.listWorkspaces\(token, \{ includePendingDeletion: true, includeMfaRequired: true \}\)/,
    );
    const setup = read('apps/dashboard/src/app/[locale]/mfa-setup/page.tsx');
    expect(setup).toContain('await requireCustomer(locale)');
    expect(setup).not.toMatch(/requireWorkspace(Page|Action)?\(/);
  });

  it('the auth service leaves such a workspace out unless asked', () => {
    const service = read('packages/auth/src/customer-session.ts');
    expect(service).toMatch(
      /options\.includeMfaRequired === true \|\| hasMfa \|\| !m\.workspace\.requireMfa/,
    );
  });

  it('says all of it in both languages', () => {
    for (const key of [
      'security.qrAlt',
      'security.typeKey',
      'security.newPhone',
      'security.newPhoneExplain',
      'security.orPassword',
      'security.requireLabel',
      'security.requiredCannotDisable',
      'mfaSetup.title',
      'mfaSetup.body',
    ]) {
      expect(optionalMessage('en', key), key).toBeTruthy();
      expect(optionalMessage('ar', key), key).toMatch(/[؀-ۿ]/);
    }
  });
});
