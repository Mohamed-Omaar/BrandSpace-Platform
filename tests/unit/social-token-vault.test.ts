import { describe, expect, it } from 'vitest';
import {
  LocalDevelopmentKeyProvider,
  SOCIAL_TOKEN_DOMAIN,
  PLATFORM_SECRET_DOMAIN,
  createKeyProvider,
} from '@brandspace/vault';
import { SocialTokenVault, socialEncryptionContext } from '@brandspace/social-connectors';

/**
 * The customer token vault — the most valuable secret in this schema.
 *
 * WHAT A FAILURE HERE WOULD MEAN. A social access token is not a password
 * equivalent, it is better than one: it works without MFA, it does not expire
 * when the customer changes their password, and whoever holds it can publish to
 * the world as that brand. So these assertions are about the properties that
 * make a stolen DATABASE ROW useless on its own.
 *
 * NO REAL TOKEN AND NO REAL KEY APPEARS HERE. The KEK below is visibly fake and
 * protects nothing.
 */

const KEK = 'unit-test-social-token-kek-0000000000000000';
const provider = new LocalDevelopmentKeyProvider(KEK);
const vault = new SocialTokenVault({ keyProvider: provider });

const ROW = { workspaceId: 'ws-1', socialConnectionId: 'conn-1', version: 1 };

describe('sealing and opening a token pair', () => {
  it('round-trips both halves', async () => {
    const sealed = await vault.seal({
      ...ROW,
      material: { accessToken: 'access-value', refreshToken: 'refresh-value' },
    });
    const opened = await vault.open(sealed);
    expect(opened.accessToken).toBe('access-value');
    expect(opened.refreshToken).toBe('refresh-value');
  });

  it('carries a null refresh token as null, not as the string "null"', async () => {
    const sealed = await vault.seal({
      ...ROW,
      material: { accessToken: 'access-value', refreshToken: null },
    });
    expect((await vault.open(sealed)).refreshToken).toBeNull();
  });

  it('THE CIPHERTEXT DOES NOT CONTAIN THE TOKEN', async () => {
    const sealed = await vault.seal({
      ...ROW,
      material: { accessToken: 'super-secret-access', refreshToken: 'super-secret-refresh' },
    });
    const serialized = JSON.stringify(sealed);
    expect(serialized).not.toContain('super-secret-access');
    expect(serialized).not.toContain('super-secret-refresh');
  });

  it('THE MASK IS A MASK — at most a few trailing characters', async () => {
    const sealed = await vault.seal({
      ...ROW,
      material: { accessToken: 'a'.repeat(200), refreshToken: null },
    });
    expect(sealed.maskedHint.length).toBeLessThanOrEqual(8);
    expect(sealed.maskedHint).not.toContain('aaaaaaaaaa');
  });

  it('two seals of the same token differ — the IV is fresh every time', async () => {
    const first = await vault.seal({
      ...ROW,
      material: { accessToken: 'same-token', refreshToken: null },
    });
    const second = await vault.seal({
      ...ROW,
      material: { accessToken: 'same-token', refreshToken: null },
    });
    expect(first.ciphertext).not.toBe(second.ciphertext);
    // …but the FINGERPRINT matches, which is what makes "is this the same
    // token I already stored?" answerable without decrypting either.
    expect(first.fingerprint).toBe(second.fingerprint);
  });
});

describe('the encryption context binds a credential to exactly one row', () => {
  it('names the workspace, the connection and the version', () => {
    const context = socialEncryptionContext(ROW);
    expect(context).toContain('ws-1');
    expect(context).toContain('conn-1');
    expect(context).toContain(':1');
  });

  it('A CREDENTIAL MOVED TO ANOTHER CONNECTION FAILS TO DECRYPT', async () => {
    /*
     * The AAD at work. Without it, copying one row's ciphertext onto another
     * connection would yield a working token for an account that did not
     * authorize it — inside the same workspace, and therefore past RLS.
     */
    const sealed = await vault.seal({
      ...ROW,
      material: { accessToken: 'bound-token', refreshToken: null },
    });
    const moved = {
      ...sealed,
      encryptionContext: socialEncryptionContext({ ...ROW, socialConnectionId: 'conn-2' }),
    };
    await expect(vault.open(moved)).rejects.toThrow();
  });

  it('A CREDENTIAL MOVED TO ANOTHER WORKSPACE FAILS TO DECRYPT', async () => {
    const sealed = await vault.seal({
      ...ROW,
      material: { accessToken: 'bound-token', refreshToken: null },
    });
    const moved = {
      ...sealed,
      encryptionContext: socialEncryptionContext({ ...ROW, workspaceId: 'ws-2' }),
    };
    await expect(vault.open(moved)).rejects.toThrow();
  });

  it('a tampered ciphertext fails rather than decrypting to something else', async () => {
    const sealed = await vault.seal({
      ...ROW,
      material: { accessToken: 'bound-token', refreshToken: null },
    });
    const tampered = { ...sealed, ciphertext: Buffer.from('tampered').toString('base64') };
    await expect(vault.open(tampered)).rejects.toThrow();
  });
});

describe('THE KEY DOMAINS ARE SEPARATE, AND THAT IS THE WHOLE POINT (D-136)', () => {
  it('a platform KEK cannot open a social credential', async () => {
    /*
     * The threat this closes: the publish worker holds the social KEK and has
     * database access. If both domains shared a key, that worker could unwrap
     * every platform provider credential in the database — the exact reach F-07
     * exists to deny it.
     */
    const sealed = await vault.seal({
      ...ROW,
      material: { accessToken: 'social-token', refreshToken: null },
    });
    const platformProvider = new LocalDevelopmentKeyProvider(
      'a-different-platform-kek-000000000000',
    );
    const otherVault = new SocialTokenVault({ keyProvider: platformProvider });
    await expect(otherVault.open(sealed)).rejects.toThrow();
  });

  it('the two domains read DIFFERENT environment variables', () => {
    expect(SOCIAL_TOKEN_DOMAIN.kekVar).toBe('SOCIAL_TOKEN_VAULT_KEK');
    expect(PLATFORM_SECRET_DOMAIN.kekVar).toBe('SECRET_VAULT_KEK');
    expect(SOCIAL_TOKEN_DOMAIN.kekVar).not.toBe(PLATFORM_SECRET_DOMAIN.kekVar);
    expect(SOCIAL_TOKEN_DOMAIN.kmsVar).not.toBe(PLATFORM_SECRET_DOMAIN.kmsVar);
  });

  it('IT FAILS CLOSED — no social KEK means no vault, not an unprotected one', () => {
    expect(() => createKeyProvider({} as NodeJS.ProcessEnv, SOCIAL_TOKEN_DOMAIN)).toThrow(
      /SOCIAL_TOKEN_VAULT_KEK/,
    );
  });

  it('the local provider is refused in production, for the social domain too', () => {
    expect(() =>
      createKeyProvider(
        { NODE_ENV: 'production', SOCIAL_TOKEN_VAULT_KEK: KEK } as NodeJS.ProcessEnv,
        SOCIAL_TOKEN_DOMAIN,
      ),
    ).toThrow(/SOCIAL_TOKEN_VAULT_KMS_KEY_ARN/);
  });

  it('the PLATFORM domain still behaves exactly as it did before the split', () => {
    // The refactor that created `@brandspace/vault` must not have changed what
    // the Secret Service does; this is the regression guard for that.
    expect(() => createKeyProvider({} as NodeJS.ProcessEnv)).toThrow(/SECRET_VAULT_KEK/);
  });
});

describe('the PKCE verifier', () => {
  it('round-trips, and is bound to its state', async () => {
    const sealed = await vault.sealVerifier({
      workspaceId: 'ws-1',
      stateHash: 'hash-1',
      verifier: 'the-verifier-value',
    });
    expect(await vault.openVerifier(sealed)).toBe('the-verifier-value');
    expect(JSON.stringify(sealed)).not.toContain('the-verifier-value');

    const moved = {
      ...sealed,
      encryptionContext: 'brandspace:social-pkce:v1:ws-1:hash-2',
    };
    await expect(vault.openVerifier(moved)).rejects.toThrow();
  });
});

describe('a malformed stored credential is refused rather than half-read', () => {
  it('rejects material that decrypts to something that is not a token pair', async () => {
    const sealed = await vault.seal({
      ...ROW,
      material: { accessToken: 'ok', refreshToken: null },
    });
    // Seal a NON-token payload under the same context, so it decrypts cleanly
    // and is still refused by the shape check.
    const bogus = await vault.sealVerifier({
      workspaceId: 'x',
      stateHash: 'y',
      verifier: 'not-json-at-all',
    });
    await expect(
      vault.open({ ...bogus, encryptionContext: bogus.encryptionContext }),
    ).rejects.toThrow();
    expect((await vault.open(sealed)).accessToken).toBe('ok');
  });
});
