import { AppError } from '@brandspace/shared';

/**
 * Intelligence failures, mapped to the stable codes the platform already uses.
 *
 * THE NOT-FOUND SHAPE IS LOAD-BEARING, exactly as it is everywhere else: a brand
 * in another workspace, a brand that never existed, and a brand outside the
 * caller's scope all produce the SAME error with the SAME message.
 */

export function strategyNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Strategy not found.');
}

/**
 * NOT ENOUGH GROUNDING TO PROPOSE A STRATEGY.
 *
 * A REFUSAL, NOT A FAILURE, and free: no gateway call, no reservation, no
 * credits. A model asked to write a strategy for a brand it knows nothing about
 * will write a strategy for a generic brand, and the customer cannot tell the
 * difference until they act on it.
 */
export function insufficientGrounding(input: {
  knowledgeItems: number;
  evidenceItems: number;
  requiredKnowledgeItems: number;
}): AppError {
  return new AppError(
    'VALIDATION_FAILED',
    'There is not enough approved brand knowledge to propose a strategy yet.',
    {
      knowledgeItems: input.knowledgeItems,
      evidenceItems: input.evidenceItems,
      requiredKnowledgeItems: input.requiredKnowledgeItems,
    },
  );
}

export function generationFailed(customerMessage: string | null): AppError {
  return new AppError(
    'INTERNAL',
    customerMessage ?? 'That could not be produced. Nothing was charged.',
  );
}

/**
 * A proposal that must be accepted before it can be acted on has not been.
 *
 * Generated strategy is a PROPOSAL until a permitted human accepts it, and this
 * is what refuses everything that tries to skip that step.
 */
export function proposalNotAccepted(): AppError {
  return new AppError('CONFLICT', 'That proposal has not been accepted yet.');
}
