import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CUSTOMER_REALM,
  CustomerAuthService,
  OutboxEmailProvider,
  SignupService,
} from '@brandspace/auth';
import { getPrisma } from '@brandspace/database';
import { AppError } from '@brandspace/shared';
import { route } from '../route-contract';
import { fail, sessionTokenFrom } from './phase7-context';
import { onboardingPolicy } from './phase9-context';

/**
 * Signup, email verification and customer MFA (§10, §11).
 *
 * PUBLIC BY NECESSITY, NOT BY OVERSIGHT. A person signing up has no session,
 * which is what `scope: 'public'` records. What protects these routes instead:
 * every response is uninformative about whether an address exists, every token
 * is single-use and expiring, and every rate limit and ceiling comes from the
 * activated `onboarding` document rather than from a constant here.
 *
 * THE MFA ROUTES ARE NOT PUBLIC. Enrolling, confirming and disabling a second
 * factor all require a resolved session — and disabling additionally requires a
 * working code, because a stolen cookie must not be enough to remove the
 * protection that cookie was supposed to be behind.
 */

const signupSchema = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(512),
  name: z.string().min(1).max(120),
  locale: z.enum(['AR', 'EN']),
  /** NO DEFAULT (D-194). The form asks; this refuses an empty answer. */
  timezone: z.string().min(1).max(64),
  acceptedDocuments: z
    .array(z.object({ key: z.string().min(1).max(64), version: z.string().min(1).max(32) }))
    .max(20)
    .default([]),
});

const emailOnlySchema = z.object({ email: z.string().min(3).max(320) });
const tokenSchema = z.object({ token: z.string().min(10).max(512) });
const codeSchema = z.object({ code: z.string().min(4).max(32) });

function ipOf(req: FastifyRequest): string | undefined {
  return req.ip || undefined;
}

function userAgentOf(req: FastifyRequest): string | undefined {
  const value = req.headers['user-agent'];
  return typeof value === 'string' ? value.slice(0, 512) : undefined;
}

function signupService(): SignupService {
  const prisma = getPrisma();
  return new SignupService({
    prisma,
    email: new OutboxEmailProvider(prisma),
    verificationLink: (token, locale) => {
      const base = process.env['PUBLIC_DASHBOARD_BASE_URL'];
      if (!base) {
        throw new AppError(
          'INTERNAL',
          'PUBLIC_DASHBOARD_BASE_URL is required to build a verification link.',
        );
      }
      // The locale is in the path because the link is followed OUTSIDE the
      // product, from an inbox, where no session carries a preference.
      return `${base.replace(/\/+$/, '')}/${locale.toLowerCase()}/verify?token=${encodeURIComponent(token)}`;
    },
  });
}

export function registerAccountRoutes(app: FastifyInstance): void {
  /**
   * Create an account.
   *
   * ALWAYS THE SAME ACKNOWLEDGEMENT. A free address gets a verification link; a
   * taken one gets a "you already have an account" notice. The caller cannot
   * tell which was sent, so neither can somebody enumerating addresses (§10).
   */
  route(
    app,
    'POST',
    '/v1/account/signup',
    { scope: 'public', idempotent: false, rateLimit: 'signup' },
    async (req, reply) => {
      const parsed = signupSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });
      try {
        const policy = await onboardingPolicy();
        await signupService().signUp(policy, {
          ...parsed.data,
          ip: ipOf(req),
          userAgent: userAgentOf(req),
        });
        return await reply.send({ acknowledged: true });
      } catch (error: unknown) {
        return fail(reply, 'account.signup', error);
      }
    },
  );

  /**
   * The rules the signup form must state as it asks.
   *
   * SERVED FROM CONFIGURATION so the form cannot carry its own copy. A password
   * minimum restated in a component is a minimum the owner cannot change, and a
   * terms version restated there is one nobody re-asks about when it is
   * republished.
   */
  route(app, 'GET', '/v1/account/signup/policy', { scope: 'public' }, async (_req, reply) => {
    try {
      const policy = await onboardingPolicy();
      return await reply.send({
        open: policy.signup.open,
        minPasswordLength: policy.signup.minPasswordLength,
        legalDocuments: policy.legalDocuments.map((doc) => ({
          key: doc.key,
          title: doc.title,
          version: doc.version,
          url: doc.url,
          required: doc.required,
        })),
        mfaAvailable: policy.mfa.customerEnrolmentEnabled,
      });
    } catch (error: unknown) {
      return fail(reply, 'account.signup.policy', error);
    }
  });

  /** Follow the link. Single-use; a second click is indistinguishable from expiry. */
  route(
    app,
    'POST',
    '/v1/account/verify',
    { scope: 'public', idempotent: true },
    async (req, reply) => {
      const parsed = tokenSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });
      try {
        const result = await signupService().verifyEmail(parsed.data.token, { ip: ipOf(req) });
        if (!result) {
          // One answer for unknown, expired and already-used. Which of the three
          // it was is not something a caller needs, and telling them turns this
          // into a token oracle.
          return await reply.code(400).send({ error: { code: 'VALIDATION_FAILED' } });
        }
        return await reply.send({ verified: true });
      } catch (error: unknown) {
        return fail(reply, 'account.verify', error);
      }
    },
  );

  /** Send another link. Rate-limited, and silent about whether it did. */
  route(
    app,
    'POST',
    '/v1/account/verify/resend',
    { scope: 'public', idempotent: true, rateLimit: 'signup' },
    async (req, reply) => {
      const parsed = emailOnlySchema.safeParse(req.body);
      if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });
      try {
        const policy = await onboardingPolicy();
        await signupService().resendVerification(policy, parsed.data.email, { ip: ipOf(req) });
        return await reply.send({ acknowledged: true });
      } catch (error: unknown) {
        return fail(reply, 'account.verify.resend', error);
      }
    },
  );

  /**
   * Present a second factor for a session that owes one.
   *
   * PUBLIC SCOPE because the session it completes does not yet resolve — that is
   * the entire point of the step. The token is still required and still checked;
   * what it does not yet grant is access.
   */
  route(
    app,
    'POST',
    '/v1/account/mfa/challenge',
    { scope: 'public', idempotent: false },
    async (req, reply) => {
      const parsed = codeSchema.safeParse(req.body);
      const token = sessionTokenFrom(req);
      if (!parsed.success || !token) {
        return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
      }
      try {
        const prisma = getPrisma();
        const auth = new CustomerAuthService({ prisma });
        const signup = signupService();
        await auth.completeMfa({
          token,
          code: parsed.data.code,
          ip: ipOf(req),
          verify: (userId, code) => signup.verifyMfa(userId, code),
        });
        return await reply.send({ verified: true });
      } catch (error: unknown) {
        return fail(reply, 'account.mfa.challenge', error);
      }
    },
  );

  /**
   * Begin enrolment.
   *
   * The response carries the otpauth URI, which CONTAINS the seed. It is
   * returned once, to the enrolling session, and never logged or persisted in
   * clear.
   */
  route(
    app,
    'POST',
    '/v1/account/mfa/enrol',
    { scope: 'workspace', permission: 'workspace.read', confirmation: 'required' },
    async (req, reply) => {
      const user = await resolveUser(req, reply);
      if (!user) return;
      try {
        const policy = await onboardingPolicy();
        const enrolment = await signupService().beginMfaEnrolment(policy, user);
        return await reply.send(enrolment);
      } catch (error: unknown) {
        return fail(reply, 'account.mfa.enrol', error);
      }
    },
  );

  /** Confirm with a live code, and receive the recovery codes — once. */
  route(
    app,
    'POST',
    '/v1/account/mfa/enrol/confirm',
    { scope: 'workspace', permission: 'workspace.read', confirmation: 'required' },
    async (req, reply) => {
      const user = await resolveUser(req, reply);
      if (!user) return;
      const parsed = codeSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });
      try {
        const policy = await onboardingPolicy();
        const result = await signupService().confirmMfaEnrolment(policy, user, parsed.data.code);
        return await reply.send(result);
      } catch (error: unknown) {
        return fail(reply, 'account.mfa.confirm', error);
      }
    },
  );

  /** Turn it off. Requires a working code, not merely a session. */
  route(
    app,
    'POST',
    '/v1/account/mfa/disable',
    { scope: 'workspace', permission: 'workspace.read', confirmation: 'required' },
    async (req, reply) => {
      const user = await resolveUser(req, reply);
      if (!user) return;
      const parsed = codeSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });
      try {
        await signupService().disableMfa(user, parsed.data.code);
        return await reply.send({ disabled: true });
      } catch (error: unknown) {
        return fail(reply, 'account.mfa.disable', error);
      }
    },
  );
}

/**
 * The signed-in person, WITHOUT requiring a workspace.
 *
 * `resolveCaller` binds to an active workspace and a permission, which is right
 * for everything that touches tenant data. MFA is a property of the PERSON: they
 * may have no workspace yet, or several, and their second factor is neither
 * workspace's business.
 */
async function resolveUser(
  req: FastifyRequest,
  reply: Parameters<typeof fail>[0],
): Promise<string | null> {
  const token = sessionTokenFrom(req);
  if (!token) {
    await reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    return null;
  }
  const auth = new CustomerAuthService({ prisma: getPrisma() });
  const customer = await auth.resolve(token).catch(() => null);
  if (!customer) {
    await reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    return null;
  }
  return customer.userId;
}

export { CUSTOMER_REALM };
