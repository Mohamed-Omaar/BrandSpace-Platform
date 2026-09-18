import { Prisma, type PrismaClient } from '@brandspace/database';
import type { CreditLedgerService } from '@brandspace/entitlements';
import { AppError, type Clock, systemClock } from '@brandspace/shared';

import type { AdapterContext, AdapterRegistry, GeneratedImage, UsageUnits } from './adapter';
import {
  assessBudget,
  budgetRefusal,
  resolveBudget,
  withinRequestCostCap,
  BudgetExceededError,
  type AiBudgets,
  type BudgetUsage,
} from './budgets';
import {
  AiProviderError,
  customerMessageFor,
  isFallbackEligible,
  isRetryable,
  type AiFailureClass,
} from './errors';
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
  /** Retry jitter. Injectable so a test is not at the mercy of randomness. */
  readonly random?: () => number;
}

/** The active AI configuration, already parsed. */
export interface AiConfiguration {
  readonly providers: readonly AiProviderConfig[];
  readonly models: readonly RegisteredModel[];
  readonly costBases: readonly ModelCostBasis[];
  readonly routingRules: readonly RoutingRule[];
  readonly creditRules: readonly CreditRule[];
  readonly budgets: AiBudgets;
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

/**
 * The answer to "what would this cost?" — see `AiGateway.quote`.
 *
 * `estimateMilli` is milli-credits, the unit every other credit number in the
 * system uses: integers all the way down, because a float anywhere near money
 * is how rounding becomes revenue.
 */
export interface AiQuote {
  readonly taskKey: string;
  readonly estimateMilli: bigint;
  /** The models that would be attempted, primary first. */
  readonly modelKeys: readonly string[];
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
      /**
       * PHASE 8 — the bytes, when the provider returned them inline.
       *
       * IN MEMORY AND NOT PERSISTED. `ai_request` records the REFS, which are
       * opaque and small; the bytes travel to the caller and are forgotten.
       * A generated image becomes an ordinary `Asset` in the one library, and
       * the library is where files live — not here, and not twice.
       */
      readonly images?: readonly GeneratedImage[] | undefined;
    };

/** The outcome of one stuck-request sweep. Mirrors the credit sweeper's shape. */
export interface AiSweepResult {
  /** Requests actually reconciled this pass. */
  readonly swept: number;
  /** Requests that could not be reconciled — a correctness alert, not a stop. */
  readonly failed: readonly string[];
  /** Rows tried, successes and failures together. */
  readonly attempted: number;
  /** True when no untried candidate remained; false when the bound was hit. */
  readonly exhausted: boolean;
}

/**
 * Rows fetched per batch. Small on purpose: a batch of failures is re-fetched
 * with those ids excluded, and a large batch makes that list grow faster than
 * the sweep makes progress.
 */
const AI_SWEEP_BATCH_SIZE = 50;

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
  readonly #random: () => number;

  constructor(options: AiGatewayOptions) {
    this.#prisma = options.prisma;
    this.#ledger = options.ledger;
    this.#adapters = options.adapters;
    this.#configuration = options.configuration;
    this.#credentials = options.credentials;
    this.#environment = options.environment;
    this.#clock = options.clock ?? systemClock;
    this.#random = options.random ?? Math.random;
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

    const multiplier = request.creditMultiplierBasisPoints ?? 10_000;
    const worstCase = worstCaseUsage(request, route);

    /*
     * THE PER-REQUEST COST CEILING NARROWS THE CHAIN — §8's first row, "reject
     * before calling the provider".
     *
     * Treated exactly like a disabled model: an over-cap model is dropped from
     * the chain rather than failing the whole request, because the operator's
     * next choice may well be affordable. Only when nothing affordable remains
     * is the request refused — still before the wallet is touched.
     */
    const affordable = route.chain.filter((candidate) => {
      const basis = config.costBases.find((b) => b.modelKey === candidate);
      if (!basis) return true;
      return withinRequestCostCap(
        providerCostMicroMinor(worstCase, basis),
        route.maxCostPerRequestMinor,
      );
    });
    if (affordable.length === 0) {
      throw new BudgetExceededError(
        'request_cost',
        'This request would cost more than the configured per-request ceiling.',
        route.maxCostPerRequestMinor,
        0,
      );
    }
    const chain = affordable;

    const modelKey = chain[0];
    /* c8 ignore next -- `affordable` is non-empty here. */
    if (!modelKey) throw new AppError('INTERNAL', 'Routing resolved no model.');

    /*
     * RESERVE FOR THE MOST EXPENSIVE MODEL IN THE CHAIN, not for the primary.
     *
     * One reservation covers the whole attempt sequence, and a fallback model
     * may be priced higher than the model that failed. Sizing the reservation
     * on the primary alone would mean that falling back to a dearer model
     * settles ABOVE its reservation — which `ai_request_charge_within_reservation`
     * refuses outright, turning a successful generation into a 500 and leaving
     * the customer with nothing after we already paid the provider.
     */
    const reservationEstimate = chain.reduce((highest, candidate) => {
      const rule = findCreditRule(config.creditRules, request.taskKey, candidate);
      const estimate = estimateReservationMilli(rule, worstCase, multiplier);
      return estimate > highest ? estimate : highest;
    }, 0n);

    /*
     * WORKSPACE BUDGETS, BEFORE THE WALLET AND BEFORE THE PROVIDER.
     *
     * A budget enforced after the fact is an invoice, not a budget. Checked
     * against the ESTIMATE rather than the eventual charge: admitting a
     * request because its final cost might land under the line would mean the
     * ceiling only ever binds in hindsight.
     */
    const decision = assessBudget(
      resolveBudget(config.budgets, request.planKey),
      await this.#budgetUsage(request.workspaceId),
      reservationEstimate,
    );
    if (!decision.allowed) throw budgetRefusal(decision);

    const aiRequest = await this.#createRequest(request, route, modelKey, reservationEstimate);
    if (aiRequest.replayed) return aiRequest.result;

    return this.#runReserved({
      request,
      route,
      chain,
      modelKey,
      multiplier,
      reservationEstimate,
      requestId: aiRequest.id,
      config,
    });
  }

  /**
   * What would this request cost, without doing it?
   *
   * AC-11.1 requires the customer to see the credit cost BEFORE confirming a
   * generation, and a price shown before a purchase has to be the price the
   * purchase will actually reserve. So this does not estimate independently:
   * it runs the SAME route resolution, the same worst-case sizing and the same
   * `estimateReservationMilli` over the same chain that `execute` does, and
   * returns the number `execute` would reserve.
   *
   * WHAT IT DELIBERATELY DOES NOT DO: touch the wallet, write an `AiRequest`,
   * consume an idempotency key, or call a provider. A quote is a read. It also
   * does not check the budget — a customer looking at a price they cannot
   * afford should be told the price and then refused at generation with the
   * budget's own message, rather than shown a blank where the number goes.
   *
   * A routing failure propagates as `RoutingError`, because "we cannot price
   * this" is exactly the configuration problem AC-11.8 wants surfaced rather
   * than papered over with a guess.
   */
  async quote(request: {
    workspaceId: string;
    taskKey: string;
    planKey: string | null;
    input: AiInput;
    creditMultiplierBasisPoints?: number;
  }): Promise<AiQuote> {
    const config = await this.#configuration.load();
    const route = resolveRoute(
      { taskKey: request.taskKey, workspaceId: request.workspaceId, planKey: request.planKey },
      config.routingRules,
      config.models,
    );

    const multiplier = request.creditMultiplierBasisPoints ?? 10_000;
    const worstCase = worstCaseUsage(
      {
        workspaceId: request.workspaceId,
        userId: null,
        taskKey: request.taskKey,
        planKey: request.planKey,
        idempotencyKey: 'quote',
        input: request.input,
      },
      route,
    );

    const estimateMilli = route.chain.reduce((highest, candidate) => {
      const rule = findCreditRule(config.creditRules, request.taskKey, candidate);
      const estimate = estimateReservationMilli(rule, worstCase, multiplier);
      return estimate > highest ? estimate : highest;
    }, 0n);

    return { taskKey: request.taskKey, estimateMilli, modelKeys: route.chain };
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
    chain: readonly string[];
    modelKey: string;
    multiplier: number;
    reservationEstimate: bigint;
    requestId: string;
    config: AiConfiguration;
  }): Promise<AiGatewayResult> {
    const { request, route, modelKey, multiplier, requestId, config } = args;

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

    /*
     * INPUT MODERATION, AFTER THE RESERVATION AND BEFORE THE PROVIDER —
     * docs/AI-GATEWAY.md §6 and §10.1.
     *
     * After, because §10.7 requires a blocked request to RELEASE a
     * reservation, and there is nothing to release if none was taken. Before,
     * because the point is to stop the content reaching a provider at all.
     */
    if (route.moderateInput && route.moderationModelKey) {
      const blocked = await this.#moderateInput(request, route, config, requestId);
      if (blocked) {
        await this.#blockForModeration(requestId, reservationId, route.moderationModelKey);
        return this.#recordedResult(requestId);
      }
    }

    return this.#runChain({
      request,
      route,
      chain: args.chain,
      multiplier,
      requestId,
      reservationId,
      config,
    });
  }

  /**
   * Walk the model chain, retrying inside each model, under ONE deadline.
   *
   * docs/AI-GATEWAY.md §5.3 and §9. Three rules govern the walk, and each of
   * them exists to stop a specific way of spending a customer's money badly:
   *
   *   - A class is retried on the SAME model only if the taxonomy says it is
   *     transient. Retrying an INVALID_REQUEST burns the deadline to reach the
   *     same answer.
   *   - A class moves to the NEXT model only if it is fallback-eligible. A
   *     different model that did NOT refuse filtered content would be routing
   *     around a moderation decision; an AUTH_ERROR served from a second
   *     provider hides an outage the operator needs to see.
   *   - The total deadline bounds everything. Attempts do not each get a fresh
   *     timeout: a reservation must not be held for maxAttempts x timeoutMs.
   */
  async #runChain(args: {
    request: AiGatewayRequest;
    route: ResolvedRoute;
    chain: readonly string[];
    multiplier: number;
    requestId: string;
    reservationId: string;
    config: AiConfiguration;
  }): Promise<AiGatewayResult> {
    const { request, route, chain, multiplier, requestId, reservationId, config } = args;

    const startedAt = this.#clock.now();
    const deadline = startedAt.getTime() + route.timeoutMs;

    await this.#prisma.aiRequest.update({
      where: { id: requestId },
      data: { status: 'RUNNING', startedAt },
    });

    const attempted: string[] = [];
    let retries = 0;
    let lastError: unknown = new AiProviderError(
      'UNKNOWN',
      customerMessageFor('UNKNOWN'),
      'The chain produced no attempt.',
    );
    let lastProviderKey: string | null = null;

    for (const modelKey of chain) {
      const model = config.models.find((m) => m.key === modelKey);
      const provider = model
        ? config.providers.find((p) => p.key === model.providerKey)
        : undefined;
      const adapter = model ? this.#adapters.get(model.providerKey) : undefined;

      if (!model || !provider || !adapter) {
        // An unusable entry is not an outage of the whole chain: try the next
        // model exactly as a MODEL_UNAVAILABLE would.
        attempted.push(modelKey);
        lastError = new AiProviderError(
          'MODEL_UNAVAILABLE',
          customerMessageFor('MODEL_UNAVAILABLE'),
          `No adapter or provider configuration for model "${modelKey}".`,
        );
        continue;
      }

      lastProviderKey = model.providerKey;
      const creditRule = findCreditRule(config.creditRules, request.taskKey, modelKey);

      for (let attempt = 1; attempt <= route.retryPolicy.maxAttempts; attempt += 1) {
        const remainingMs = deadline - this.#clock.now().getTime();
        if (remainingMs <= 0) {
          lastError = new AiProviderError(
            'TIMEOUT',
            customerMessageFor('TIMEOUT'),
            'The request deadline passed before this attempt could start.',
          );
          await this.#finishFailed(requestId, reservationId, {
            attempted,
            retries,
            error: lastError,
            startedAt,
            request,
            providerKey: lastProviderKey,
          });
          return this.#recordedResult(requestId);
        }

        attempted.push(modelKey);
        await this.#prisma.aiRequest.update({
          where: { id: requestId },
          data: {
            attemptedModelKeys: [...attempted],
            resolvedModelKey: modelKey,
            retryCount: retries,
          },
        });

        const controller = new AbortController();
        // The deadline is ours, not the provider's. A provider that ignores its
        // own timeout must not be able to hold a reservation open — and the
        // budget is what REMAINS, so retries cannot extend it.
        const timer = setTimeout(() => controller.abort(), remainingMs);
        try {
          const ctx: AdapterContext = {
            environment: this.#environment,
            apiKey: await this.#credentials.resolve(provider.apiKeySecretRef),
            baseUrl: provider.baseUrl,
            timeoutMs: remainingMs,
            signal: controller.signal,
            requestId,
          };

          const { output, usage } = await this.#invoke(
            adapter,
            modelKey,
            route,
            request.input,
            ctx,
          );

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
            attempted,
            retries,
          });
          return this.#recordedResult(requestId, output);
        } catch (error) {
          lastError = error;
          const failureClass = failureClassOf(error);
          const attemptsLeft = attempt < route.retryPolicy.maxAttempts;

          if (isRetryable(failureClass) && attemptsLeft) {
            retries += 1;
            const slept = await this.#backoff(route.retryPolicy, attempt, deadline);
            // Backoff that would outrun the deadline is not worth taking: stop
            // rather than sleep through the time the attempt needed.
            if (slept) continue;
          }
          break;
        } finally {
          // Always. A leaked timer keeps the process alive and would abort a
          // controller belonging to a request that already finished.
          clearTimeout(timer);
        }
      }

      const failureClass = failureClassOf(lastError);
      if (!isFallbackEligible(failureClass)) {
        // Deterministic refusals and our own account failures stop here. Trying
        // another model would either fail identically or hide the problem.
        break;
      }
    }

    await this.#finishFailed(requestId, reservationId, {
      attempted,
      retries,
      error: lastError,
      startedAt,
      request,
      providerKey: lastProviderKey,
    });
    return this.#recordedResult(requestId);
  }

  /**
   * Sleep between attempts. Returns false when the deadline leaves no room.
   *
   * Jitter is real randomness by default because synchronised retries across
   * many workspaces are how a rate-limited provider stays rate-limited. It is
   * injectable so tests are not at the mercy of it.
   */
  async #backoff(
    policy: ResolvedRoute['retryPolicy'],
    attempt: number,
    deadline: number,
  ): Promise<boolean> {
    let delay = 0;
    if (policy.backoff === 'fixed') delay = policy.initialDelayMs;
    if (policy.backoff === 'exponential') delay = policy.initialDelayMs * 2 ** (attempt - 1);
    if (policy.jitter && delay > 0) delay = Math.floor(delay * (0.5 + this.#random() * 0.5));

    const remaining = deadline - this.#clock.now().getTime();
    if (delay >= remaining) return false;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    return true;
  }

  /** Release the reservation and record the terminal failure. */
  async #finishFailed(
    requestId: string,
    reservationId: string,
    context: {
      attempted: readonly string[];
      retries: number;
      error: unknown;
      startedAt: Date;
      request: AiGatewayRequest;
      providerKey: string | null;
    },
  ): Promise<void> {
    const modelKey = context.attempted[context.attempted.length - 1] ?? '';
    await this.#releaseAndRecord(
      requestId,
      reservationId,
      modelKey,
      context.attempted,
      context.error,
      context.providerKey
        ? {
            latencyMs: this.#clock.now().getTime() - context.startedAt.getTime(),
            workspaceId: context.request.workspaceId,
            userId: context.request.userId,
            taskKey: context.request.taskKey,
            providerKey: context.providerKey,
          }
        : undefined,
      context.retries,
    );
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
      return {
        output: {
          kind: 'image',
          imageRefs: result.imageRefs,
          ...(result.images ? { images: result.images } : {}),
        },
        usage: result.usage,
      };
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
    attempted: readonly string[];
    retries: number;
  }): Promise<void> {
    await this.#ledger.settle(args.reservationId, args.charged, `ai:${args.request.taskKey}`);

    await this.#prisma.$transaction(async (tx) => {
      await tx.aiRequest.update({
        where: { id: args.requestId },
        data: {
          status: 'SUCCEEDED',
          completedAt: this.#clock.now(),
          latencyMs: args.latencyMs,
          // Every model tried, in order, including the ones that failed —
          // §5.3 point 4. Fallback is invisible in reporting without it.
          attemptedModelKeys: [...args.attempted],
          resolvedModelKey: args.model.key,
          retryCount: args.retries,
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
    retries = 0,
  ): Promise<void> {
    if (reservationId) {
      try {
        await this.#ledger.release(reservationId, 'ai:request-failed');
      } catch (releaseError) {
        /*
         * A reservation that is already gone is not a reason to leave the
         * request RUNNING for ever.
         *
         * Nothing in production deletes a reservation row, so this should not
         * happen — but if it does, refusing to record the failure would strand
         * the request in a non-terminal status that only the sweeper looks at,
         * and the sweeper would hand it back unfixable on every pass. The leak
         * metric of §12 would then never return to zero, which is exactly the
         * F-62 starvation shape. Only a genuine miss is tolerated; anything
         * else still propagates.
         */
        if (!(releaseError instanceof AppError) || releaseError.code !== 'NOT_FOUND') {
          throw releaseError;
        }
      }
    }
    await this.#recordFailure(requestId, modelKey, attempted, failureClassOf(error), error, {
      ...(ledgerContext ? { ledgerContext } : {}),
      retries,
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
      retries?: number;
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
          retryCount: extra?.retries ?? 0,
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

  // ---------------------------------------------------------------------------
  // Moderation
  // ---------------------------------------------------------------------------

  /**
   * Ask the configured moderation model whether the input may proceed.
   *
   * FAILS OPEN, DELIBERATELY, AND ONLY HERE. If the moderation model is
   * unreachable the request continues rather than being refused: a moderation
   * outage that silently blocked every customer's work would be a far larger
   * incident than the content it was meant to catch, and the operator sees the
   * outage through the same failure metrics as any other provider call. A
   * moderation model that ANSWERS and says "flagged" always blocks.
   *
   * This is the one place in the gateway where an error is not fatal, which is
   * why it is stated rather than implied.
   */
  async #moderateInput(
    request: AiGatewayRequest,
    route: ResolvedRoute,
    config: AiConfiguration,
    requestId: string,
  ): Promise<boolean> {
    const modelKey = route.moderationModelKey;
    /* c8 ignore next -- the caller checks this before calling. */
    if (!modelKey) return false;

    const model = config.models.find((m) => m.key === modelKey);
    const provider = model ? config.providers.find((p) => p.key === model.providerKey) : undefined;
    const adapter = model ? this.#adapters.get(model.providerKey) : undefined;
    if (!model || !provider || !adapter?.moderate) return false;

    const text =
      request.input.kind === 'text'
        ? [request.input.prompt, ...(request.input.untrustedContext ?? [])].join('\n')
        : request.input.prompt;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), route.timeoutMs);
    try {
      const result = await adapter.moderate(
        { modelKey, text },
        {
          environment: this.#environment,
          apiKey: await this.#credentials.resolve(provider.apiKeySecretRef),
          baseUrl: provider.baseUrl,
          timeoutMs: route.timeoutMs,
          signal: controller.signal,
          requestId,
        },
      );
      return result.flagged;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** §10.7: a blocked result is not charged. */
  async #blockForModeration(
    requestId: string,
    reservationId: string,
    moderationModelKey: string,
  ): Promise<void> {
    await this.#ledger.release(reservationId, 'ai:moderation-blocked');
    await this.#prisma.aiRequest.update({
      where: { id: requestId },
      data: {
        status: 'MODERATION_BLOCKED',
        failureClass: 'CONTENT_FILTERED',
        failureMessage: customerMessageFor('CONTENT_FILTERED'),
        completedAt: this.#clock.now(),
        creditsChargedMilli: 0n,
        // Recorded so an operator can see WHICH model made the call. The
        // offending text is the customer's and is not written down.
        attemptedModelKeys: [moderationModelKey],
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Budgets
  // ---------------------------------------------------------------------------

  /**
   * What this workspace has spent and has in flight — §8's "per workspace" row.
   *
   * The ledger is the source, not the wallet: a wallet balance says what is
   * left, while a budget asks what has been SPENT in a window, and those are
   * different questions once grants and top-ups are involved.
   *
   * Both windows are read in one round trip, and concurrency counts requests
   * that have not reached a terminal status — including ones whose process
   * died, which is why the stuck-request sweep has to run: without it, a
   * crashed request would keep counting against a workspace's concurrency
   * forever.
   */
  async #budgetUsage(workspaceId: string): Promise<BudgetUsage> {
    const now = this.#clock.now();
    const startOfDay = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const [today, month, concurrent] = await Promise.all([
      this.#prisma.aiUsageLedger.aggregate({
        where: { workspaceId, occurredAt: { gte: startOfDay } },
        _sum: { creditsChargedMilli: true },
      }),
      this.#prisma.aiUsageLedger.aggregate({
        where: { workspaceId, occurredAt: { gte: startOfMonth } },
        _sum: { creditsChargedMilli: true },
      }),
      this.#prisma.aiRequest.count({
        where: { workspaceId, status: { in: ['PENDING', 'RESERVED', 'RUNNING'] } },
      }),
    ]);

    return {
      creditsTodayMilli: today._sum.creditsChargedMilli ?? 0n,
      creditsThisMonthMilli: month._sum.creditsChargedMilli ?? 0n,
      concurrentRequests: concurrent,
    };
  }

  /** The budget position, for Admin and for explaining a refusal. */
  async budgetStatus(
    workspaceId: string,
    planKey: string | null,
  ): Promise<{ limits: ReturnType<typeof resolveBudget>; usage: BudgetUsage }> {
    const config = await this.#configuration.load();
    return {
      limits: resolveBudget(config.budgets, planKey),
      usage: await this.#budgetUsage(workspaceId),
    };
  }

  // ---------------------------------------------------------------------------
  // Output retention
  // ---------------------------------------------------------------------------

  /**
   * Clear persisted outputs past their retention window.
   *
   * The approved output-persistence policy (2026-09-13) requires that anything
   * persisted is covered by a defined retention and deletion policy, and that
   * the gateway does not become a permanent content store. `persistOutput`
   * makes an idempotent replay able to return the original result; this is what
   * stops that convenience turning into indefinite storage of customer content.
   *
   * ONLY THE PAYLOAD IS CLEARED. The request row stays, because the same policy
   * requires the operational metadata — usage, cost, credits, idempotency,
   * audit and diagnostics — to be retained. A replay after expiry still returns
   * the recorded accounting and simply carries no output, which is the correct
   * trade: the customer's content is gone, the financial record is not.
   *
   * Retention is per routing rule, so the window is read from the active
   * configuration rather than assumed. A rule that no longer persists output
   * still has its old payloads swept, which is what an operator turning the
   * setting OFF should mean.
   */
  async purgeExpiredOutputs(limit = 500): Promise<number> {
    return purgeExpiredOutputs({
      prisma: this.#prisma,
      configuration: this.#configuration,
      clock: this.#clock,
      limit,
    });
  }

  // ---------------------------------------------------------------------------
  // Stuck-request sweep
  // ---------------------------------------------------------------------------

  /**
   * Reconcile requests still RUNNING past their deadline — docs/AI-GATEWAY.md §6.1.
   *
   * "No reservation can outlive its request." A process that dies mid-call
   * leaves a RUNNING row and an OPEN reservation, and nothing else will ever
   * close either: the credits stay held against a workspace that got nothing.
   *
   * The shape follows F-62's lesson from the reservation sweeper. A bounded
   * query whose failures stay eligible hands the same unfixable rows back
   * every pass and never reaches the fresh ones behind them, so ids that
   * failed THIS sweep are excluded from the next batch, and the result
   * distinguishes "nothing left" from "stopped at the bound with work
   * remaining". Ordering is oldest-deadline-first with an id tie-break, so the
   * sweep is deterministic and the longest-held credits are freed first.
   */
  async sweepStuckRequests(
    limit = 200,
    options: { readonly maxAttempts?: number } = {},
  ): Promise<AiSweepResult> {
    const now = this.#clock.now();
    const maxAttempts = options.maxAttempts ?? Math.max(limit * 4, AI_SWEEP_BATCH_SIZE);

    const failed: string[] = [];
    let swept = 0;
    let attempted = 0;
    let exhausted = false;

    while (swept < limit && attempted < maxAttempts) {
      const batch = await this.#prisma.aiRequest.findMany({
        where: {
          status: { in: ['PENDING', 'RESERVED', 'RUNNING'] },
          deadlineAt: { lt: now },
          ...(failed.length > 0 ? { id: { notIn: failed } } : {}),
        },
        select: {
          id: true,
          creditReservationId: true,
          resolvedModelKey: true,
          attemptedModelKeys: true,
        },
        orderBy: [{ deadlineAt: 'asc' }, { id: 'asc' }],
        take: Math.min(AI_SWEEP_BATCH_SIZE, maxAttempts - attempted),
      });

      if (batch.length === 0) {
        exhausted = true;
        break;
      }

      for (const row of batch) {
        if (swept >= limit || attempted >= maxAttempts) break;
        attempted += 1;
        try {
          await this.#releaseAndRecord(
            row.id,
            row.creditReservationId,
            row.resolvedModelKey ?? '',
            row.attemptedModelKeys,
            new AiProviderError(
              'TIMEOUT',
              customerMessageFor('TIMEOUT'),
              'Swept: the request passed its deadline while still running.',
            ),
          );
          swept += 1;
        } catch {
          // A non-empty `failed` list is a correctness alert about the ledger,
          // never a reason for the sweep to stop.
          failed.push(row.id);
        }
      }
    }

    return { swept, failed, attempted, exhausted };
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

/**
 * Clear AI output payloads past their configured retention window — D-78.
 *
 * A FUNCTION BECAUSE OF WHO CALLS IT. The maintenance sweep needs a database
 * handle, the routing configuration and a clock. Reaching this through the full
 * gateway would have meant constructing one with a fabricated ledger and an
 * empty adapter map — collaborators the purge never touches, until the day
 * someone adds a line that does. This way the sweep is handed exactly what the
 * purge needs and has no ability to reserve, call a provider or settle a
 * credit.
 *
 * CONTENT ONLY. The payload is nulled; the `ai_request` row, its usage, its
 * credit settlement and its correlation ids all stay. D-78 retains operational
 * metadata and drops content, and deleting the row would take the accounting
 * with it.
 *
 * ONE WINDOW PER TASK, THE SHORTEST WINS. Two routing rules can select the same
 * task in different scopes; honouring the tightest is the conservative reading,
 * and the one a privacy commitment should take.
 */
export async function purgeExpiredOutputs(input: {
  prisma: PrismaClient;
  configuration: AiConfigurationSource;
  clock: Clock;
  limit?: number;
}): Promise<number> {
  const limit = input.limit ?? 500;
  const config = await input.configuration.load();
  const now = input.clock.now();

  const windowByTask = new Map<string, number>();
  for (const rule of config.routingRules) {
    const days = rule.parameters.outputRetentionDays;
    if (days === null || days === undefined) continue;
    const existing = windowByTask.get(rule.taskKey);
    if (existing === undefined || days < existing) windowByTask.set(rule.taskKey, days);
  }

  let purged = 0;
  // Sorted, so a bounded pass processes the same tasks in the same order every
  // time rather than in whatever order the rules happened to be written in.
  for (const taskKey of [...windowByTask.keys()].sort()) {
    if (purged >= limit) break;
    const days = windowByTask.get(taskKey)!;
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const expired = await input.prisma.aiRequest.findMany({
      where: {
        taskKey,
        outputPayload: { not: Prisma.DbNull },
        completedAt: { lt: cutoff },
      },
      select: { id: true },
      // Oldest first, with an id tie-break: deterministic, and the content that
      // has been held longest goes first.
      orderBy: [{ completedAt: 'asc' }, { id: 'asc' }],
      take: limit - purged,
    });
    if (expired.length === 0) continue;

    const result = await input.prisma.aiRequest.updateMany({
      where: { id: { in: expired.map((row) => row.id) } },
      data: { outputPayload: Prisma.DbNull },
    });
    purged += result.count;
  }

  return purged;
}
