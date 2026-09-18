/**
 * Activate a MOCK AI configuration, for development and end-to-end runs only.
 *
 * WHAT PROBLEM THIS SOLVES. The AI Gateway is configuration-driven by design:
 * without an active routing rule for a task it raises `RoutingError`, which the
 * API correctly turns into a 500 and the chat panel correctly turns into "that
 * request could not be completed". That is right in production — an operator
 * has not finished configuring the platform — and useless in development, where
 * it means Brand Brain chat has never once been seen to work end to end. A
 * customer-facing capability that only exists in unit tests is not delivered.
 *
 * WHAT IT DOES NOT DO.
 *   - It does not activate a REAL provider. The only provider it writes is
 *     `mock`, whose `apiKeySecretRef` is null and whose base URL resolves
 *     nowhere. D-13 approved the provider architecture and deferred vendor
 *     selection; choosing one here would be making the decision D-13 withheld.
 *   - It does not weaken any production validation. It writes a draft and
 *     activates it through `ConfigurationService`, which runs the same schema
 *     parse, the same cross-domain semantic validation and the same D-13
 *     eligibility gates as an activation from Platform Admin. Nothing is
 *     inserted behind the service's back.
 *   - It does not run anywhere that looks like production. Two independent
 *     guards below, and both must pass.
 *
 * Idempotent: re-running it activates a fresh version of the same payload.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { ConfigurationService, type ConfigActor, type Environment } from '@brandspace/config';
import { CreditLedgerService } from '@brandspace/entitlements';
import { SecretService } from '@brandspace/secrets';
import { randomBytes } from 'node:crypto';
import { loadE2eEnv } from './env';

loadE2eEnv();

const ENVIRONMENT: Environment = 'DEVELOPMENT';
const PROVIDER_KEY = 'mock';
/**
 * Where the mock provider's placeholder credential is stored.
 *
 * THE MOCK NEEDS NO CREDENTIAL — it is a function call in this process, and
 * `apps/api` hands the gateway a resolver that returns null for every provider.
 * It exists because `validateConfiguration` refuses to activate a provider in
 * `active` status without one, and that rule is RIGHT: weakening it, or
 * downgrading the provider to a status routing would not use, would trade a
 * real production safeguard for a development convenience.
 *
 * So the seed satisfies the rule honestly. The value is generated here, is
 * never printed, is stored through the Secret Service exactly as a real
 * enrolment would be, and is not a credential to anything: no service accepts
 * it, and nothing resolves it.
 */
const MOCK_SECRET_REF = 'ai-provider/mock/development/api-key';
const MODEL_KEY = 'mock-fast';
const TASK_KEY = 'copilot.chat';

/**
 * The AI Creative Studio's model and task — Phase 8.
 *
 * A SEPARATE MODEL, because the modality is different and a model declares
 * exactly one. Routing is per-task by design, so the Studio gets its own rule,
 * its own cost basis and its own credit price — an operator has to be able to
 * serve images from a different model than captions, and a seed that collapsed
 * the two would make that distinction untestable.
 *
 * `image.generate` IS MVP-APPROVED (D-16); `video.generate` and
 * `voice.synthesize` are not, and nothing here activates either.
 */
const IMAGE_MODEL_KEY = 'mock-image';
const IMAGE_TASK_KEY = 'image.generate';

/**
 * The reasoning tasks the Phase 8 journey passes through.
 *
 * ALL THREE SHARE THE TEXT MODEL and get their own rule, because routing is
 * per-task by design: an operator has to be able to serve a strategy from a
 * different model than a caption, and a seed that collapsed them would make
 * that distinction untestable. Without a rule the gateway raises a routing
 * error and the screen shows an INTERNAL failure — which is right in production
 * (an operator has not finished configuring the platform) and useless in a run
 * that is meant to prove the path.
 */
const REASONING_TASK_KEYS = ['strategy.generate', 'plan.monthly', 'analytics.explain'] as const;

/**
 * The Content Studio's task.
 *
 * A SECOND TASK RATHER THAN A REUSE OF `copilot.chat`, because routing is
 * per-task by design: an operator has to be able to serve captions from a
 * different model than chat, and a seed that collapsed the two would make that
 * distinction untestable. Its rule, its cost and its parameters are separate
 * below for the same reason.
 */
const CONTENT_TASK_KEY = 'caption.generate';

/** Enough for a long session of development chat; refilled by re-running. */
const DEVELOPMENT_CREDIT_GRANT = 5_000;

const REASON = 'Development seed: mock AI routing so Brand Brain chat can be exercised locally.';

function assertNotProduction(): void {
  if (process.env['APP_ENV'] === 'production' || process.env['NODE_ENV'] === 'production') {
    throw new Error('Refusing to activate a mock AI configuration in a production environment.');
  }
  const url = process.env['DATABASE_PLATFORM_URL'] ?? '';
  // A second, independent guard: the environment variables say what this
  // process thinks it is, and the connection string says where it is pointed.
  // Both have to look local before anything is written.
  if (!/@(localhost|127\.0\.0\.1|db|postgres)[:/]/.test(url)) {
    throw new Error(
      'Refusing to activate a mock AI configuration against a non-local database. ' +
        '(The connection string is deliberately not shown.)',
    );
  }
}

function platformClient(): PrismaClient {
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

/**
 * The seed's platform actor.
 *
 * A real `platform_user` row, because `configuration_version` has a foreign key
 * to it and the audit trail must point at something. The seed creates the
 * Platform Owner; this reuses whoever that is rather than inventing an identity.
 */
async function actorFor(prisma: PrismaClient): Promise<ConfigActor> {
  const owner = await prisma.platformUser.findFirst({
    where: { deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true, roleId: true },
  });
  if (!owner) {
    throw new Error('No platform user exists. Run the database seed first (pnpm db:seed).');
  }

  // The account's REAL permissions, read back from the role it was given —
  // never a list written here. A seed that granted itself permissions would be
  // exercising a path production does not have.
  const grants = await prisma.rolePermission.findMany({
    where: { roleId: owner.roleId },
    include: { permission: true },
  });

  return {
    platformUserId: owner.id,
    roleKey: 'platform_owner',
    mfaVerified: true,
    permissionKeys: grants.map((grant) => grant.permission.key),
  };
}

const PAYLOADS = {
  'ai.providers': {
    providers: [
      {
        key: PROVIDER_KEY,
        name: 'Mock provider (development only)',
        // Reserved by RFC 2606 and guaranteed never to resolve. The mock
        // adapter answers in process and never opens a connection; this is
        // here because the schema requires a URL, and it is one that cannot
        // accidentally reach anything.
        baseUrl: 'https://mock.invalid',
        // A REFERENCE, never a key value — see MOCK_SECRET_REF above for why a
        // placeholder exists at all and what it is not.
        apiKeySecretRef: MOCK_SECRET_REF,
        status: 'active',
        timeoutMs: 30_000,
        maxConcurrency: 8,
        // The D-13 gates, answered honestly for a provider that is a function
        // call in this process: it trains on nothing and retains nothing.
        noTrainingGuarantee: true,
        dataRetentionPolicy: 'zero_retention',
        privacyReviewRef: 'in-process mock adapter; no data leaves the process',
      },
    ],
  },
  'ai.models': {
    models: [
      {
        key: MODEL_KEY,
        providerKey: PROVIDER_KEY,
        displayName: 'Mock fast (development only)',
        modality: 'text',
        qualityTier: 'fast',
        /*
         * BETA, NOT `available`, AND THAT IS D-17 BEING OBEYED RATHER THAN
         * WORKED AROUND.
         *
         * A generally-available model must carry an Arabic quality benchmark
         * reference. This model has not passed one and never will — it is a
         * hash function, not a language model — so claiming general
         * availability would be a false record in the platform's own quality
         * evidence. D-17 names `beta` as the status for a model under
         * evaluation, and routing serves a beta model, so the development path
         * works without a single validation rule being relaxed.
         */
        status: 'beta',
        disableSwitch: false,
        // A cost basis so margin arithmetic has real numbers to work on. These
        // are not a vendor's rates — there is no vendor — and no commercial
        // decision is implied by them.
        inputCostPerUnitMicroMinor: 15_000,
        outputCostPerUnitMicroMinor: 60_000,
        costUnit: '1k_tokens',
        costCurrency: 'USD',
        qualityBenchmarkRef: null,
      },
      {
        key: IMAGE_MODEL_KEY,
        providerKey: PROVIDER_KEY,
        displayName: 'Mock image (development only)',
        modality: 'image',
        qualityTier: 'balanced',
        /*
         * `beta` FOR THE SAME REASON THE TEXT MODEL IS. D-17's gate is on
         * `available`, which is the status that puts customer traffic on a
         * model; this one is a deterministic PNG encoder and will never pass an
         * Arabic marketing benchmark because there is nothing to benchmark.
         * Claiming general availability would be a false record in the
         * platform's own quality evidence.
         */
        status: 'beta',
        disableSwitch: false,
        // Priced per image rather than per token, because that is the unit the
        // work comes in. No vendor's rates are implied; there is no vendor.
        inputCostPerUnitMicroMinor: 0,
        outputCostPerUnitMicroMinor: 40_000,
        costUnit: 'image',
        costCurrency: 'USD',
        qualityBenchmarkRef: null,
      },
    ],
  },
  'ai.routing': {
    rules: [
      {
        taskKey: TASK_KEY,
        scope: 'global',
        planKey: null,
        workspaceId: null,
        primaryModelKey: MODEL_KEY,
        fallbackModelKeys: [],
        timeoutMs: 10_000,
        maxCostPerRequestMinor: null,
        priority: 0,
        parameters: {
          temperature: 0.3,
          maxOutputTokens: 400,
          promptTemplateVersion: 1,
          /*
           * OFF, AND THIS IS D-78 RATHER THAN A TUNING CHOICE.
           *
           * Brand Brain chat owns its artifact: the answer lives in
           * `brand_brain_message` under the retention window the `brand-brain`
           * configuration sets. Asking the gateway to persist it too would make
           * the gateway a second content store, which D-78 forbids in as many
           * words — so there is no window to set here either.
           */
          persistOutput: false,
          outputRetentionDays: null,
        },
        retryPolicy: { maxAttempts: 1, backoff: 'none', initialDelayMs: 0, jitter: false },
        moderateInput: false,
        moderationModelKey: null,
      },
      {
        taskKey: CONTENT_TASK_KEY,
        scope: 'global',
        planKey: null,
        workspaceId: null,
        primaryModelKey: MODEL_KEY,
        fallbackModelKeys: [],
        timeoutMs: 10_000,
        maxCostPerRequestMinor: null,
        priority: 0,
        parameters: {
          temperature: 0.6,
          maxOutputTokens: 900,
          promptTemplateVersion: 1,
          /*
           * OFF, and D-78 again. The Content Studio owns its artifact: the
           * caption lives in `content_variant` under the D-116/D-117 window.
           * Asking the gateway to persist it too would make the gateway a
           * second content store — and a second retention owner for the same
           * text, which is exactly what the F-73 registry exists to prevent.
           */
          persistOutput: false,
          outputRetentionDays: null,
        },
        retryPolicy: { maxAttempts: 1, backoff: 'none', initialDelayMs: 0, jitter: false },
        moderateInput: false,
        moderationModelKey: null,
      },
      ...REASONING_TASK_KEYS.map((taskKey) => ({
        taskKey,
        scope: 'global' as const,
        planKey: null,
        workspaceId: null,
        primaryModelKey: MODEL_KEY,
        fallbackModelKeys: [],
        timeoutMs: 20_000,
        maxCostPerRequestMinor: null,
        priority: 0,
        parameters: {
          temperature: 0.4,
          maxOutputTokens: 900,
          promptTemplateVersion: 1,
          // D-78 again: the insight row owns the document, with its own
          // retention. The gateway is not a second content store.
          persistOutput: false,
          outputRetentionDays: null,
        },
        retryPolicy: { maxAttempts: 1, backoff: 'none' as const, initialDelayMs: 0, jitter: false },
        moderateInput: false,
        moderationModelKey: null,
      })),
      {
        taskKey: IMAGE_TASK_KEY,
        scope: 'global',
        planKey: null,
        workspaceId: null,
        primaryModelKey: IMAGE_MODEL_KEY,
        fallbackModelKeys: [],
        timeoutMs: 30_000,
        maxCostPerRequestMinor: null,
        priority: 0,
        parameters: {
          temperature: 0.4,
          maxOutputTokens: 256,
          promptTemplateVersion: 1,
          /*
           * OFF, and D-78 a third time — with a consequence the other two do
           * not have. The ASSET LIBRARY owns the generated image: its bytes,
           * its versions, its virus scan and its retention. Asking the gateway
           * to keep a copy would make it a second media store.
           *
           * SO A GATEWAY REPLAY CARRIES NO BYTES, which is why the Creative
           * Studio looks for the asset its own idempotency key already produced
           * BEFORE asking the gateway, and again after a replay.
           */
          persistOutput: false,
          outputRetentionDays: null,
        },
        retryPolicy: { maxAttempts: 1, backoff: 'none', initialDelayMs: 0, jitter: false },
        moderateInput: false,
        moderationModelKey: null,
      },
    ],
  },
  /*
   * THE BRAND BRAIN DEFAULTS, ACTIVATED EXPLICITLY.
   *
   * An empty payload, so every value is the schema's own. It is activated
   * rather than left unset for two reasons: it populates the tenant-readable
   * projection, so development and the end-to-end suite exercise the path
   * production takes rather than the "nothing activated yet" fallback; and it
   * gives the environment a KNOWN policy, so a run is not silently inheriting
   * whatever the last test to activate a version happened to set.
   */
  'brand-brain': {},
  /*
   * THE CONTENT STUDIO DEFAULTS, ACTIVATED EXPLICITLY.
   *
   * An empty payload, so every dialect, channel, limit and retention window is
   * the schema's own — and activated rather than left unset so the tenant
   * projection exists and the dashboard exercises the path production takes
   * rather than the "nothing activated yet" fallback.
   */
  content: {
    /*
     * TWO OPERATOR SETTINGS THE END-TO-END FLOW NEEDS, both legal values of
     * the shipped schema rather than a relaxation of any rule.
     *
     * `minLeadMinutes: 0` lets the functional journey schedule a post for NOW
     * and watch the pipeline pick it up. The default of five minutes is a
     * sensible product default and a five-minute wait inside a browser test;
     * zero is what a customer who wants to publish immediately would set, and
     * the schema allows it (`min(0)`).
     *
     * Everything else stays the schema's own.
     */
    calendar: { minLeadMinutes: 0 },
  },
  /*
   * THE MAINTENANCE CADENCE, TIGHTENED FOR A TEST RUN — an operator's number
   * (CLAUDE.md §2.2), not a constant, and five seconds is the schema's own
   * floor rather than a value invented here.
   *
   * WHY IT MATTERS. Dispatch is an optimisation and the reconciliation sweep is
   * the correctness path: a scheduled slot becomes a publish job when the sweep
   * notices it is due. At the default thirty seconds the functional journey
   * would spend most of its time waiting for a timer; at five it waits for the
   * product. NOTHING ABOUT THE PATH CHANGES — the same sweep, the same claim,
   * the same job.
   */
  operations: {
    maintenance: { ingestionReconcileSeconds: 5 },
  },
  'ai.credit-rules': {
    costs: [
      {
        taskKey: TASK_KEY,
        modelKey: MODEL_KEY,
        baseMilliCredits: 100,
        perUnitMilliCredits: 50,
        unit: '1k_tokens',
      },
      {
        taskKey: CONTENT_TASK_KEY,
        modelKey: MODEL_KEY,
        baseMilliCredits: 250,
        perUnitMilliCredits: 90,
        unit: '1k_tokens',
      },
      ...REASONING_TASK_KEYS.map((taskKey) => ({
        taskKey,
        modelKey: MODEL_KEY,
        baseMilliCredits: 300,
        perUnitMilliCredits: 90,
        unit: '1k_tokens' as const,
      })),
      {
        // Priced per IMAGE, flat: the unit of work is the picture, and a
        // per-token price for something with no tokens would be arithmetic
        // dressed up as a policy.
        taskKey: IMAGE_TASK_KEY,
        modelKey: IMAGE_MODEL_KEY,
        baseMilliCredits: 400,
        perUnitMilliCredits: 0,
        unit: 'image',
      },
    ],
  },
} as const;

async function activate(
  configuration: ConfigurationService,
  actor: ConfigActor,
  domain: keyof typeof PAYLOADS,
): Promise<void> {
  const draft = await configuration.createDraft(
    actor,
    domain,
    ENVIRONMENT,
    REASON,
    PAYLOADS[domain],
  );
  // The SAME validation an activation from Platform Admin runs. A payload that
  // would be refused there is refused here.
  const report = await configuration.validateDraft(actor, draft.id);
  if (!report.valid) {
    throw new Error(
      `Mock ${domain} configuration failed validation: ${report.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  await configuration.activate(actor, draft.id, { acknowledgeHighImpact: true });
  console.log(`  activated ${domain} v${draft.versionNumber}`);
}

/**
 * Credits for the seeded workspaces.
 *
 * A chat turn reserves credits before it calls the gateway, so a workspace with
 * an empty wallet is refused for lack of funds — which looks, on the screen,
 * exactly like the failure this script exists to remove.
 */
async function grantDevelopmentCredits(prisma: PrismaClient): Promise<void> {
  const ledger = new CreditLedgerService({ prisma });
  const workspaces = await prisma.workspace.findMany({ select: { id: true, slug: true } });
  for (const workspace of workspaces) {
    await prisma.creditWallet.upsert({
      where: { workspaceId: workspace.id },
      create: { workspaceId: workspace.id },
      update: {},
    });
    await ledger.grant({
      workspaceId: workspace.id,
      source: 'PROMOTIONAL_GRANT',
      credits: DEVELOPMENT_CREDIT_GRANT,
      reason: 'Development seed allowance',
      // Stable, so re-running the seed does not keep topping the wallet up.
      idempotencyKey: `dev-seed-grant:${workspace.id}`,
    });
    console.log(`  ${workspace.slug}: development credit allowance ensured`);
  }
}

/**
 * Store the mock provider's placeholder credential, through the real service.
 *
 * Generated here, never printed, never committed, and not a credential to
 * anything. Idempotent: an existing record is rotated rather than duplicated.
 */
async function ensureMockSecret(prisma: PrismaClient, actor: ConfigActor): Promise<void> {
  const secrets = new SecretService({ prisma });
  const value = `mock-${randomBytes(24).toString('hex')}`;

  const existing = await prisma.secretRecord.findUnique({
    where: { ref_environment: { ref: MOCK_SECRET_REF, environment: ENVIRONMENT } },
  });
  if (existing) {
    if (existing.status !== 'ACTIVE') {
      await secrets.enableSecret(
        actor,
        existing.id,
        'Re-enabled for the development mock provider',
      );
    }
    await secrets.rotateSecret(actor, existing.id, value, 'Development seed re-run');
    return;
  }
  await secrets.createSecret(actor, {
    ref: MOCK_SECRET_REF,
    name: 'Mock AI provider placeholder',
    category: 'ai_provider',
    environment: ENVIRONMENT,
    value,
    description: 'Generated for development. Not a credential to any real service.',
  });
}

async function main(): Promise<void> {
  assertNotProduction();

  const prisma = platformClient();
  try {
    const actor = await actorFor(prisma);
    const configuration = new ConfigurationService({ prisma, cacheTtlMs: 0 });

    console.log('› storing the mock provider placeholder credential …');
    await ensureMockSecret(prisma, actor);

    console.log('› activating mock AI configuration (development only) …');
    for (const domain of Object.keys(PAYLOADS) as Array<keyof typeof PAYLOADS>) {
      await activate(configuration, actor, domain);
    }

    console.log('› ensuring development credit allowances …');
    await grantDevelopmentCredits(prisma);

    console.log('\n✔ mock AI configuration active');
    console.log(`  ${TASK_KEY} → ${MODEL_KEY} (provider "${PROVIDER_KEY}", no credential)`);
    console.log(`  ${CONTENT_TASK_KEY} → ${MODEL_KEY}`);
    console.log(`  ${IMAGE_TASK_KEY} → ${IMAGE_MODEL_KEY}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
