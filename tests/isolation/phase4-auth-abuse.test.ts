import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AuthRateLimiter,
  BOOTSTRAP_CEILINGS,
  CustomerAuthService,
  SignupService,
  hashPassword,
  isRateLimited,
  type AbuseCeilings,
} from '@brandspace/auth';
import { requestContext } from '@brandspace/shared';
import { LocalDevelopmentKeyProvider } from '@brandspace/vault';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/** A key that exists only here, so the suite seals the same way on every machine. */
const FIXTURE_KEK = 'isolation-fixture-customer-mfa-kek-000000';

/**
 * ABUSE CEILINGS FOR THE AUTHENTICATION SURFACE — Phase 4, F-19.
 *
 * WHAT WAS TRUE BEFORE THIS SUITE, measured against unmodified main:
 *
 *   - three accounts sprayed one wrong password each from one source: three
 *     credential refusals and zero rate refusals, because the only brake was a
 *     per-ACCOUNT lockout that none of them came near;
 *   - twenty-five password-reset tokens issued for ONE address in a loop, which
 *     is twenty-five working reset links into a stranger's inbox.
 *
 * Every assertion below fails against that implementation.
 */

const PASSWORD = 'a-strong-local-only-test-password-8842';

/** Tight ceilings, so the suite proves the RULE rather than waits out a window. */
const CEILINGS: AbuseCeilings = {
  ...BOOTSTRAP_CEILINGS,
  windowSeconds: 3_600,
  signInPerIp: 3,
  signInPerAccount: 4,
  signUpPerIp: 2,
  passwordResetPerIp: 3,
  passwordResetPerAccount: 2,
  verificationResendPerIp: 2,
  mfaPerIp: 3,
  mfaPerAccount: 2,
};

let fixtures: IsolationFixtures;
let app: PrismaClient;
let platform: PrismaClient;

beforeAll(async () => {
  app = appRoleClient();
  platform = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env['DATABASE_PLATFORM_URL']! }),
  });
  fixtures = await createIsolationFixtures(app);
  void fixtures;
}, 90_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

/**
 * A SOURCE ADDRESS NOBODY ELSE HAS USED.
 *
 * The window is an hour and the isolation database outlives the run, so a
 * literal address inherits its own count from the previous run and the second
 * run of this suite fails on attempt one. The same trap as F-23, in a counter
 * rather than a seed.
 *
 * IPv6, FROM THE DOCUMENTATION PREFIX (2001:db8::/32), with 64 random bits.
 * This drew from 198.18.x.y — about 65,000 addresses — while other tests in
 * this file deliberately spend an address past its ceiling. A later "fresh"
 * address that repeated a spent one started over the ceiling, and a test
 * asserting a normal sign-in was refused (CI, isolation job on f0f57f3). At
 * 2^64 a repeat, within a run or across runs, is not a practical event.
 * `requestContext` carries an IPv6 address through every header shape used
 * here unchanged.
 */
function freshIp(): string {
  const hex = randomUUID().replace(/-/g, '');
  const groups = [0, 4, 8, 12].map((start) => hex.slice(start, start + 4));
  return `2001:db8:0:0:${groups.join(':')}`;
}

/** A fresh ACTIVE customer with a working password. */
async function customer(): Promise<{ id: string; email: string }> {
  const email = `p4-${randomUUID()}@example.test`;
  const user = await platform.user.create({
    data: {
      email,
      name: 'phase four',
      locale: 'EN',
      timezone: 'UTC',
      status: 'ACTIVE',
      passwordHash: await hashPassword(PASSWORD),
    },
    select: { id: true, email: true },
  });
  return user;
}

function auth(): CustomerAuthService {
  // THE TENANT CLIENT, deliberately: the customer application counts these
  // attempts under RLS with no workspace context, which is the state
  // authentication actually runs in.
  return new CustomerAuthService({ prisma: app, ceilings: CEILINGS });
}

describe('one source cannot spray many accounts', () => {
  it('REFUSES BY SOURCE once the ceiling is reached, whatever account is named', async () => {
    const ip = freshIp();
    const service = auth();
    const outcomes: string[] = [];

    // Four DIFFERENT accounts, one wrong password each, from one address. The
    // per-account lockout (ten) is never approached; the per-source ceiling
    // (three) is.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const target = await customer();
      const result = await service
        .signIn({ email: target.email, password: 'not-the-password', ip })
        .then(() => 'accepted')
        .catch((error: unknown) => (isRateLimited(error) ? 'rate-limited' : 'credentials'));
      outcomes.push(result);
    }

    expect(outcomes.slice(0, 3)).toEqual(['credentials', 'credentials', 'credentials']);
    expect(outcomes[3]).toBe('rate-limited');
  });

  it('refuses a CORRECT password once the source is over its ceiling', async () => {
    const ip = freshIp();
    const service = auth();
    const victim = await customer();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await service
        .signIn({ email: (await customer()).email, password: 'wrong', ip })
        .catch(() => undefined);
    }

    // The ceiling is about the SOURCE, so knowing a password does not buy a
    // way past it.
    await expect(service.signIn({ email: victim.email, password: PASSWORD, ip })).rejects.toThrow(
      /too many attempts/i,
    );
  });

  it('does not punish a different source for the first one', async () => {
    const attacker = freshIp();
    const honest = freshIp();
    const service = auth();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await service
        .signIn({ email: (await customer()).email, password: 'wrong', ip: attacker })
        .catch(() => undefined);
    }
    const target = await customer();
    // A real person on another connection is unaffected.
    await expect(
      service.signIn({ email: target.email, password: PASSWORD, ip: honest }),
    ).resolves.toMatchObject({ mfaRequired: false });
  });
});

describe('an inbox is not a weapon', () => {
  it('STOPS ISSUING RESET TOKENS for one address at the ceiling', async () => {
    const target = await customer();
    const service = auth();
    let issued = 0;
    let refused = 0;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await service
        .beginPasswordReset(target.email, freshIp())
        .then((result) => {
          if (result) issued += 1;
        })
        .catch((error: unknown) => {
          if (isRateLimited(error)) refused += 1;
          else throw error;
        });
    }

    // Two, the per-account ceiling — NOT twenty-five. Each source is different,
    // so only the per-account dimension can stop this, which is the point.
    expect(issued).toBe(2);
    expect(refused).toBe(3);
    expect(await platform.passwordResetToken.count({ where: { userId: target.id } })).toBe(2);
  });

  it('REFUSES A KNOWN AND AN UNKNOWN ADDRESS IDENTICALLY, so the ceiling is no oracle', async () => {
    const service = auth();

    /*
     * THE RISK A CEILING INTRODUCES. Rate limiting is a new observable, and an
     * observable that differs between a registered address and an unregistered
     * one is an account-existence oracle — precisely what the uniform
     * acknowledgement elsewhere in this service exists to prevent. So the two
     * sequences are compared to each other rather than to a literal: whatever
     * the numbers are, they must be the same numbers.
     */
    async function sequenceFor(address: string): Promise<string[]> {
      const outcomes: string[] = [];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        outcomes.push(
          await service
            .beginPasswordReset(address, freshIp())
            .then(() => 'acknowledged')
            .catch((error: unknown) => (isRateLimited(error) ? 'rate-limited' : 'other')),
        );
      }
      return outcomes;
    }

    const registered = await sequenceFor((await customer()).email);
    const stranger = await sequenceFor(`p4-nobody-${randomUUID()}@example.test`);

    expect(stranger).toEqual(registered);
    // And it does refuse: a sequence of four acknowledgements would pass the
    // equality above while proving no ceiling exists at all.
    expect(registered).toContain('rate-limited');
    expect(registered).not.toContain('other');
  });
});

describe('the second factor is counted too', () => {
  it('refuses code guesses from one source past the ceiling', async () => {
    const service = auth();
    const ip = freshIp();
    const target = await customer();

    /*
     * ENROLLED THROUGH THE REAL PATH. `mfaEnabled` cannot simply be set: a CHECK
     * constraint requires the flag and the sealed seed to agree, which is itself
     * a safeguard worth leaving intact. The seed is sealed under a fixture key,
     * and the code is never verified here — `verify` is stubbed — because what
     * is under test is the CEILING, not the arithmetic of TOTP.
     */
    const signup = new SignupService({
      prisma: platform,
      email: { key: 'test', send: async () => ({ messageId: randomUUID() }) },
      verificationLink: () => 'https://example.test/verify',
      keyProvider: new LocalDevelopmentKeyProvider(FIXTURE_KEK),
    });
    await signup.beginMfaEnrolment(
      {
        signup: {
          open: true,
          minPasswordLength: 12,
          verificationTtlMinutes: 60,
          verificationResendCooldownSeconds: 0,
          verificationsPerHour: 50,
        },
        abuse: CEILINGS,
        legalDocuments: [],
        mfa: { customerEnrolmentEnabled: true, requiredForCustomers: false, recoveryCodeCount: 10 },
        steps: [],
      },
      target.id,
    );
    await platform.user.update({
      where: { id: target.id },
      data: { mfaEnabled: true, mfaEnrolledAt: new Date() },
    });

    // A session that owes its second factor, created under ceilings that cannot
    // interfere with what this test is measuring.
    const session = await new CustomerAuthService({
      prisma: app,
      ceilings: { ...CEILINGS, signInPerIp: 1_000, signInPerAccount: 1_000 },
    }).signIn({ email: target.email, password: PASSWORD, ip: freshIp() });

    const outcomes: string[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      outcomes.push(
        await service
          .completeMfa({ token: session.token, code: '000000', ip, verify: async () => false })
          .then(() => 'verified')
          .catch((error: unknown) => (isRateLimited(error) ? 'rate-limited' : 'bad-code')),
      );
    }
    // Three guesses from this source, then refused — well before the six-digit
    // space is anywhere near explored.
    expect(outcomes[0]).toBe('bad-code');
    expect(outcomes[3]).toBe('rate-limited');
  });
});

describe('the password step-up is counted on its own (Phase 2B-1, D-328)', () => {
  it('ordinary sign-ins do not use up the step-up, and the step-up has its own ceiling', async () => {
    const service = auth();
    const target = await customer();

    // Spend the account's whole SIGN-IN budget honestly, from fresh sources.
    let token = '';
    for (let attempt = 0; attempt < CEILINGS.signInPerAccount; attempt += 1) {
      token = (await service.signIn({ email: target.email, password: PASSWORD, ip: freshIp() }))
        .token;
    }
    await expect(
      service.signIn({ email: target.email, password: PASSWORD, ip: freshIp() }),
    ).rejects.toSatisfy(isRateLimited);

    // The step-up before an irreversible action still answers — it is not a
    // sign-in and does not share that count.
    const outcomes: string[] = [];
    for (let attempt = 0; attempt <= CEILINGS.signInPerAccount; attempt += 1) {
      outcomes.push(
        await service
          .confirmPassword({ token, password: PASSWORD, ip: freshIp() })
          .then((ok) => (ok ? 'confirmed' : 'refused'))
          .catch((error: unknown) => (isRateLimited(error) ? 'rate-limited' : 'error')),
      );
    }
    expect(outcomes.slice(0, CEILINGS.signInPerAccount)).toEqual(
      Array.from({ length: CEILINGS.signInPerAccount }, () => 'confirmed'),
    );
    expect(outcomes[CEILINGS.signInPerAccount]).toBe('rate-limited');
  });
});

describe('the counter is correct under concurrency', () => {
  /*
   * A DETERMINISTIC RACE, NOT A TIMING ONE. Every attempt is started before any
   * is awaited, so they contend on the unique key inside one database; the
   * assertion is on the SET of returned counts, which a read-modify-write
   * implementation cannot produce however the scheduler interleaves it.
   */
  it('loses no increments when attempts arrive together', async () => {
    const limiter = new AuthRateLimiter({ prisma: app });
    const subject = `race-${randomUUID()}`;
    const attempts = 12;

    const decisions = await Promise.all(
      Array.from({ length: attempts }, () => limiter.record('signin:ip', subject, 1_000, 3_600)),
    );

    const counts = decisions.map((d) => d.count).sort((a, b) => a - b);
    // Exactly one through each value: no increment lost, none applied twice.
    expect(counts).toEqual(Array.from({ length: attempts }, (_, index) => index + 1));
  });

  it('admits exactly the ceiling when the whole burst races it', async () => {
    const limiter = new AuthRateLimiter({ prisma: app });
    const subject = `race-ceiling-${randomUUID()}`;
    const limit = 5;

    const decisions = await Promise.all(
      Array.from({ length: 20 }, () => limiter.record('signin:ip', subject, limit, 3_600)),
    );

    expect(decisions.filter((d) => d.allowed)).toHaveLength(limit);
    expect(decisions.filter((d) => !d.allowed)).toHaveLength(15);
  });

  it('keeps separate subjects in separate buckets', async () => {
    const limiter = new AuthRateLimiter({ prisma: app });
    const a = await limiter.record('signin:ip', `sep-a-${randomUUID()}`, 1, 3_600);
    const b = await limiter.record('signin:ip', `sep-b-${randomUUID()}`, 1, 3_600);
    expect([a.count, b.count]).toEqual([1, 1]);
  });

  it('keeps the same subject in separate buckets per SCOPE', async () => {
    const limiter = new AuthRateLimiter({ prisma: app });
    const subject = `scoped-${randomUUID()}`;
    await limiter.record('signin:ip', subject, 10, 3_600);
    const other = await limiter.record('password-reset:ip', subject, 10, 3_600);
    // Counting a sign-in attempt against a reset budget would let one surface
    // lock a caller out of an unrelated one.
    expect(other.count).toBe(1);
  });
});

describe('the counter fails closed and stores nothing identifying', () => {
  it('REFUSES rather than admits when it cannot record the attempt', async () => {
    /*
     * docs/SECURITY.md §19.1: what must never happen is rate limiting silently
     * switching itself off. A store that throws is the whole point of this
     * test — the alternative implementation, which swallows and continues, is
     * indistinguishable from having no limiter at all exactly when it matters.
     */
    const broken = new AuthRateLimiter({
      prisma: {
        $queryRaw: async () => {
          throw new Error('no database');
        },
      },
    });
    await expect(broken.enforce('signin:ip', '203.0.113.1', 10, 300)).rejects.toThrow(
      /too many attempts/i,
    );
  });

  it('stores neither the address nor the account it is counting', async () => {
    const limiter = new AuthRateLimiter({ prisma: app });
    const address = `secret-${randomUUID()}@example.test`;
    await limiter.record('password-reset:account', address, 10, 3_600);

    const rows = await platform.authRateLimit.findMany({
      where: { scope: 'password-reset:account' },
      select: { subjectHash: true },
    });
    // The subject is a hash and only a hash: a dump of this table names nobody.
    expect(rows.some((row) => row.subjectHash.includes(address))).toBe(false);
    expect(rows.every((row) => /^[0-9a-f]{64}$/.test(row.subjectHash))).toBe(true);
  });

  it('skips a dimension it has no subject for rather than pooling everybody', async () => {
    const limiter = new AuthRateLimiter({ prisma: app });
    // A deployment that cannot establish a source address must not put every
    // caller in the world into one bucket and lock the product out.
    await expect(limiter.enforce('signin:ip', undefined, 1, 3_600)).resolves.toBeUndefined();
    await expect(limiter.enforce('signin:ip', '', 1, 3_600)).resolves.toBeUndefined();
  });
});

describe('signup and resend are bounded by source', () => {
  const POLICY = {
    signup: {
      open: true,
      minPasswordLength: 12,
      verificationTtlMinutes: 60,
      verificationResendCooldownSeconds: 0,
      verificationsPerHour: 50,
    },
    abuse: CEILINGS,
    legalDocuments: [],
    mfa: { customerEnrolmentEnabled: true, requiredForCustomers: false, recoveryCodeCount: 10 },
    steps: [],
  };

  function signupService(): SignupService {
    return new SignupService({
      prisma: app,
      email: { key: 'test', send: async () => ({ messageId: randomUUID() }) },
      verificationLink: () => 'https://example.test/verify',
    });
  }

  it('STOPS ACCOUNT CREATION from one source at the ceiling', async () => {
    const ip = freshIp();
    const service = signupService();
    const outcomes: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      outcomes.push(
        await service
          .signUp(POLICY, {
            email: `p4-signup-${randomUUID()}@example.test`,
            password: PASSWORD,
            name: 'phase four',
            locale: 'EN',
            timezone: 'UTC',
            acceptedDocuments: [],
            ip,
          })
          .then(() => 'created')
          .catch((error: unknown) => (isRateLimited(error) ? 'rate-limited' : 'other')),
      );
    }
    expect(outcomes).toEqual(['created', 'created', 'rate-limited']);
  });

  it('STOPS VERIFICATION RESENDS from one source, whatever address they name', async () => {
    const ip = freshIp();
    const service = signupService();
    const outcomes: string[] = [];
    // Three DIFFERENT addresses: the existing per-account cooldown cannot see
    // this, because the attacker chooses the account.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      outcomes.push(
        await service
          .resendVerification(POLICY, `p4-resend-${randomUUID()}@example.test`, { ip })
          .then(() => 'acknowledged')
          .catch((error: unknown) => (isRateLimited(error) ? 'rate-limited' : 'other')),
      );
    }
    expect(outcomes).toEqual(['acknowledged', 'acknowledged', 'rate-limited']);
  });
});

describe('the refusal carries the wait', () => {
  it('names how long to wait, and never which dimension tripped', async () => {
    const limiter = new AuthRateLimiter({ prisma: app });
    const subject = `retry-${randomUUID()}`;
    await limiter.record('signin:account', subject, 1, 600);
    const error = await limiter
      .enforce('signin:account', subject, 1, 600)
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(isRateLimited(error)).toBe(true);
    const retryAfter = (error as { publicDetails: { retryAfterSeconds?: number } }).publicDetails
      .retryAfterSeconds;
    expect(typeof retryAfter).toBe('number');
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(600);
    // The message names no address and no account: "too many attempts for THIS
    // address" would tell an attacker the address is worth attacking.
    expect(String((error as Error).message)).not.toContain(subject);
  });
});

describe('expired windows are discarded', () => {
  it('purges a window that has closed, and keeps one that has not', async () => {
    const limiter = new AuthRateLimiter({ prisma: app });
    await limiter.record('signin:ip', `stale-${randomUUID()}`, 10, 3_600);
    const live = await limiter.record('signin:ip', `live-${randomUUID()}`, 10, 3_600);
    void live;

    // Age ONE row past its own window rather than waiting an hour out. Selected
    // by id, so the test does not restate how a subject is hashed.
    const stale = await platform.authRateLimit.findFirstOrThrow({
      where: { scope: 'signin:ip' },
      orderBy: { createdAt: 'desc' },
      skip: 1,
      select: { id: true },
    });
    await platform.authRateLimit.update({
      where: { id: stale.id },
      data: { windowEnd: new Date(Date.now() - 3_600_000) },
    });

    await limiter.purgeExpired();

    expect(await platform.authRateLimit.findUnique({ where: { id: stale.id } })).toBeNull();
    // The window that is still open is untouched: a purge that took everything
    // would reset every attacker's count on every sweep.
    expect(
      await platform.authRateLimit.count({ where: { windowEnd: { gt: new Date() } } }),
    ).toBeGreaterThan(0);
  });
});

/**
 * A SPOOFED `X-Forwarded-For` MUST NOT BUY A FRESH BUDGET — Phase 4, review fix.
 *
 * WHY THIS IS HERE AND NOT ONLY IN THE UNIT TEST. The off-by-one that shipped in
 * `requestContext` was invisible to every assertion about `requestContext`,
 * because those assertions encoded the same wrong idea of what a proxy does. The
 * property that actually matters is not "the helper returns address X" — it is
 * "a caller who varies the header cannot get more attempts than the ceiling".
 * That is a statement about the HELPER AND THE LIMITER TOGETHER, against a real
 * database, so it is asserted here where both are real.
 *
 * THE HEADER IS BUILT THE WAY A PROXY BUILDS IT: the attacker's chosen value,
 * then the address our own load balancer appends because that is the peer that
 * connected to it.
 */
describe('a caller cannot mint identities with X-Forwarded-For', () => {
  const ONE_PROXY = { TRUSTED_PROXY_HOPS: '1' } as NodeJS.ProcessEnv;

  it('SPENDS ONE BUDGET however many addresses it claims', async () => {
    const target = await customer();
    const service = auth();
    // The real client, as our load balancer sees it. Constant, because it is.
    const realClient = freshIp();

    const outcomes: string[] = [];
    // One more attempt than the per-source ceiling allows, each with a
    // different spoofed value prepended.
    for (let attempt = 0; attempt <= CEILINGS.signInPerIp; attempt += 1) {
      const spoofed = `${attempt + 1}.${attempt + 1}.${attempt + 1}.${attempt + 1}`;
      const origin = requestContext({
        headers: { 'x-forwarded-for': `${spoofed}, ${realClient}` },
        socketAddress: '10.0.0.1',
        env: ONE_PROXY,
      });

      // The helper must have resolved the caller to the SAME subject each time.
      expect(origin.ip).toBe(realClient);

      outcomes.push(
        await service
          .signIn({ email: target.email, password: 'wrong-password', ip: origin.ip })
          .then(() => 'allowed')
          .catch((error: unknown) => (isRateLimited(error) ? 'rate-limited' : 'refused')),
      );
    }

    /*
     * THE ASSERTION THE DEFECT FAILS. With `chain.length - hops - 1` every
     * iteration resolved to its own spoofed value, so every attempt opened a
     * fresh per-source window and NOTHING was ever rate-limited — an unbounded
     * credential spray from one caller, which is exactly what the ceiling
     * exists to stop.
     */
    expect(outcomes).toContain('rate-limited');
    expect(outcomes.filter((outcome) => outcome === 'refused')).toHaveLength(CEILINGS.signInPerIp);
  });

  it('counts a DASHBOARD request, which has no socket address to fall back on', async () => {
    const target = await customer();
    const service = auth();
    const realClient = freshIp();

    /*
     * A Next.js server action passes headers and no transport peer. Under the
     * old index an ordinary one-entry chain looked too short, the fallback was
     * undefined, and `enforce` skips a dimension with no subject — so the one
     * path every customer browser takes was not rate limited at all.
     */
    const outcomes: string[] = [];
    for (let attempt = 0; attempt <= CEILINGS.signInPerIp; attempt += 1) {
      const origin = requestContext({
        headers: { 'x-forwarded-for': realClient },
        env: ONE_PROXY,
      });
      expect(origin.ip).toBe(realClient);

      outcomes.push(
        await service
          .signIn({ email: target.email, password: 'wrong-password', ip: origin.ip })
          .then(() => 'allowed')
          .catch((error: unknown) => (isRateLimited(error) ? 'rate-limited' : 'refused')),
      );
    }

    expect(outcomes).toContain('rate-limited');
  });

  it('gives two genuinely different clients their own budgets', async () => {
    // The other half of the rule: the fix must not collapse everyone onto the
    // proxy's address, which would rate-limit the whole world as one caller.
    const target = await customer();
    const service = auth();
    const first = freshIp();
    const second = freshIp();

    for (let attempt = 0; attempt < CEILINGS.signInPerIp; attempt += 1) {
      await service
        .signIn({
          email: target.email,
          password: 'wrong-password',
          ip: requestContext({
            headers: { 'x-forwarded-for': `9.9.9.9, ${first}` },
            env: ONE_PROXY,
          }).ip,
        })
        .catch(() => undefined);
    }

    // The first client is now spent. The second must be untouched.
    const secondOutcome = await service
      .signIn({
        email: target.email,
        password: 'wrong-password',
        ip: requestContext({
          headers: { 'x-forwarded-for': `9.9.9.9, ${second}` },
          env: ONE_PROXY,
        }).ip,
      })
      .then(() => 'allowed')
      .catch((error: unknown) => (isRateLimited(error) ? 'rate-limited' : 'refused'));

    expect(secondOutcome).toBe('refused');
  });
});

/**
 * PRODUCTION NEVER PROCEEDS WITHOUT A SOURCE BUDGET — Phase 4, review fix.
 *
 * THE VERIFIED LIVE STATE THIS ANSWERS. Neither `dashboard` nor `api` carried any
 * origin configuration in production. With none, `requestContext` establishes no
 * address, and `enforce` used to SKIP any dimension whose subject was undefined —
 * so every unauthenticated customer request ran with the per-account ceiling
 * alone and no per-source ceiling whatever. Nothing failed and nothing logged.
 *
 * THE INVARIANT, ASSERTED AGAINST THE REAL LIMITER AND A REAL DATABASE: an
 * unauthenticated request in production either has a trustworthy source identity
 * that is counted, or is refused. It never proceeds with no source budget.
 */
describe('in production a request with no establishable source is refused', () => {
  const REAL_APP_ENV = process.env['APP_ENV'];

  afterEach(() => {
    if (REAL_APP_ENV === undefined) delete process.env['APP_ENV'];
    else process.env['APP_ENV'] = REAL_APP_ENV;
  });

  it('REFUSES rather than silently skipping the source dimension', async () => {
    const target = await customer();
    const service = auth();

    // APP_ENV, never NODE_ENV (D-97).
    process.env['APP_ENV'] = 'production';

    const outcome = await service
      .signIn({ email: target.email, password: PASSWORD, ip: undefined })
      .then(() => 'allowed')
      .catch((error: unknown) => (isRateLimited(error) ? 'rate-limited' : 'refused'));

    /*
     * NOT 'allowed'. The password is CORRECT here on purpose: without the
     * refusal this sign-in succeeds, which is exactly the silent hole — a
     * production request completing with no per-source accounting at all.
     */
    expect(outcome).toBe('rate-limited');
  });

  it('still counts normally when an origin IS established in production', async () => {
    const target = await customer();
    const service = auth();
    process.env['APP_ENV'] = 'production';

    const origin = requestContext({
      headers: { 'x-forwarded-for': freshIp() },
      env: { CLIENT_ORIGIN_STRATEGY: 'railway-edge' } as NodeJS.ProcessEnv,
    });

    const outcome = await service
      .signIn({ email: target.email, password: PASSWORD, ip: origin.ip })
      .then(() => 'allowed')
      .catch((error: unknown) => (isRateLimited(error) ? 'rate-limited' : 'refused'));

    // The refusal must be narrow: a correctly configured deployment is unaffected.
    expect(outcome).toBe('allowed');
  });

  it('REFUSES a railway-edge request whose XFF is missing, rather than using the proxy peer', async () => {
    const target = await customer();
    const service = auth();
    process.env['APP_ENV'] = 'production';

    /*
     * THE WHOLE PATH, END TO END. A request arrives at the API with no
     * `X-Forwarded-For` — it did not come through Railway's edge — but WITH a
     * transport peer, which behind the edge is infrastructure rather than a
     * customer. `requestContext` must not hand that peer over as an identity,
     * because doing so would give every unrelated customer one shared
     * rate-limit subject; and the limiter must then refuse rather than proceed.
     */
    const origin = requestContext({
      headers: {},
      socketAddress: '100.64.0.7', // a Railway-internal address, not a customer
      env: { CLIENT_ORIGIN_STRATEGY: 'railway-edge' } as NodeJS.ProcessEnv,
    });
    expect(origin.ip).toBeUndefined();

    const outcome = await service
      .signIn({ email: target.email, password: PASSWORD, ip: origin.ip })
      .then(() => 'allowed')
      .catch((error: unknown) => (isRateLimited(error) ? 'rate-limited' : 'refused'));

    // The password is CORRECT on purpose: without the refusal this succeeds.
    expect(outcome).toBe('rate-limited');
  });

  it('OUTSIDE production it warns and skips, so a laptop still signs in', async () => {
    const target = await customer();
    const service = auth();
    process.env['APP_ENV'] = 'development';

    const outcome = await service
      .signIn({ email: target.email, password: PASSWORD, ip: undefined })
      .then(() => 'allowed')
      .catch((error: unknown) => (isRateLimited(error) ? 'rate-limited' : 'refused'));

    // A developer has no proxy and no forwarded header. Refusing every local
    // sign-in would make this guard the first thing anybody turned off.
    expect(outcome).toBe('allowed');
  });
});
