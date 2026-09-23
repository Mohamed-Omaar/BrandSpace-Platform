/**
 * @brandspace/intelligence — Phase 7's reasoning half.
 *
 * Strategy, monthly plans, content-gap analysis and the Brand Brain write-back
 * D-64 left open. Everything it reasons ABOUT comes from `@brandspace/analytics`;
 * everything it writes to the brand goes through `@brandspace/brand-brain`'s
 * existing review governance rather than a second approval system.
 */

export { StrategyService } from './strategy';
export type { StrategyInput, StrategyResult, StrategyServiceOptions } from './strategy';

export {
  LEARNING_INFERENCE_VERSION,
  LearningWriteBackService,
  confidenceFor,
  notifyLearningReviewers,
} from './learning';
export type { LearningServiceOptions, ProposedLearning, WriteBackResult } from './learning';

export {
  generationFailed,
  insufficientGrounding,
  proposalNotAccepted,
  strategyNotFound,
} from './errors';
