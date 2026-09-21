/**
 * @brandspace/analytics — Phase 7's measurement half.
 *
 * Ingestion, the canonical metric vocabulary, the query and export surfaces, and
 * the evidence machinery that makes a grounded explanation possible. Everything
 * that REASONS about the numbers — strategy, content gaps, Brand Brain
 * write-back — lives in `@brandspace/intelligence`, which imports this.
 */

export {
  DERIVED_METRICS,
  INGESTED_METRICS,
  INGESTED_METRIC_KEYS,
  METRIC_DEFINITIONS,
  METRIC_KEYS,
  computeDerived,
  findMetric,
  isAdditive,
  isLevelMetric,
  aggregationFor,
  isIngestedMetric,
  isMetricKey,
  metricsForProvider,
  providerSupportsMetric,
} from './metrics';
export type { MetricDefinition, MetricKind } from './metrics';

export type {
  AdapterCredentials,
  AnalyticsCapabilities,
  AnalyticsConnectorAdapter,
  FetchFailure,
  FetchOutcome,
  FetchRequest,
  FetchSuccess,
  MetricReading,
} from './adapter';

export { MockAnalyticsConnectorAdapter } from './mock-adapters';
export { createAnalyticsRegistry } from './registry';
export { createMetricWindowPort } from './metric-window';
export type { AnalyticsRegistry, AnalyticsRegistryOptions } from './registry';

export {
  ANALYTICS_CONFIG_DOMAIN,
  TenantAnalyticsPolicySource,
  freshnessFor,
  nextAttemptAfterFailure,
  parseAnalyticsPolicy,
  resolveAnalyticsPolicy,
} from './policy';
export type { AnalyticsCatalogueReader, AnalyticsPolicy } from './policy';

export { observationKeyFor, upsertObservations } from './observations';
export type { ObservationInput, UpsertResult } from './observations';

export {
  AnalyticsIngestionService,
  ensureIngestionCursors,
  normalizeReadings,
  newCorrelationId,
  runIdempotencyKeyFor,
  startOfDay,
} from './ingestion';
export type {
  CredentialResolver,
  IngestionCursorRow,
  IngestionOptions,
  PullResult,
} from './ingestion';

export { AnalyticsQueryService, changeInMilli } from './queries';
export type {
  AnalyticsPeriod,
  AnalyticsQueryOptions,
  AnalyticsScope,
  AnalyticsSummary,
  MetricAbsenceReason,
  MetricValue,
  TimeSeries,
  TimeSeriesPoint,
} from './queries';

export { AnalyticsExportService, EXPORT_COLUMNS, csvCell, csvRow } from './export';
export type { ExportResult } from './export';

export { detectAnomalies } from './anomalies';
export type { Anomaly, AnomalyDirection } from './anomalies';

export {
  buildEvidencePackage,
  digitRuns,
  foldDigits,
  renderEvidence,
  validateGrounding,
  validateGroundedDocument,
} from './evidence';
export type { EvidenceItem, EvidencePackage, GroundingViolation } from './evidence';

export {
  citedOrdinals,
  contentGapSchema,
  explanationSchema,
  parseJsonResponse,
  proseOf,
  strategySchema,
} from './schemas';
export type { ParsedContentGap, ParsedExplanation, ParsedStrategy } from './schemas';

export { AnalyticsInsightService, toEvidenceItem } from './insights';
export type {
  ExplainInput,
  ExplainResult,
  InsightDenialSink,
  InsightServiceOptions,
} from './insights';

export { pruneAnalytics } from './retention';
export type { PruneResult } from './retention';

export {
  analyticsSourceUnavailable,
  analyticsSubjectNotFound,
  explainWindowTooWide,
  explanationFailed,
  exportTooLarge,
  exportWindowTooWide,
  insightNotFound,
  insufficientEvidence,
  ungroundedExplanation,
  unknownMetric,
} from './errors';
