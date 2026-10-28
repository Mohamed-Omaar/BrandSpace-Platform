import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  LocalDevelopmentKeyProvider,
  PLATFORM_SECRET_DOMAIN,
  RotatingKeyProvider,
  createKeyProvider,
  decryptSecret,
  encryptSecret,
} from '@brandspace/vault';

/**
 * D-574 — A KEK ROTATION WITHOUT DOWNTIME. While `<KEK>_PREVIOUS` is set, a
 * service seals with the new key and opens with either; with it gone, only the
 * new key works. The re-wrap itself runs against PostgreSQL in
 * `tests/isolation/kek-rewrap.test.ts`.
 */

const key = () => randomBytes(36).toString('base64');
const env = (vars: Record<string, string>) => ({ APP_ENV: 'development', ...vars });

describe('D-574 · a service mid-rotation', () => {
  it('reads secrets sealed with either key and seals new ones with the new key', async () => {
    const oldKey = key();
    const newKey = key();
    const before = await encryptSecret(
      'value-sealed-before-0000',
      'ctx:1',
      new LocalDevelopmentKeyProvider(oldKey),
    );

    const rotating = createKeyProvider(
      env({ SECRET_VAULT_KEK: newKey, SECRET_VAULT_KEK_PREVIOUS: oldKey }),
      PLATFORM_SECRET_DOMAIN,
    );
    expect(rotating).toBeInstanceOf(RotatingKeyProvider);
    await expect(decryptSecret(before, rotating)).resolves.toBe('value-sealed-before-0000');

    const after = await encryptSecret('value-sealed-during-0000', 'ctx:2', rotating);
    await expect(decryptSecret(after, new LocalDevelopmentKeyProvider(newKey))).resolves.toBe(
      'value-sealed-during-0000',
    );
    await expect(decryptSecret(after, new LocalDevelopmentKeyProvider(oldKey))).rejects.toThrow();
  });

  it('without the previous key, only the current one opens anything', async () => {
    const oldKey = key();
    const before = await encryptSecret(
      'value-sealed-before-0000',
      'ctx:1',
      new LocalDevelopmentKeyProvider(oldKey),
    );
    const current = createKeyProvider(env({ SECRET_VAULT_KEK: key() }), PLATFORM_SECRET_DOMAIN);
    expect(current).toBeInstanceOf(LocalDevelopmentKeyProvider);
    await expect(decryptSecret(before, current)).rejects.toThrow();
  });

  it('refuses a previous key equal to the current one, without showing either', () => {
    const same = key();
    let message = '';
    try {
      createKeyProvider(
        env({ SECRET_VAULT_KEK: same, SECRET_VAULT_KEK_PREVIOUS: same }),
        PLATFORM_SECRET_DOMAIN,
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/SECRET_VAULT_KEK_PREVIOUS is the same as SECRET_VAULT_KEK/);
    expect(message).not.toContain(same);
  });
});
