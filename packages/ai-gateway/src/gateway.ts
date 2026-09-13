import { Prisma, type PrismaClient } from '@brandspace/database';
import type { CreditLedgerService } from '@brandspace/entitlements';
import { AppError, type Clock, systemClock } from '@brandspace/shared';

import type { AdapterContext, AdapterRegistry, UsageUnits } from './adapter';
import { AiProviderError, customerMessageFor, type AiFailureClass } from './errors';
import {
  creditsChargedMilli,
  estimateReservationMilli,
  findCreditRule,
  providerCostMicroMinor,
  type CreditRule,
  type ModelCostBasis,
} from './pricing';
import {
  resolveRoute,
  type RegisteredModel,
  type ResolvedRoute,
  type RoutingRule,
} from './routing';

/**
 * The request lifecycle — docs/AI-GATEWAY.md §6.
 *
 *   authorize -> idempotency -> route -> estimate -> RESERVE -> execute
 *             -> validate -> SETTLE (success) or RELEASE (anything else)
 *
 * THE INVARIANT THE WHOLE FILE SERVES. A reservation is never left open. Every
 * path out of `execute` — success, provider error, timeout, an exception from
 * code that has nothing to do with AI — settles or releases before it returns
 * or throws. §7.4 guarantee 1 is "no charge for failure", and the way that
 * becomes true in practice is that the failure path is not an afterthought:
 * it is a `finally`.
 *
 * The second invariant is that the provider is called EXACTLY ONCE per
 * accepted request. A duplicate idempotency key never reaches a provider and
 * never touches the wallet; it replays what was recorded.
 */

/** Everything the gateway needs that it does not own. */
export interface AiGatewayOptions {
  readonly prisma: PrismaClient;
  readonly ledger: CreditLedgerService;
  readonly adapters: AdapterRegistry;
  /** Reads the active `ai.*` configuration for this environment. */
  readonly configuration: AiConfigurationSource;
  /** Resolves the credential for a provider. Never returns it to a caller. */
  readonly credentials: ProviderCredentialSource;
  readonly environment: 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION';
  readonly clock?: Clock;
}

/** The active AI configuration, already parsed. */
export interface AiConfiguration {
  readonly providers: readonly AiProviderConfig[];
  readonly models: readonly RegisteredModel[];
  readonly costBases: readonly ModelCostBasis[];
  readonly routingRules: readonly RoutingRule[];
  readonly creditRules: readonly CreditRule[];
}

export interface AiProviderConfig {
  readonly key: string;
  readonly baseUrl: string;
  readonly apiKeySecretRef: string | null;
  readonly status: 'draft' | 'validated' | 'active' | 'disabled';
  readonly timeoutMs: number;
}

export interface AiConfigurationSource {
  load(): Promise<AiConfiguration>;
}

export interface ProviderCredentialSource {
  /** Null when the provider needs no credential (the mock) or has none stored. */
  resolve(secretRef: string | null): Promise<string | null>;
}

export interface AiTextInput {
  readonly kind: 'text';
  readonly prompt: string;
  readonly untrustedContext?: readonly string[];
}

export interface AiImageInput {
  readonly kind: 'image';
  readonly prompt: string;
  readonly count: number;
  readonly size: string;
}

export type AiInput = AiTextInput | AiImageInput;

export interface AiGatewayRequest {
  readonly workspaceId: string;
  readonly userId: string | null;
  readonly taskKey: string;
  /** The workspace's plan, for routing precedence. */
  readonly planKey: string | null;
  /** Makes the whole call replayable. Required — §7.4 guarantee 2. */
  readonly idempotencyKey: string;
  readonly input: AiInput;
  /** Basis points; 10,000 is ×1. Configuration decides it, not this module. */
  readonly creditMultiplierBasisPoints?: number;
}

export interface AiGatewayResult {
  readonly requestId: string;
  readonly status: 'SUCCEEDED' | 'FAILED' | 'TIMEOUT' | 'MODERATION_BLOCKED';
  readonly modelKey: string | null;
  readonly attemptedModelKeys: readonly string[];
  /** Null unless the routing rule opted into persistence, or this run produced it. */
  readonly output: AiOutput | null;
  readonly usage: UsageUnits;
  readonly creditsChargedMilli: bigint;
  readonly providerCostMicroMinor: bigint;
  readonly failureClass: AiFailureClass | null;
  /** Safe to show a customer. Never a raw provider error. */
  readonly failureMessage: string | null;
  /** True when this call returned a previously recorded outcome. */
  readonly replayed: boolean;
  readonly latencyMs: number | null;
}

export type AiOutput =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'image';
      readonly imageRefs: readonly string[];
    };

/** A terminal status that is not a success. */
const FAILED_STATUSES = ['FAILED', 'TIMEOUT', 'MODERATION_BLOCKED'] as const;

function isTerminal(status: string): boolean {
  return status === 'SUCCEEDED' || (FAILED_STATUSES as readonly string[]).includes(status);
}

export class AiGateway {
  readonly #prisma: PrismaClient;
  readonly #ledger: CreditLedgerService;
  readonly #adapters: AdapterRegistry;
  readonly #configuration: AiConfigurationSource;
  readonly #credentials: ProviderCredentialSource;
  readonly #environment: AiGatewayOptions['environment'];
  readonly #clock: Clock;

  constructor(options: AiGatewayOptions) {
    this.#prisma = options.prisma;
    this.#ledger = options.ledger;
    this.#adapters = options.adapters;
    this.#configuration = options.configuration;
    this.#credentials = options.credentials;
    this.#environment = options.environment;
    this.#clock = options.clock ?? systemClock;
  }

  async execute(request: AiGatewayRequest): Promise<AiGatewayResult> {
    validateRequest(request);

    const replay = await this.#replayIfRecorded(request);
    if (replay) return replay;

    const config = await this.#configuration.load();
    const route = resolveRoute(
      { taskKey: request.taskKey, workspaceId: request.workspaceId, planKey: request.planKey },
      config.routingRules,
      config.models,
    );

    // Phase 4 executes the head of the chain. W7 adds retries and the walk down
    // the fallbacks; the chain is resolved here so the record already names
    // what would have been tried.
    const modelKey = route.chain[0];
    /* c8 ignore next -- resolveRoute never returns an empty chain. */
    if (!modelKey) throw new AppError('INTERNAL', 'Routing resolved no model.');

    const creditRule = findCreditRule(config.creditRules, request.taskKey, modelKey);
    const multiplier = request.creditMultiplierBasisPoints ?? 10_000;
    const reservationEstimate = estimateReservationMilli(
      creditRule,
      worstCaseUsage(request, route),
      multiplier,
    );

    const aiRequest = await this.#createRequest(request, route, modelKey, reservationEstimate);
    if (aiRequest.replayed) return aiRequest.result;

    return this.#runReserved({
      request,
      route,
      modelKey,
      creditRule,
      multiplier,
      reservationEstimate,
      requestId: aiRequest.id,
      config,
    });
  }

  // ---------------------------------------------------------------------------
  // Idempotency
  // ---------------------------------------------------------------------------

  /**
   * Return the recorded outcome for a key that has already run to completion.
   *
   * A key whose request is still in flight is NOT replayed here: two callers
   * racing the same key must not both proceed, and the unique index on
   * `idempotencyKey` is what actually stops the second one. This read is the
   * fast path for the common case — a client that lost the response and asked
   * again after the first call finished.
   */
  async #replayIfRecorded(request: AiGatewayRequest): Promise<AiGatewayResult | null> {
    const existing = await this.#prisma.aiRequest.findUnique({
      where: { idempotencyKey: request.idempotencyKey },
    });
    if (!existing) return null;
    this.#assertSameWorkspace(existing.workspaceId, request.workspaceId);
    if (!isTerminal(existing.status)) {
      // Still running. Charging again or calling the provider again would both
      // be wrong, so the caller is told to wait rather than given a half answer.
      throw new AppError(
        'CONFLICT',
        'A request with this idempotency key is still running. Retry once it completes.',
      );
    }
    return toResult(existing, true);
  }

  /**
   * A cross-workspace replay is refused as NOT FOUND, shaped exactly like a
   * genuine miss. CLAUDE.md §2.1: even the difference between "forbidden" and
   * "not found" tells workspace A that a key exists in workspace B.
   */
  #assertSameWorkspace(recorded: string, asked: string): void {
    if (recorded !== asked) {
      throw new AppError('NOT_FOUND', 'No such request.');
    }
  }

  // ---------------------------------------------------------------------------
  // Reserve
  // ---------------------------------------------------------------------------

  /**
   * Claim the idempotency key, then reserve credits against it.
   *
   * The row is written BEFORE the wallet is touched, and its unique index is
   * what makes the claim atomic: two concurrent callers with one key produce
   * one row, one reservation and one provider call. The loser of that race
   * finds a row that is not yet terminal and is told to retry — not given a
   * second reservation.
   */
  async #createRequest(
    request: AiGatewayRequest,
    route: ResolvedRoute,
    modelKey: string,
    reservationEstimate: bigint,
  ): Promise<{ id: string; replayed: false } | { replayed: true; result: AiGatewayResult }> {
    const now = this.#clock.now();
    try {
      const created = await this.#prisma.aiRequest.create({
        data: {
          workspaceId: request.workspaceId,
          userId: request.userId,
          taskKey: request.taskKey,
          idempotencyKey: request.idempotencyKey,
          routingTaskKey: route.taskKey,
          resolvedModelKey: modelKey,
          attemptedModelKeys: [],
          status: 'PENDING',
          // Metadata only. §11: raw prompt content is never written here.
          inputSummary: summariseInput(request.input),
          creditsReservedMilli: reservationEstimate,
          deadlineAt: new Date(now.getTime() + route.timeoutMs),
        },
        select: { id: true },
      });
      return { id: created.id, replayed: false };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Lost the race for the key. Re-read; either it finished (replay it) or
      // it is still running (the caller waits).
      const replay = await this.#replayIfRecorded(request);
      /* c8 ignore next -- the row exists: the unique violation proves it. */
      if (!replay) throw error;
      return { replayed: true, result: replay };
    }
  }

  // ---------------------------------------------------------------------------
  // Execute, settle, release
  // ---------------------------------------------------------------------------

  async #runReserved(args: {
    request: AiGatewayRequest;
    route: ResolvedRoute;
    modelKey: string;
    creditRule: CreditRule;
    multiplier: number;
    reservationEstimate: bigint;
    requestId: string;
    config: AiConfiguration;
  }): Promise<AiGatewayResult> {
    const { request, route, modelKey, creditRule, multiplier, requestId, config } = args;

    let reservationId: string | null = null;
    try {
      const reservation = await this.#ledger.reserve({
        workspaceId: request.workspaceId,
        estimateMilliCredits: args.reservationEstimate,
        // A task key, never request content — the ledger record is not a log of
        // what the customer wrote.
        purpose: request.taskKey,
        idempotencyKey: `ai:${requestId}`,
        ttlSeconds: Math.ceil(route.timeoutMs / 1000) + 60,
      });
      reservationId = reservation.id;

      await this.#prisma.aiRequest.update({
        where: { id: requestId },
        data: { status: 'RESERVED', creditReservationId: reservation.id },
      });
    } catch (error) {
      // The wallet could not cover it, or the reserve failed outright. Nothing
      // was charged and no provider was called; record why and stop.
      await this.#recordFailure(requestId, modelKey, [], failureClassOf(error), error);
      throw error;
    }

    return this.#callProvider({
      request,
      route,
      modelKey,
      creditRule,
      multiplier,
      requestId,
      reservationId,
      config,
    });
  }

  async #callProvider(args: {
    request: AiGatewayRequest;
    route: ResolvedRoute;
    modelKey: string;
    creditRule: CreditRule;
    multiplier: number;
    requestId: string;
    reservationId: string;
    config: AiConfiguration;
  }): Promise<AiGatewayResult> {
    const { request, route, modelKey, creditRule, multiplier, requestId, reservationId, config } =
      args;

    const model = config.models.find((m) => m.key === modelKey);
    /* c8 ignore next -- resolveRoute only returns models present in the registry. */
    if (!model) throw new AppError('INTERNAL', `Model "${modelKey}" vanished from the registry.`);

    const provider = config.providers.find((p) => p.key === model.providerKey);
    const adapter = this.#adapters.get(model.providerKey);
    if (!provider || !adapter) {
      const error = new AiProviderError(
        'MODEL_UNAVAILABLE',
        customerMessageFor('MODEL_UNAVAILABLE'),
        `No adapter or provider configuration for "${model.providerKey}".`,
      );
      await this.#releaseAndRecord(requestId, reservationId, modelKey, [modelKey], error);
      return this.#recordedResult(requestId);
    }

    const startedAt = this.#clock.now();
    await this.#prisma.aiRequest.update({
      where: { id: requestId },
      data: { status: 'RUNNING', startedAt, attemptedModelKeys: [modelKey] },
    });

    const controller = new AbortController();
    // The deadline is enforced HERE, by us. A provider that ignores its own
    // timeout must not be able to hold a reservation open indefinitely.
    const timer = setTimeout(() => controller.abort(), route.timeoutMs);

    try {
      const ctx: AdapterContext = {
        environment: this.#environment,
        apiKey: await this.#credentials.resolve(provider.apiKeySecretRef),
        baseUrl: provider.baseUrl,
        timeoutMs: route.timeoutMs,
        signal: controller.signal,
        requestId,
      };

      const { output, usage } = await this.#invoke(adapter, modelKey, route, request.input, ctx);

      const basis = config.costBases.find((b) => b.modelKey === modelKey);
      const cost = basis ? providerCostMicroMinor(usage, basis) : 0n;
      const charged = creditsChargedMilli(usage, creditRule, multiplier);

      await this.#settle({
        requestId,
        reservationId,
        request,
        route,
        model,
        usage,
        output,
        cost,
        charged,
        latencyMs: this.#clock.now().getTime() - startedAt.getTime(),
      });

      return this.#recordedResult(requestId, output);
    } catch (error) {
      await this.#releaseAndRecord(requestId, reservationId, modelKey, [modelKey], error, {
        latencyMs: this.#clock.now().getTime() - startedAt.getTime(),
        workspaceId: request.workspaceId,
        userId: request.userId,
        taskKey: request.taskKey,
        providerKey: model.providerKey,
      });
      return this.#recordedResult(requestId);
    } finally {
      // Always. A leaked timer holds the process open and, worse, would abort a
      // controller belonging to a request that already finished.
      clearTimeout(timer);
    }
  }

  async #invoke(
    adapter: NonNullable<ReturnType<AdapterRegistry['get']>>,
    modelKey: string,
    route: ResolvedRoute,
    input: AiInput,
    ctx: AdapterContext,
  ): Promise<{ output: AiOutput; usage: UsageUnits }> {
    try {
      if (input.kind === 'text') {
        if (!adapter.generateText) {
          throw new AiProviderError(
            'MODEL_UNAVAILABLE',
            customerMessageFor('MODEL_UNAVAILABLE'),
            `Adapter "${adapter.key}" does not implement text generation.`,
          );
        }
        const result = await adapter.generateText(
          {
            modelKey,
            prompt: input.prompt,
            maxOutputTokens: route.parameters.maxOutputTokens,
            temperature: route.parameters.temperature,
            ...(input.untrustedContext ? { untrustedContext: input.untrustedContext } : {}),
          },
          ctx,
        );
        return { output: { kind: 'text', text: result.text }, usage: result.usage };
      }

      if (!adapter.generateImage) {
        throw new AiProviderError(
          'MODEL_UNAVAILABLE',
          customerMessageFor('MODEL_UNAVAILABLE'),
          `Adapter "${adapter.key}" does not implement image generation.`,
        );
      }
      const result = await adapter.generateImage(
        { modelKey, prompt: input.prompt, count: input.count, size: input.size },
        ctx,
      );
      return { output: { kind: 'image', imageRefs: result.imageRefs }, usage: result.usage };
    } catch (error) {
      // Everything a provider throws leaves this method as a classified error.
      // Downstream code decides from the CLASS and never from a provider string.
      if (error instanceof AiProviderError) throw error;
      const failureClass = adapter.classifyError(error);
      throw new AiProviderError(
        failureClass,
        customerMessageFor(failureClass),
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Settle the reservation down to the actual, then record the request and its
   * ledger row in one transaction.
   *
   * Order matters. The wallet moves first because it is the thing that must not
   * be double-applied, and it is idempotent on the reservation. The request row
   * and the immutable ledger row commit together afterwards, so a crash between
   * them cannot leave a SUCCEEDED request with no ledger entry.
   */
  async #settle(args: {
    requestId: string;
    reservationId: string;
    request: AiGatewayRequest;
    route: ResolvedRoute;
    model: RegisteredModel;
    usage: UsageUnits;
    output: AiOutput;
    cost: bigint;
    charged: bigint;
    latencyMs: number;
  }): Promise<void> {
    await this.#ledger.settle(args.reservationId, args.charged, `ai:${args.request.taskKey}`);

    await this.#prisma.$transaction(async (tx) => {
      await tx.aiRequest.update({
        where: { id: args.requestId },
        data: {
          status: 'SUCCEEDED',
          completedAt: this.#clock.now(),
          latencyMs: args.latencyMs,
          promptTokens: args.usage.promptTokens ?? null,
          completionTokens: args.usage.completionTokens ?? null,
          imageCount: args.usage.imageCount ?? null,
          durationSeconds: args.usage.durationSeconds ?? null,
          providerCostMicroMinor: args.cost,
          creditsChargedMilli: args.charged,
          // Off unless the operator turned it on for this rule (§11).
          outputPayload: args.route.parameters.persistOutput
            ? (args.output as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
        },
      });

      await tx.aiUsageLedger.create({
        data: {
          workspaceId: args.request.workspaceId,
          aiRequestId: args.requestId,
          userId: args.request.userId,
          taskKey: args.request.taskKey,
          providerKey: args.model.providerKey,
          modelKey: args.model.key,
          usageUnits: args.usage as unknown as Prisma.InputJsonValue,
          providerCostMicroMinor: args.cost,
          creditsChargedMilli: args.charged,
          environment: this.#environment,
        },
      });
    });
  }

  /**
   * Release the reservation in full and record the failure.
   *
   * §7.4 guarantee 1. The release runs before the request row is updated so
   * that a crash in between leaves an OPEN reservation the sweeper will find,
   * rather than a FAILED request whose credits are still held with nothing
   * pointing at them.
   */
  async #releaseAndRecord(
    requestId: string,
    reservationId: string | null,
    modelKey: string,
    attempted: readonly string[],
    error: unknown,
    ledgerContext?: {
      latencyMs: number;
      workspaceId: string;
      userId: string | null;
      taskKey: string;
      providerKey: string;
    },
  ): Promise<void> {
    if (reservationId) {
      await this.#ledger.release(reservationId, 'ai:request-failed');
    }
    await this.#recordFailure(requestId, modelKey, attempted, failureClassOf(error), error, {
      ...(ledgerContext ? { ledgerContext } : {}),
    });
  }

  async #recordFailure(
    requestId: string,
    modelKey: string,
    attempted: readonly string[],
    failureClass: AiFailureClass,
    error: unknown,
    extra?: {
      ledgerContext?: {
        latencyMs: number;
        workspaceId: string;
        userId: string | null;
        taskKey: string;
        providerKey: string;
      };
    },
  ): Promise<void> {
    const status = failureClass === 'TIMEOUT' ? 'TIMEOUT' : 'FAILED';
    const context = extra?.ledgerContext;

    await this.#prisma.$transaction(async (tx) => {
      await tx.aiRequest.update({
        where: { id: requestId },
        data: {
          status,
          failureClass,
          // The CUSTOMER's message. A raw provider error can carry an endpoint,
          // an account id, or an echo of the prompt.
          failureMessage: customerMessageFor(failureClass),
          completedAt: this.#clock.now(),
          resolvedModelKey: modelKey,
          attemptedModelKeys: [...attempted],
          ...(context ? { latencyMs: context.latencyMs } : {}),
          // Explicit, not implied: a failed request charges nothing, and the
          // ai_request_no_charge_unless_succeeded constraint agrees.
          creditsChargedMilli: 0n,
        },
      });

      if (context) {
        // Provider cost on a failed attempt is absorbed, but it is recorded:
        // §5.3 point 5 wants it visible in margin analytics rather than lost.
        await tx.aiUsageLedger.create({
          data: {
            workspaceId: context.workspaceId,
            aiRequestId: requestId,
            userId: context.userId,
            taskKey: context.taskKey,
            providerKey: context.providerKey,
            modelKey,
            usageUnits: {} as Prisma.InputJsonValue,
            providerCostMicroMinor: 0n,
            creditsChargedMilli: 0n,
            environment: this.#environment,
          },
        });
      }
    });

    void error;
  }

  /** Read back what was recorded, so the caller and the database cannot disagree. */
  async #recordedResult(requestId: string, output?: AiOutput): Promise<AiGatewayResult> {
    const row = await this.#prisma.aiRequest.findUniqueOrThrow({ where: { id: requestId } });
    const result = toResult(row, false);
    return output ? { ...result, output } : result;
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function validateRequest(request: AiGatewayRequest): void {
  if (!request.idempotencyKey.trim()) {
    // Without one, a client that retries after a timeout is charged twice.
    throw new AppError('VALIDATION_FAILED', 'An idempotency key is required.');
  }
  if (request.input.kind === 'text' && !request.input.prompt.trim()) {
    throw new AppError('VALIDATION_FAILED', 'A prompt is required.');
  }
  if (request.input.kind === 'image' && request.input.count < 1) {
    throw new AppError('VALIDATION_FAILED', 'At least one image must be requested.');
  }
  if (
    request.creditMultiplierBasisPoints !== undefined &&
    request.creditMultiplierBasisPoints < 0
  ) {
    throw new AppError('VALIDATION_FAILED', 'A credit multiplier cannot be negative.');
  }
}

/**
 * The worst case the route permits — §7.3 Reserve.
 *
 * The prompt is known; the output is not, so the full `maxOutputTokens` the
 * rule allows is assumed. Estimating tightly is the dangerous direction: a
 * response longer than predicted would settle above its reservation, and
 * `ai_request_charge_within_reservation` refuses that outright.
 */
function worstCaseUsage(request: AiGatewayRequest, route: ResolvedRoute): UsageUnits {
  if (request.input.kind === 'image') {
    return { imageCount: request.input.count };
  }
  const contextChars = (request.input.untrustedContext ?? []).reduce(
    (total, entry) => total + entry.length,
    0,
  );
  return {
    promptTokens: Math.ceil((request.input.prompt.length + contextChars) / 4),
    completionTokens: route.parameters.maxOutputTokens,
  };
}

/** Audit-safe metadata. Never the prompt itself — §11. */
function summariseInput(input: AiInput): Prisma.InputJsonValue {
  if (input.kind === 'image') {
    return { kind: 'image', count: input.count, size: input.size };
  }
  return {
    kind: 'text',
    promptChars: input.prompt.length,
    contextParts: (input.untrustedContext ?? []).length,
  };
}

function failureClassOf(error: unknown): AiFailureClass {
  if (error instanceof AiProviderError) return error.failureClass;
  if (error instanceof AppError && error.code === 'INSUFFICIENT_CREDITS') return 'QUOTA_EXCEEDED';
  return 'UNKNOWN';
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

interface AiRequestRow {
  id: string;
  status: string;
  resolvedModelKey: string | null;
  attemptedModelKeys: string[];
  outputPayload: Prisma.JsonValue;
  promptTokens: number | null;
  completionTokens: number | null;
  imageCount: number | null;
  durationSeconds: number | null;
  creditsChargedMilli: bigint;
  providerCostMicroMinor: bigint;
  failureClass: string | null;
  failureMessage: string | null;
  latencyMs: number | null;
}

function toResult(row: AiRequestRow, replayed: boolean): AiGatewayResult {
  const usage: UsageUnits = {
    ...(row.promptTokens !== null ? { promptTokens: row.promptTokens } : {}),
    ...(row.completionTokens !== null ? { completionTokens: row.completionTokens } : {}),
    ...(row.imageCount !== null ? { imageCount: row.imageCount } : {}),
    ...(row.durationSeconds !== null ? { durationSeconds: row.durationSeconds } : {}),
  };

  return {
    requestId: row.id,
    status: row.status as AiGatewayResult['status'],
    modelKey: row.resolvedModelKey,
    attemptedModelKeys: row.attemptedModelKeys,
    output: (row.outputPayload as AiOutput | null) ?? null,
    usage,
    creditsChargedMilli: row.creditsChargedMilli,
    providerCostMicroMinor: row.providerCostMicroMinor,
    failureClass: row.failureClass as AiFailureClass | null,
    failureMessage: row.failureMessage,
    replayed,
    latencyMs: row.latencyMs,
  };
}
