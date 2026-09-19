import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { TOTP, URI } from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapProductionOwner } from '../../packages/database/prisma/bootstrap-production-owner';
import { BootstrapRefusal } from '../../packages/database/prisma/bootstrap-owner-guards';
import { dropThrowawayDatabase } from './fixtures';
import type {
  BootstrapResult,
  EnrolmentChallenge,
} from '../../packages/database/prisma/bootstrap-production-owner';

/**
 * THE PRODUCTION PLATFORM OWNER BOOTSTRAP, AGAINST A DATABASE NOBODY ELSE TOUCHED.
 *
 * WHY A THROWAWAY DATABASE AND NOT THE SHARED ONE. The claim this suite exists
 * to prove is a NEGATIVE: that running the command creates no workspace, no
 * customer, no membership, no brand, no wallet — nothing that would make a live
 * production database contain fiction. A negative about the whole database can
 * only be proven on a database whose entire contents are known, and the shared
 * isolation database is full of other suites' fixtures by design. So this one
 * builds its own from the migration files, runs the command against it, and
 * then reads EVERY TABLE IN THE SCHEMA and asserts which ones moved.
 *
 * That is a deliberately unforgiving shape. A new table that the bootstrap
 * starts writing to — for any reason, including a well-meant one — fails this
 * suite until somebody writes down why it belongs. "The command only creates
 * what it should" is not a property you can spot-check; it is a property you
 * enumerate.
 *
 * THE SUITE IS A STORY, IN ORDER, because the states it must prove are reached
 * by living through them:
 *
 *   1. an empty database, enrolled by an operator whose authenticator works;
 *   2. everything that write did, and everything it did not;
 *   3. no plaintext anywhere — every row of every table, and the transcript;
 *   4. a re-run that is INERT: not one row, in any table, including the audit
 *      trail;
 *   5. a crash mid-enrolment, reproduced, then a mistyped code that must NOT
 *      enable MFA, then a resume that must not collide with the seed already
 *      sealed — the defect this rewrite exists to fix;
 *   6. a dangerous inconsistency that must fail closed rather than repair
 *      itself by guessing;
 *   7. a different Platform Owner, refused without naming them.
 *
 * The CLI guards — production-only, TTY-only, placeholder refusal — are pure
 * functions over an environment and are proven in `tests/unit/
 * bootstrap-owner-guards.test.ts`, alongside the state machine's truth table.
 * This suite exercises the half that needs a real PostgreSQL with real
 * row-level security.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const migrationsDir = path.join(repoRoot, 'packages', 'database', 'prisma', 'migrations');

/** Rewrite a connection URL to point at a different database on the same server. */
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

/** `?schema=public` is a Prisma extension that libpq — and therefore psql — rejects. */
function libpqUrl(url: string): string {
  const parsed = new URL(url);
  parsed.search = '';
  return parsed.toString();
}

async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

function migrationNames(): string[] {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Apply one migration the way Prisma applies it.
 *
 * `psql` rather than `pg`, for the reason `f80-migration-upgrade.test.ts`
 * documents at length: Prisma does not wrap a migration file in a transaction,
 * and `pg`'s simple query protocol does, which breaks the migration that adds
 * an enum value and then uses it.
 */
function applyMigration(url: string, name: string): void {
  execFileSync(
    'psql',
    [
      '-v',
      'ON_ERROR_STOP=1',
      '--quiet',
      '--no-psqlrc',
      '-f',
      path.join(migrationsDir, name, 'migration.sql'),
      libpqUrl(url),
    ],
    { stdio: 'pipe', encoding: 'utf8' },
  );
}

/**
 * Let the OWNER of the tables read every row, for auditing only.
 *
 * `FORCE ROW LEVEL SECURITY` makes even the schema owner subject to policy,
 * which is exactly right for the product and exactly wrong for a test whose job
 * is to prove that a table is EMPTY: a policy that hid the rows would turn a
 * database full of fiction into a passing assertion. Lifting FORCE changes what
 * the MIGRATOR connection can see and nothing else — every other role is still
 * subject to RLS, so the command under test still runs under the real regime on
 * its own platform connection.
 *
 * It happens in a database that exists for a couple of minutes and is then
 * dropped.
 */
async function letTheOwnerSeeEverything(migrator: Client): Promise<void> {
  const { rows } = await migrator.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity`,
  );
  for (const { relname } of rows) {
    await migrator.query(`ALTER TABLE "${relname}" NO FORCE ROW LEVEL SECURITY`);
  }
}

/** Every base table in the schema, in a stable order. */
async function allTables(migrator: Client): Promise<string[]> {
  const { rows } = await migrator.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );
  return rows.map((r) => r.table_name);
}

/** Row counts for every table, with the empty ones omitted. */
async function nonEmptyTables(migrator: Client): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of await allTables(migrator)) {
    const { rows } = await migrator.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "${table}"`,
    );
    const n = Number(rows[0]?.n ?? '0');
    if (n > 0) out[table] = n;
  }
  return out;
}

/**
 * The whole database as text, one string per row.
 *
 * `row::text` renders every column of a row, whatever its type, which is what
 * makes the secret scan below future-proof: a column added next year is
 * searched without anybody editing this file.
 */
async function everyRowAsText(migrator: Client): Promise<{ table: string; row: string }[]> {
  const out: { table: string; row: string }[] = [];
  for (const table of await allTables(migrator)) {
    const { rows } = await migrator.query<{ row: string }>(
      `SELECT t::text AS row FROM "${table}" t`,
    );
    for (const r of rows) out.push({ table, row: r.row });
  }
  return out;
}

/**
 * The tables the bootstrap is ALLOWED to leave rows in.
 *
 * Everything else in the schema must still be empty afterwards. The list is
 * short on purpose, and every entry earns its place:
 *
 *   `permission`, `role`,       the catalogue and the system roles the product
 *   `role_permission`           defines. Configuration, not data.
 *   `platform_user`             the owner. Exactly one.
 *   `platform_mfa_recovery_code` hashes of their recovery codes.
 *   `secret_record`,            the sealed TOTP seed.
 *   `secret_version`
 *   `audit_event`               the trail. Its absence would be the defect.
 */
const PERMITTED_TABLES = [
  'audit_event',
  'permission',
  'platform_mfa_recovery_code',
  'platform_user',
  'role',
  'role_permission',
  'secret_record',
  'secret_version',
];

/**
 * The tenant-owned tables a development seed fills and this command must not.
 *
 * Asserted BY NAME as well as by the enumeration above, because a name is what
 * a reviewer recognises. If `workspace` ever appears in `PERMITTED_TABLES` by
 * accident, this fails too and says the word out loud.
 */
const CUSTOMER_TABLES = [
  'workspace',
  'user',
  'membership',
  'brand',
  'credit_wallet',
  'credit_transaction',
  'campaign',
  'content_item',
  'asset',
  'subscription',
  'invitation',
  'social_connection',
];

/**
 * An authenticator app, as far as this command can tell.
 *
 * Parsing the otpauth URI and generating from it is exactly what a phone does,
 * so this exercises the real contract rather than reaching past it for the
 * seed. It also means a change to the issuer, the period or the digit count
 * would break this suite — which is correct, because it would break every
 * operator's phone too.
 */
function codeFrom(otpauthUri: string): string {
  const totp = URI.parse(otpauthUri);
  if (!(totp instanceof TOTP)) throw new Error('the enrolment URI is not a TOTP URI');
  return totp.generate();
}

// ---------------------------------------------------------------------------

describe('the production Platform Owner bootstrap', () => {
  const database = `bs_bootstrap_owner_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  /*
   * THE OWNER ADDRESS CARRIES A TEST-FIXTURE TOKEN, and that is not decoration.
   * `buildSecretRef` slugs the address into the secret's ref, so the seed this
   * suite seals is recognisable as a fixture anywhere it is later seen. The
   * database is dropped either way; this makes a stray row self-describing.
   */
  const ownerEmail = `owner-zz-testfixture-${randomUUID().slice(0, 8)}@brandspace.test`;
  const password = 'a-real-owner-passphrase-9f2c-not-a-marker';

  let admin: Client;
  let migrator: Client;
  let prisma: PrismaClient;

  /** Everything the command printed, for the "never logs a secret" assertion. */
  const printed: string[] = [];
  const log = (line: string): void => void printed.push(line);

  /** Every enrolment URI the command ever showed, in order. */
  const scanned: string[] = [];

  /** An operator whose authenticator works. */
  const goodAuthenticator = async ({ otpauthUri }: EnrolmentChallenge): Promise<string> => {
    scanned.push(otpauthUri);
    return codeFrom(otpauthUri);
  };

  /** An operator who mistyped, or whose clock is wrong, or who scanned nothing. */
  const wrongCode = async ({ otpauthUri }: EnrolmentChallenge): Promise<string> => {
    scanned.push(otpauthUri);
    // Well-formed and wrong. The comparison keeps it wrong in the one-in-a-
    // million run where the real code happens to be all zeroes.
    return codeFrom(otpauthUri) === '000000' ? '111111' : '000000';
  };

  function run(over: Partial<Parameters<typeof bootstrapProductionOwner>[0]> = {}) {
    return bootstrapProductionOwner({
      prisma,
      ownerEmail,
      password,
      log,
      confirmEnrolment: goodAuthenticator,
      ...over,
    });
  }

  let firstRun: BootstrapResult;
  let totpSecret: string;
  let recoveryCodes: readonly string[];

  beforeAll(async () => {
    admin = await connect(urlFor('migrator', 'postgres'));
    await admin.query(`CREATE DATABASE "${database}"`);

    const migratorUrl = urlFor('migrator', database);
    for (const name of migrationNames()) applyMigration(migratorUrl, name);

    migrator = await connect(migratorUrl);
    await letTheOwnerSeeEverything(migrator);

    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: urlFor('platform', database) }),
    });
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await migrator?.end();
    if (admin) {
      await dropThrowawayDatabase(admin, database);
      await admin.end();
    }
  }, 60_000);

  it('starts from a database in which every single table is empty', async () => {
    /*
     * Without this the "created no customer data" assertions below would pass
     * against a database that was never capable of holding any.
     *
     * EVERY table, `_prisma_migrations` included: the migrations are replayed
     * file by file through psql rather than through `migrate deploy`, so
     * Prisma's own history table is created and left empty. That is a property
     * of how this suite builds its database, not of the command under test.
     */
    expect(await nonEmptyTables(migrator)).toEqual({});
  });

  it('bootstraps the owner once a live code from their authenticator verifies', async () => {
    firstRun = await run();

    expect(firstRun.outcome.kind).toBe('bootstrapped');
    expect(firstRun.recoveryCodes).not.toBeNull();
    expect(scanned).toHaveLength(1);

    // Captured here rather than re-derived later: this is the only moment the
    // plaintext exists outside the operator's authenticator.
    const shown = firstRun.recoveryCodes;
    const uri = scanned[0];
    if (!shown || !uri) throw new Error('the first run must produce an enrolment');
    recoveryCodes = shown;
    totpSecret = new URL(uri.replace('otpauth://', 'https://')).searchParams.get('secret') ?? '';

    expect(totpSecret.length).toBeGreaterThanOrEqual(16);
    expect(recoveryCodes.length).toBeGreaterThanOrEqual(8);
  }, 120_000);

  describe('what it wrote, and nothing else', () => {
    it('leaves rows in exactly the permitted tables', async () => {
      const touched = Object.keys(await nonEmptyTables(migrator)).sort();
      expect(touched).toEqual([...PERMITTED_TABLES].sort());
    });

    it('creates NO workspace, customer, membership, brand, wallet or content row', async () => {
      const counts = await nonEmptyTables(migrator);
      const populated = CUSTOMER_TABLES.filter((table) => counts[table] !== undefined);
      expect(populated).toEqual([]);
    });

    it('creates exactly ONE platform user', async () => {
      expect(await prisma.platformUser.count()).toBe(1);
    });

    it('gives that user the platform_owner role, read back from the database', async () => {
      const owner = await prisma.platformUser.findUniqueOrThrow({
        where: { email: ownerEmail },
        include: { role: true },
      });
      expect(owner.role.key).toBe('platform_owner');
      expect(owner.role.realm).toBe('PLATFORM');
      expect(owner.role.workspaceId).toBeNull();
      expect(owner.status).toBe('ACTIVE');
    });

    it('enrols MFA, because a platform account without it is unusable (D-27)', async () => {
      const owner = await prisma.platformUser.findUniqueOrThrow({ where: { email: ownerEmail } });
      expect(owner.mfaEnabled).toBe(true);
      expect(owner.mfaSecretRef).toMatch(/^mfa-totp\/platform\/production\//);
      expect(owner.mfaEnrolledAt).not.toBeNull();

      const sealed = await prisma.secretRecord.findUniqueOrThrow({
        where: {
          ref_environment: { ref: owner.mfaSecretRef ?? '', environment: 'PRODUCTION' },
        },
      });
      expect(sealed.category).toBe('mfa_totp');
    });

    it('stores recovery codes as hashes, never as codes', async () => {
      const stored = await prisma.platformMfaRecoveryCode.findMany();
      expect(stored).toHaveLength(recoveryCodes.length);
      for (const row of stored) {
        expect(recoveryCodes).not.toContain(row.codeHash);
        expect(row.usedAt).toBeNull();
      }
    });

    it('hashes the password with the product’s own Argon2 code', async () => {
      const owner = await prisma.platformUser.findUniqueOrThrow({ where: { email: ownerEmail } });
      expect(owner.passwordHash).toMatch(/^\$argon2id\$/);
    });

    it('records the bootstrap in the audit trail, and records nothing else', async () => {
      const events = await prisma.auditEvent.findMany();
      /*
       * ENUMERATED, not filtered. Creating the owner of a live platform is the
       * single most consequential thing anybody will ever do to this database,
       * and the trail should describe it completely: the roles were written
       * through the audited cross-tenant door, a secret was sealed, and an
       * account came into existence.
       */
      expect(events.map((e) => e.action).sort()).toEqual([
        'platform.bootstrap.owner',
        'platform.bootstrap.roles',
        'secret.created',
      ]);
      // Platform rows are not tenant rows: the trail must not claim otherwise.
      for (const event of events) expect(event.workspaceId).toBeNull();
    });
  });

  describe('nothing secret survives anywhere it could be read', () => {
    /**
     * The needles. Every one of them existed in this process; none of them may
     * exist in the database or in the transcript.
     */
    function needles(): { label: string; value: string }[] {
      const uri = scanned[0];
      if (!uri) throw new Error('the first run must have shown an enrolment');
      return [
        { label: 'the password', value: password },
        { label: 'the TOTP secret', value: totpSecret },
        { label: 'the otpauth URI', value: uri },
        ...recoveryCodes.map((code, i) => ({ label: `recovery code ${i}`, value: code })),
      ];
    }

    it('appears in no column of any row of any table', async () => {
      const rows = await everyRowAsText(migrator);
      // A scan that found nothing to scan would pass silently.
      expect(rows.length).toBeGreaterThan(50);

      for (const { label, value } of needles()) {
        const offenders = rows.filter((r) => r.row.includes(value)).map((r) => r.table);
        expect(offenders, `${label} was stored in plaintext`).toEqual([]);
      }
    });

    it('appears in nothing the command printed', () => {
      /*
       * The otpauth URI IS shown to the operator — that is the point of
       * enrolment — but by the interactive command's own disclosure, not by
       * the progress log this captures. Anything reaching `log` reaches the
       * scrollback of whoever ran it and, eventually, a support thread.
       */
      const transcript = printed.join('\n');
      expect(transcript.length).toBeGreaterThan(0);
      for (const { label, value } of needles()) {
        expect(transcript.includes(value), `${label} was printed`).toBe(false);
      }
    });

    it('is not recoverable from the sealed seed by reading the row', async () => {
      // The positive half of the assertion above: the ciphertext EXISTS, it is
      // simply not the plaintext. Without this, an empty secret table would
      // satisfy "no plaintext anywhere".
      const versions = await prisma.secretVersion.findMany();
      expect(versions).toHaveLength(1);
      const blob = JSON.stringify(versions[0]);
      expect(blob).not.toContain(totpSecret);
      expect(blob.length).toBeGreaterThan(totpSecret.length);
    });
  });

  describe('re-running it against a finished owner', () => {
    let before: Record<string, number>;
    let ownerBefore: { passwordHash: string | null; mfaSecretRef: string | null };
    let hashesBefore: string[];

    beforeAll(async () => {
      before = await nonEmptyTables(migrator);
      const owner = await prisma.platformUser.findUniqueOrThrow({ where: { email: ownerEmail } });
      ownerBefore = { passwordHash: owner.passwordHash, mfaSecretRef: owner.mfaSecretRef };
      hashesBefore = (
        await prisma.platformMfaRecoveryCode.findMany({ orderBy: { codeHash: 'asc' } })
      ).map((r) => r.codeHash);
    });

    it('reports that the owner is already bootstrapped, and discloses nothing', async () => {
      const again = await run({
        confirmEnrolment: async () => {
          throw new Error('a finished owner must never be asked to confirm an enrolment');
        },
      });
      expect(again.outcome.kind).toBe('already-bootstrapped');
      // There is deliberately no way to show the seed a second time: it is
      // sealed, and this command has no business unsealing one.
      expect(again.recoveryCodes).toBeNull();
    }, 120_000);

    it('writes NO row, in any table — including the audit trail', async () => {
      /*
       * TRULY INERT, and that is a change. The first version synchronised the
       * catalogue and appended an audit event before it asked whether there was
       * anything to do, so "nothing was changed" was not true: roles were
       * rewritten and the trail grew on every invocation. The documentation
       * said one thing and the code did another, and the code was the one that
       * had to move.
       */
      expect(await nonEmptyTables(migrator)).toEqual(before);
    });

    it('does not replace the password, the seed or the recovery codes', async () => {
      const owner = await prisma.platformUser.findUniqueOrThrow({ where: { email: ownerEmail } });
      expect(owner.passwordHash).toBe(ownerBefore.passwordHash);
      expect(owner.mfaSecretRef).toBe(ownerBefore.mfaSecretRef);

      const hashesAfter = (
        await prisma.platformMfaRecoveryCode.findMany({ orderBy: { codeHash: 'asc' } })
      ).map((r) => r.codeHash);
      expect(hashesAfter).toEqual(hashesBefore);
    });

    it('is not a password reset, even when handed a different password', async () => {
      /*
       * THE ATTACK THIS FORBIDS. If a re-run set the password it was given,
       * this command would be a standing account-takeover primitive for
       * anybody who can open a shell on the platform — no existing credential
       * required. It must decline, quietly and completely.
       */
      const again = await run({ password: 'an-entirely-different-passphrase-4b81' });
      expect(again.outcome.kind).toBe('already-bootstrapped');

      const owner = await prisma.platformUser.findUniqueOrThrow({ where: { email: ownerEmail } });
      expect(owner.passwordHash).toBe(ownerBefore.passwordHash);
    }, 120_000);
  });

  describe('an enrolment that was never confirmed', () => {
    let passwordHashBefore: string | null;

    beforeAll(async () => {
      /*
       * REPRODUCING THE CRASH, EXACTLY.
       *
       * A seed sealed under this owner's ref with MFA switched off is what a
       * process killed mid-enrolment leaves behind — and, now, what a mistyped
       * confirmation code leaves behind on purpose. It used to be unrecoverable:
       * the command took the enrolment branch anyway and called `createSecret`
       * for a ref that already existed, which conflicts on the unique index, so
       * the only command able to finish the account was guaranteed to fail on
       * it.
       *
       * The sealed secret is deliberately LEFT IN PLACE. That is the whole
       * point of the state.
       */
      const owner = await prisma.platformUser.findUniqueOrThrow({ where: { email: ownerEmail } });
      passwordHashBefore = owner.passwordHash;
      await prisma.platformMfaRecoveryCode.deleteMany({ where: { platformUserId: owner.id } });
      await prisma.platformUser.update({
        where: { id: owner.id },
        data: { mfaEnabled: false, mfaSecretRef: null, mfaEnrolledAt: null },
      });
    });

    it('is exactly one sealed record, which is what used to make it unrecoverable', async () => {
      expect(await prisma.secretRecord.count()).toBe(1);
      expect(await prisma.platformMfaRecoveryCode.count()).toBe(0);
    });

    it('A WRONG CODE ENABLES NOTHING', async () => {
      const refusal = await run({ confirmEnrolment: wrongCode }).then(
        () => {
          throw new Error('a wrong code was expected to refuse, and did not');
        },
        (caught: unknown) => caught,
      );

      expect(refusal).toBeInstanceOf(BootstrapRefusal);
      if (!(refusal instanceof BootstrapRefusal)) throw refusal;
      expect(refusal.message).toMatch(/did not verify/i);

      const owner = await prisma.platformUser.findUniqueOrThrow({ where: { email: ownerEmail } });
      expect(owner.mfaEnabled, 'MFA must stay off').toBe(false);
      expect(owner.mfaSecretRef).toBeNull();
      expect(await prisma.platformMfaRecoveryCode.count(), 'no codes may be issued').toBe(0);
    }, 120_000);

    it('rotated the existing seed rather than colliding with it', async () => {
      /*
       * ONE RECORD, TWO VERSIONS. The record is the same row it always was —
       * which is why there is no unique-constraint violation — and the seed
       * inside it is new, which is why the operator can be shown a fresh URI
       * without anything ever unsealing the old one.
       */
      expect(await prisma.secretRecord.count()).toBe(1);
      expect(await prisma.secretVersion.count()).toBe(2);

      const active = await prisma.secretVersion.findMany({ where: { status: 'ACTIVE' } });
      expect(active, 'exactly one version may be active').toHaveLength(1);
    });

    it('resumes and completes when a live code finally verifies', async () => {
      const resumed = await run();
      expect(resumed.outcome.kind).toBe('resumed');
      expect(resumed.recoveryCodes).not.toBeNull();

      const owner = await prisma.platformUser.findUniqueOrThrow({ where: { email: ownerEmail } });
      expect(owner.mfaEnabled).toBe(true);
      expect(owner.mfaSecretRef).toMatch(/^mfa-totp\/platform\/production\//);
      expect(await prisma.platformMfaRecoveryCode.count()).toBe(resumed.recoveryCodes?.length);

      // Still one record; still no second row under the same ref.
      expect(await prisma.secretRecord.count()).toBe(1);
      expect(await prisma.secretVersion.count()).toBe(3);
    }, 120_000);

    it('left the existing password alone while resuming', async () => {
      const owner = await prisma.platformUser.findUniqueOrThrow({ where: { email: ownerEmail } });
      expect(owner.passwordHash).toBe(passwordHashBefore);
    });

    it('still created no customer data along the way', async () => {
      const counts = await nonEmptyTables(migrator);
      expect(CUSTOMER_TABLES.filter((table) => counts[table] !== undefined)).toEqual([]);
      expect(Object.keys(counts).sort()).toEqual([...PERMITTED_TABLES].sort());
    });
  });

  describe('a dangerous inconsistency', () => {
    let before: Record<string, number>;

    beforeAll(async () => {
      /*
       * AN ACCOUNT THAT BELIEVES IT HAS MFA, WITH NO SEED IN THE VAULT.
       *
       * However it arose — a restore that replayed one table and not another,
       * a hand-edited row — the owner may still be carrying a working
       * authenticator. Re-enrolling would replace their second factor with one
       * only the person at this shell holds, which is an account takeover
       * wearing a recovery script's clothes.
       */
      await prisma.secretVersion.deleteMany({});
      await prisma.secretRecord.deleteMany({});
      before = await nonEmptyTables(migrator);
    });

    it('refuses rather than re-enrolling an owner whose MFA may be live', async () => {
      const refusal = await run().then(
        () => {
          throw new Error('an inconsistent state was expected to refuse, and did not');
        },
        (caught: unknown) => caught,
      );

      expect(refusal).toBeInstanceOf(BootstrapRefusal);
      if (!(refusal instanceof BootstrapRefusal)) throw refusal;
      expect(refusal.message).toMatch(/refusing to bootstrap/i);
      expect(refusal.message).toMatch(/nothing was written/i);
    }, 120_000);

    it('wrote nothing while refusing — not a role, not an audit event', async () => {
      expect(await nonEmptyTables(migrator)).toEqual(before);
    });

    it('never asked for a confirmation code, because it never got that far', async () => {
      const scannedBefore = scanned.length;
      await run({
        confirmEnrolment: async () => {
          throw new Error('an inconsistent state must never reach enrolment');
        },
      }).catch(() => undefined);
      expect(scanned.length).toBe(scannedBefore);
    }, 120_000);
  });

  describe('when a different Platform Owner already exists', () => {
    let before: Record<string, number>;

    beforeAll(async () => {
      before = await nonEmptyTables(migrator);
    });

    it('refuses, and does not say who the other owner is', async () => {
      const intruderEmail = `someone-else-zz-testfixture-${randomUUID().slice(0, 8)}@brandspace.test`;
      const newcomerEmail = `newcomer-zz-testfixture-${randomUUID().slice(0, 8)}@brandspace.test`;
      const ownerRole = await prisma.role.findFirstOrThrow({
        where: { key: 'platform_owner', workspaceId: null },
      });
      await prisma.platformUser.create({
        data: { email: intruderEmail, name: 'Other Owner', status: 'ACTIVE', roleId: ownerRole.id },
      });

      const error = await run({ ownerEmail: newcomerEmail }).then(
        () => {
          throw new Error('the bootstrap was expected to refuse, and did not');
        },
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(BootstrapRefusal);
      if (!(error instanceof BootstrapRefusal)) throw error;

      /*
       * THE OTHER OWNER'S ADDRESS IS PRIVATE. Whoever is running this does not
       * necessarily have standing to learn who else administers the platform,
       * and the refusal is actionable without it.
       */
      expect(error.message).not.toContain(intruderEmail);
      expect(error.message).toMatch(/different Platform Owner already exists/i);
    }, 120_000);

    it('wrote nothing while refusing — not even a catalogue row', async () => {
      const after = await nonEmptyTables(migrator);
      // The intruder the test itself created is the one expected difference.
      expect(after).toEqual({ ...before, platform_user: (before['platform_user'] ?? 0) + 1 });
    });

    it('created no account for the address it refused', async () => {
      expect(await prisma.platformUser.count({ where: { name: 'Platform Owner' } })).toBe(1);
    });
  });
});
