import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  LocalDevelopmentKeyProvider,
  REWRAP_AUDIT_ACTIONS,
  RotatingKeyProvider,
  decryptSecret,
  encryptSecret,
  rewrapKeyDomain,
  type RewrapDomain,
} from '@brandspace/secrets';
import { runRewrapCommand } from '../../apps/api/src/scripts/rewrap-kek';
import { dropThrowawayDatabase } from './fixtures';

/**
 * D-574 — THE KEK RE-WRAP, AGAINST A DATABASE NOBODY ELSE TOUCHED.
 *
 * A re-wrap reads EVERY envelope of a key domain. The shared test database holds
 * envelopes other suites sealed under keys this suite does not know, and the
 * command rightly refuses a table it cannot fully open. So this suite migrates
 * its own database, seeds envelopes in all three key domains (platform secrets,
 * customers' social tokens, customers' MFA seeds), and runs the real command.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../../packages/database/prisma/migrations');

function urlFor(role: 'migrator' | 'platform', database: string): string {
  const source =
    role === 'migrator'
      ? process.env['DATABASE_MIGRATION_URL']
      : process.env['DATABASE_PLATFORM_URL'];
  if (!source) throw new Error(`the ${role} connection URL is required for this suite`);
  const url = new URL(source);
  url.pathname = `/${database}`;
  return url.toString();
}

function libpqUrl(url: string): string {
  const parsed = new URL(url);
  parsed.search = '';
  return parsed.toString();
}

const key = () => randomBytes(36).toString('base64');
const OLD = key();
const NEW = key();
const NEWER = key();
const WRONG = key();

const database = `brandspace_rewrap_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
let admin: Client;
let prisma: PrismaClient;
let actorId: string;
let actorEmail: string;

/** The plaintexts this suite sealed, per domain — to prove a round trip, and to look for leaks. */
const sealed: Record<RewrapDomain, string[]> = { platform: [], social: [], customerMfa: [] };
const printed: string[] = [];
const provider = (value: string) => new LocalDevelopmentKeyProvider(value);

async function seed(): Promise<void> {
  const old = provider(OLD);
  const role = await prisma.role.create({
    data: { key: 'platform_owner', realm: 'PLATFORM', nameEn: 'Owner', nameAr: 'المالك' },
  });
  actorEmail = `rewrap-${randomUUID()}@example.local`;
  const actor = await prisma.platformUser.create({
    data: { email: actorEmail, roleId: role.id, status: 'ACTIVE' },
  });
  actorId = actor.id;

  // PLATFORM: three secrets, one with two versions.
  for (let i = 0; i < 3; i += 1) {
    const record = await prisma.secretRecord.create({
      data: {
        ref: `test/rewrap/${i}`,
        environment: 'DEVELOPMENT',
        category: 'ai_provider',
        name: `rewrap ${i}`,
        createdByPlatformUserId: actor.id,
      },
    });
    for (let version = 1; version <= (i === 0 ? 2 : 1); version += 1) {
      const value = `platform-value-${randomUUID()}`;
      sealed.platform.push(value);
      const material = await encryptSecret(
        value,
        `brandspace:secret:v1:test/rewrap/${i}:DEVELOPMENT:${version}`,
        old,
      );
      await prisma.secretVersion.create({
        data: {
          secretRecordId: record.id,
          version,
          ...material,
          createdByPlatformUserId: actor.id,
        },
      });
    }
  }

  // SOCIAL: two credentials on one connection.
  const owner = await prisma.user.create({
    data: {
      email: `rewrap-owner-${randomUUID()}@example.local`,
      timezone: 'UTC',
      status: 'ACTIVE',
    },
  });
  const workspaceId = randomUUID();
  await prisma.workspace.create({
    data: {
      id: workspaceId,
      workspaceId,
      slug: `rewrap-${workspaceId.slice(0, 8)}`,
      name: 'Rewrap',
      country: 'US',
      defaultLocale: 'EN',
      timezone: 'UTC',
      currency: 'USD',
      ownerUserId: owner.id,
      status: 'ACTIVE',
    },
  });
  const brand = await prisma.brand.create({
    data: { workspaceId, slug: 'rewrap', name: 'Rewrap' },
  });
  const connection = await prisma.socialConnection.create({
    data: {
      workspaceId,
      brandId: brand.id,
      provider: 'FACEBOOK',
      externalAccountId: `acct-${randomUUID()}`,
      displayName: 'Rewrap page',
      targetKind: 'page',
    },
  });
  for (let version = 1; version <= 2; version += 1) {
    const value = `social-token-${randomUUID()}`;
    sealed.social.push(value);
    const material = await encryptSecret(
      value,
      `brandspace:social:v1:${connection.id}:${version}`,
      old,
    );
    await prisma.socialCredential.create({
      data: {
        workspaceId,
        socialConnectionId: connection.id,
        version,
        ...material,
        // One live credential per connection; the earlier version is retired, and still re-wrapped.
        ...(version === 1 ? { retiredAt: new Date() } : {}),
      },
    });
  }

  // CUSTOMER MFA: one live seed, one live + pending.
  for (const withPending of [false, true]) {
    const userId = randomUUID();
    const live = `MFA${randomBytes(10).toString('hex').toUpperCase()}`;
    sealed.customerMfa.push(live);
    const liveMaterial = await encryptSecret(live, `brandspace:customer-mfa:v1:${userId}`, old);
    let pendingMaterial: unknown = undefined;
    if (withPending) {
      const pending = `MFA${randomBytes(10).toString('hex').toUpperCase()}`;
      sealed.customerMfa.push(pending);
      pendingMaterial = await encryptSecret(pending, `brandspace:customer-mfa:v1:${userId}`, old);
    }
    await prisma.user.create({
      data: {
        id: userId,
        email: `rewrap-mfa-${userId}@example.local`,
        timezone: 'UTC',
        status: 'ACTIVE',
        mfaSecretMaterial: liveMaterial as never,
        ...(pendingMaterial ? { mfaPendingSecretMaterial: pendingMaterial as never } : {}),
      },
    });
  }
}

beforeAll(async () => {
  admin = new Client({ connectionString: libpqUrl(urlFor('migrator', 'postgres')) });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  const names = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    execFileSync(
      'psql',
      [
        '-v',
        'ON_ERROR_STOP=1',
        '--quiet',
        '--no-psqlrc',
        '-f',
        path.join(migrationsDir, name, 'migration.sql'),
        libpqUrl(urlFor('migrator', database)),
      ],
      { stdio: 'pipe', encoding: 'utf8' },
    );
  }
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: urlFor('platform', database) }),
  });
  await seed();

  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    vi.spyOn(stream, 'write').mockImplementation(((
      chunk: string | Uint8Array,
      ...rest: never[]
    ) => {
      printed.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return original(chunk, ...rest);
    }) as typeof stream.write);
  }
}, 300_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma?.$disconnect();
  if (admin) {
    await dropThrowawayDatabase(admin, database);
    await admin.end();
  }
});

type Envelope = Awaited<ReturnType<typeof encryptSecret>>;

/** Every envelope of a domain, as the store holds it. */
async function envelopes(domain: RewrapDomain): Promise<Envelope[]> {
  if (domain === 'platform') {
    return (await prisma.secretVersion.findMany({
      orderBy: { id: 'asc' },
    })) as unknown as Envelope[];
  }
  if (domain === 'social') {
    return (await prisma.socialCredential.findMany({
      orderBy: { id: 'asc' },
    })) as unknown as Envelope[];
  }
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { mfaSecretMaterial: { not: Prisma.DbNull } },
        { mfaPendingSecretMaterial: { not: Prisma.DbNull } },
      ],
    },
    select: { mfaSecretMaterial: true, mfaPendingSecretMaterial: true },
    orderBy: { id: 'asc' },
  });
  return users
    .flatMap((u) => [u.mfaSecretMaterial, u.mfaPendingSecretMaterial])
    .filter(
      (m): m is NonNullable<typeof m> => m !== null && typeof m === 'object',
    ) as unknown as Envelope[];
}

async function plaintexts(domain: RewrapDomain, with_: string): Promise<string[]> {
  const out: string[] = [];
  for (const envelope of await envelopes(domain)) {
    out.push(await decryptSecret(envelope, provider(with_)));
  }
  return out.sort();
}

function run(
  domain: RewrapDomain,
  oldKey: string,
  newKey: string,
  extra: string[] = [],
  afterEach?: (n: number) => void,
) {
  return rewrapKeyDomain({
    prisma: prisma as never,
    domain,
    oldKek: provider(oldKey),
    newKek: provider(newKey),
    dryRun: extra.includes('--dry-run'),
    actorPlatformUserId: actorId,
    ...(afterEach ? { afterEach } : {}),
  });
}

const DOMAINS: readonly RewrapDomain[] = ['platform', 'social', 'customerMfa'];

describe.each(DOMAINS)('D-574 · re-wrapping the %s key domain', (domain) => {
  it('a dry run counts and changes nothing', async () => {
    const before = await envelopes(domain);
    const report = await run(domain, OLD, NEW, ['--dry-run']);
    expect(report).toMatchObject({
      dryRun: true,
      total: before.length,
      alreadyDone: 0,
      rewrapped: before.length,
      failed: 0,
      stoppedBeforeWriting: false,
    });
    expect(await envelopes(domain)).toEqual(before);
  });

  it('a wrong old key is refused before anything is written', async () => {
    const before = await envelopes(domain);
    const report = await run(domain, WRONG, NEW);
    expect(report.stoppedBeforeWriting).toBe(true);
    expect(report.failed).toBe(before.length);
    expect(report.rewrapped).toBe(0);
    expect(await envelopes(domain)).toEqual(before);
  });

  it('round trip: every data key moves to the new key; the values and their ciphertext do not change', async () => {
    const before = await envelopes(domain);
    const report = await run(domain, OLD, NEW);
    expect(report).toMatchObject({
      total: before.length,
      alreadyDone: 0,
      rewrapped: before.length,
      failed: 0,
      verified: before.length,
    });
    const after = await envelopes(domain);
    for (const [i, envelope] of after.entries()) {
      expect(envelope.ciphertext).toBe(before[i]?.ciphertext);
      expect(envelope.iv).toBe(before[i]?.iv);
      expect(envelope.authTag).toBe(before[i]?.authTag);
      expect(envelope.encryptionContext).toBe(before[i]?.encryptionContext);
      expect(envelope.wrappedDataKey).not.toBe(before[i]?.wrappedDataKey);
    }
    expect(await plaintexts(domain, NEW)).toEqual([...sealed[domain]].sort());
    await expect(plaintexts(domain, OLD)).rejects.toThrow();
  });

  it('a second run changes nothing', async () => {
    const before = await envelopes(domain);
    const report = await run(domain, OLD, NEW);
    expect(report).toMatchObject({
      alreadyDone: before.length,
      rewrapped: 0,
      failed: 0,
      verified: before.length,
    });
    expect(await envelopes(domain)).toEqual(before);
  });

  it('resumes after a crash midway, and finishes on the next run', async () => {
    const total = (await envelopes(domain)).length;
    await expect(
      run(domain, NEW, NEWER, [], (n) => {
        if (n === 1) throw new Error('simulated crash after the first envelope');
      }),
    ).rejects.toThrow('simulated crash');
    // Half way: one under NEWER, the rest still under NEW.
    const resumed = await run(domain, NEW, NEWER);
    expect(resumed).toMatchObject({
      total,
      alreadyDone: 1,
      rewrapped: total - 1,
      failed: 0,
      verified: total,
    });
    expect(await plaintexts(domain, NEWER)).toEqual([...sealed[domain]].sort());
  });

  it('a service mid-rotation reads both keys and seals new values with the current one', async () => {
    const rotating = new RotatingKeyProvider(provider(key()), provider(NEWER));
    for (const envelope of await envelopes(domain)) {
      await expect(decryptSecret(envelope, rotating)).resolves.toBeTypeOf('string');
    }
    const fresh = await encryptSecret(
      'fresh-value-0000000000',
      'brandspace:test:v1:fresh',
      rotating,
    );
    await expect(decryptSecret(fresh, provider(NEWER))).rejects.toThrow();
  });
});

describe('D-574 · the platform vault still refuses any other change to secret material', () => {
  /** One connection the test controls, so "after the commit" is the same session. */
  async function session(): Promise<Client> {
    const client = new Client({ connectionString: libpqUrl(urlFor('platform', database)) });
    await client.connect();
    return client;
  }

  it('the re-wrap flag is transaction-scoped: gone after the commit, and a plain UPDATE of the wrapped key is then refused', async () => {
    const version = await prisma.secretVersion.findFirstOrThrow();
    const client = await session();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.kek_rewrap', 'on', true)`);
      const inside = await client.query(`SELECT current_setting('app.kek_rewrap', true) AS flag`);
      expect(inside.rows[0].flag).toBe('on');
      await client.query('COMMIT');

      const after = await client.query(`SELECT current_setting('app.kek_rewrap', true) AS flag`);
      expect(after.rows[0].flag ?? '').toBe('');
      await expect(
        client.query(`UPDATE "secret_version" SET "wrappedDataKey" = 'AAAA' WHERE id = $1`, [
          version.id,
        ]),
      ).rejects.toThrow(/only through the KEK re-wrap/);
    } finally {
      await client.end();
    }
  });

  it('without the re-wrap flag, the wrapped key, its provider and its key id cannot change', async () => {
    const version = await prisma.secretVersion.findFirstOrThrow();
    for (const data of [{ wrappedDataKey: 'AAAA' }, { keyProvider: 'other' }, { keyId: 'other' }]) {
      await expect(
        prisma.secretVersion.update({ where: { id: version.id }, data }),
        Object.keys(data)[0],
      ).rejects.toThrow();
    }
  });

  it('even with the re-wrap flag, the material and the identity cannot change', async () => {
    const version = await prisma.secretVersion.findFirstOrThrow();
    const other = await prisma.secretRecord.findFirstOrThrow({
      where: { id: { not: version.secretRecordId } },
    });
    const changes: Record<string, unknown>[] = [
      { ciphertext: 'AAAA' },
      { iv: 'AAAA' },
      { authTag: 'AAAA' },
      { encryptionContext: 'brandspace:other' },
      { id: randomUUID() },
      { secretRecordId: other.id },
      { version: version.version + 100 },
    ];
    for (const data of changes) {
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.kek_rewrap', 'on', true)`;
          await tx.secretVersion.update({ where: { id: version.id }, data });
        }),
        Object.keys(data)[0],
      ).rejects.toThrow();
    }
    const unchanged = await prisma.secretVersion.findUniqueOrThrow({ where: { id: version.id } });
    expect(unchanged).toEqual(version);
  });

  it('the status still changes without the flag (rotate and revoke)', async () => {
    const version = await prisma.secretVersion.findFirstOrThrow();
    await prisma.secretVersion.update({
      where: { id: version.id },
      data: { status: 'RETIRED', retiredAt: new Date() },
    });
    await prisma.secretVersion.update({
      where: { id: version.id },
      data: { status: version.status, retiredAt: version.retiredAt },
    });
  });

  it('the re-wrap sets its flag with set_config(..., true), never for the session', () => {
    const source = readFileSync(path.resolve(here, '../../packages/secrets/src/rewrap.ts'), 'utf8');
    expect(source).toContain("set_config('app.kek_rewrap', 'on', true)");
    expect(source).not.toMatch(/set_config\('app\.kek_rewrap',\s*'on',\s*false\)/);
    expect(source).not.toMatch(/SET\s+(SESSION\s+)?app\.kek_rewrap/i);
  });
});

describe('D-574 · the command', () => {
  const lines: string[] = [];
  const command = (argv: string[], env: Record<string, string | undefined>) =>
    runRewrapCommand({ argv, env, out: (line) => lines.push(line), prisma: prisma as never });

  it('refuses without both keys, with equal keys, or with an unknown actor — exit 2', async () => {
    expect(
      await command(['--domain', 'social', '--actor', actorEmail], {
        SOCIAL_TOKEN_VAULT_KEK: NEWER,
      }),
    ).toBe(2);
    expect(
      await command(['--domain', 'social', '--actor', actorEmail], {
        SOCIAL_TOKEN_VAULT_KEK: NEWER,
        SOCIAL_TOKEN_VAULT_KEK_PREVIOUS: NEWER,
      }),
    ).toBe(2);
    expect(
      await command(['--domain', 'social', '--actor', 'nobody@example.local'], {
        SOCIAL_TOKEN_VAULT_KEK: OLD,
        SOCIAL_TOKEN_VAULT_KEK_PREVIOUS: NEWER,
      }),
    ).toBe(2);
    expect(await command(['--domain', 'nonsense', '--actor', actorEmail], {})).toBe(2);
  });

  it('a wrong old key exits 1 and says to keep it; the right one exits 0 and says it can go', async () => {
    expect(
      await command(['--domain', 'social', '--actor', actorEmail], {
        SOCIAL_TOKEN_VAULT_KEK: OLD,
        SOCIAL_TOKEN_VAULT_KEK_PREVIOUS: WRONG,
      }),
    ).toBe(1);
    expect(lines.join('\n')).toMatch(/Stopped before writing/);
    expect(
      await command(['--domain', 'social', '--actor', actorEmail], {
        SOCIAL_TOKEN_VAULT_KEK: OLD,
        SOCIAL_TOKEN_VAULT_KEK_PREVIOUS: NEWER,
      }),
    ).toBe(0);
    expect(lines.join('\n')).toMatch(/SOCIAL_TOKEN_VAULT_KEK_PREVIOUS can now be removed/);
    expect(await plaintexts('social', OLD)).toEqual([...sealed.social].sort());
  });

  it('every run is audited with who, the domain and the counts', async () => {
    const events = await prisma.auditEvent.findMany({
      where: { action: { in: Object.values(REWRAP_AUDIT_ACTIONS) } },
      orderBy: { occurredAt: 'asc' },
    });
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.actorType).toBe('PLATFORM_USER');
      expect(event.actorId).toBe(actorId);
      expect(Object.keys(event.after as object).sort()).toEqual(
        [
          'alreadyDone',
          'domain',
          'dryRun',
          'failed',
          'rewrapped',
          'stoppedBeforeWriting',
          'total',
          'verified',
        ].sort(),
      );
    }
    expect(events.some((e) => e.action === REWRAP_AUDIT_ACTIONS.checked)).toBe(true);
    expect(events.some((e) => e.action === REWRAP_AUDIT_ACTIONS.completed)).toBe(true);
  });

  it('no key and no value appears in the output, the logs or the audit', async () => {
    const audit = JSON.stringify(
      await prisma.auditEvent.findMany({
        where: { action: { in: Object.values(REWRAP_AUDIT_ACTIONS) } },
      }),
    );
    const everything = [lines.join('\n'), printed.join(''), audit].join('\n');
    for (const secret of [OLD, NEW, NEWER, WRONG, ...Object.values(sealed).flat()]) {
      expect(everything).not.toContain(secret);
    }
  });
});
