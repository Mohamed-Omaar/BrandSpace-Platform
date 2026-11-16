import type { TenantScopedClient } from '@brandspace/database';
import type { GenerationResult } from '@brandspace/content';
import { AppError } from '@brandspace/shared';
import type { LiveAuthorization } from './authorization';
import { contentDraftResult, type ExecutorContext } from './executors';
import type {
  CopilotPlanService,
  EntitlementGate,
  ExecutionResult,
  ExecutionState,
  PausedStep,
} from './plans';

/**
 * C2 (F-112) — CONFIRM A PLAN AND RUN IT, NEVER HOLDING A TRANSACTION ACROSS A
 * MODEL CALL.
 *
 * `/v1/copilot/confirm` used to run the whole plan in one tenant transaction,
 * and a `content.draft` step called the provider inside it: a slow model held
 * a pooled connection and could expire the transaction (the interim was a
 * 90 s timeout). Now:
 *
 *   1. one SHORT transaction confirms the plan (the single-use token, the
 *      hash the person was shown), claims it, and runs its steps until a step
 *      whose tool calls a model (`generating`) — that step is checked and
 *      recorded RUNNING like any other, then handed back;
 *   2. `generate` runs it with NO transaction open (the studio's own three
 *      short steps: reads, the provider with none, the draft written);
 *   3. the next short transaction reads the live membership again, records
 *      the outcome (the draft, its credits and its undo — or a stable failure
 *      code), and runs the steps after it, pausing again at the next model.
 *
 * Every step is still checked against the live membership, brand scope and
 * entitlements first; a step's derived key still makes any retry a replay
 * (no second draft, no second charge); a failed model call charges nothing.
 * A draft written by step 2 stays if a later step fails: the plan reads
 * FAILED and offers the draft's undo, as a refused step always has.
 */
export interface ConfirmRunServices {
  readonly plans: CopilotPlanService;
  readonly entitlements?: EntitlementGate | undefined;
  readonly context: (authorization: LiveAuthorization) => ExecutorContext;
}

export async function runConfirmedPlan(input: {
  readonly planId: string;
  readonly planHash: string;
  readonly token: string;
  readonly userId: string;
  /** Opens one short tenant transaction. */
  readonly run: <T>(fn: (db: TenantScopedClient) => Promise<T>) => Promise<T>;
  /** The plan service and step collaborators, bound to that transaction. */
  readonly services: (db: TenantScopedClient) => Promise<ConfirmRunServices>;
  /** The tools whose step calls a model, run outside any transaction. */
  readonly generating: ReadonlySet<string>;
  /** Runs a paused `content.draft` step with no transaction open. */
  readonly generate: (paused: PausedStep, state: ExecutionState) => Promise<GenerationResult>;
}): Promise<ExecutionResult> {
  type Segment = { paused: PausedStep | null; result: ExecutionResult | null };
  const finishOrPause = async (
    bound: ConfirmRunServices,
    state: ExecutionState,
  ): Promise<Segment> => {
    const paused = await bound.plans.runSteps(state, {
      context: bound.context,
      entitlements: bound.entitlements,
      pauseAt: input.generating,
    });
    return paused
      ? { paused, result: null }
      : { paused: null, result: await bound.plans.complete(state) };
  };

  let state: ExecutionState | undefined;
  let segment: Segment = await input.run(async (db) => {
    const bound = await input.services(db);
    await bound.plans.confirm({
      planId: input.planId,
      planHash: input.planHash,
      token: input.token,
      userId: input.userId,
    });
    state = await bound.plans.begin({ planId: input.planId, userId: input.userId });
    return finishOrPause(bound, state);
  });

  while (segment.paused && state) {
    const paused = segment.paused;
    const running: ExecutionState = state;
    // OUTSIDE ANY TRANSACTION: the model.
    let generated: { readonly generation: GenerationResult } | { readonly error: unknown };
    try {
      generated = { generation: await input.generate(paused, running) };
    } catch (error: unknown) {
      generated = { error };
    }
    segment = await input.run(async (db) => {
      const bound = await input.services(db);
      if (!(await bound.plans.refreshAuthorization(running))) {
        await bound.plans.finishPaused(running, paused, {
          error: new AppError('FORBIDDEN', 'The member no longer belongs to the workspace.'),
        });
      } else if ('error' in generated) {
        await bound.plans.finishPaused(running, paused, { error: generated.error });
      } else {
        try {
          const result = await contentDraftResult(
            bound.context(running.authorization),
            paused.step.arguments,
            generated.generation,
          );
          await bound.plans.finishPaused(running, paused, { result });
        } catch (error: unknown) {
          await bound.plans.finishPaused(running, paused, { error });
        }
      }
      return finishOrPause(bound, running);
    });
  }
  /* c8 ignore next -- the loop ends only with a result. */
  if (!segment.result) throw new AppError('INTERNAL', 'The plan did not finish.');
  return segment.result;
}
