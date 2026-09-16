import { writeAuditEvent, type MetricUnit, type TenantScopedClient } from '@brandspace/database';
import {
  assertBrandInScope,
  brandIdQueryFilter,
  type Clock,
  systemClock,
} from '@brandspace/shared';
import { exportTooLarge, exportWindowTooWide } from './errors';
import type { AnalyticsPolicy } from './policy';
import type { AnalyticsPeriod, AnalyticsScope } from './queries';

/**
 * TENANT-SAFE ANALYTICS EXPORT.
 *
 * FOUR THINGS AN EXPORT CAN GET WRONG, and all four are closed here rather than
 * hoped for:
 *
 *  1. IT CAN LEAK ANOTHER TENANT'S ROWS. The query runs on the tenant-scoped
 *     client inside `withWorkspace`, so RLS constrains it; the explicit
 *     `workspaceId` is the second layer; and `brandIdQueryFilter` makes
 *     BrandScope a PREDICATE rather than a filter applied to a wider result.
 *     There is no path here that reads a row it then decides not to print.
 *
 *  2. IT CAN LEAK INTERNALS. The column list is an ALLOW-LIST written out below.
 *     `SELECT *` would carry `observationKey`, `ingestionRunId` and the internal
 *     row ids into a file a customer forwards to an agency — none of which is
 *     theirs to reason about, and the first of which is a fingerprint of our
 *     idempotency scheme. No token, no storage key, no provider payload and no
 *     internal id appears in an exported row.
 *
 *  3. IT CAN BE A SPREADSHEET ATTACK. A cell beginning `=`, `+`, `-`, `@`, a tab
 *     or a carriage return is executed as a FORMULA by Excel, Numbers and Google
 *     Sheets. Provider-supplied text — an account display name — reaches these
 *     cells, so `csvCell` prefixes a single quote before quoting. This is the
 *     one CSV rule that is a security control rather than a formatting nicety.
 *
 *  4. IT CAN BE UNBOUNDED. A range covering three years of a busy workspace is a
 *     memory exhaustion dressed as a feature request. The window and the row
 *     count are both bounded by the activated policy, and the customer is told
 *     the ceiling rather than handed a truncated file that looks complete.
 */

/** Characters a spreadsheet treats as the start of a formula. */
const FORMULA_PREFIXES = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * One CSV cell, quoted and de-fanged.
 *
 * ALWAYS QUOTED, not "quoted when it contains a comma". A conditional quoting
 * rule is one edge case away from a field that breaks the file, and the cost of
 * quoting everything is two bytes.
 */
export function csvCell(value: string | number | bigint | Date | null | undefined): string {
  if (value === null || value === undefined) return '""';
  const raw =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'bigint'
        ? value.toString()
        : String(value);

  // THE FORMULA GUARD. A leading apostrophe makes a spreadsheet treat the cell as
  // text; the value the customer reads is unchanged.
  const guarded = raw.length > 0 && FORMULA_PREFIXES.has(raw[0] as string) ? `'${raw}` : raw;
  return `"${guarded.replace(/"/g, '""')}"`;
}

export function csvRow(
  cells: readonly (string | number | bigint | Date | null | undefined)[],
): string {
  return cells.map(csvCell).join(',');
}

/** The exported columns, in order. An ALLOW-LIST, not a projection of the row. */
export const EXPORT_COLUMNS = [
  'brand',
  'platform',
  'account',
  'subject_type',
  'content_title',
  'metric',
  'value',
  'unit',
  'granularity',
  'period_start',
  'period_end',
  'observed_at',
  'source',
] as const;

export interface ExportOptions {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly policy: AnalyticsPolicy;
  readonly clock?: Clock;
}

export interface ExportResult {
  readonly csv: string;
  readonly rowCount: number;
  /** True when any exported row came from a MOCK source. Stated in the file. */
  readonly containsMockData: boolean;
}

export class AnalyticsExportService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #policy: AnalyticsPolicy;
  readonly #clock: Clock;

  constructor(options: ExportOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#policy = options.policy;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Export observations as CSV.
   *
   * THE SAME FILTERS AND THE SAME RANGE AS THE SCREEN. The scope and period this
   * takes are the ones the UI passes to `AnalyticsQueryService`, so an export can
   * never contain more than what was on the page — which is the property that
   * makes "export what I am looking at" true rather than approximately true.
   */
  async toCsv(input: {
    scope: AnalyticsScope;
    period: AnalyticsPeriod;
    brandScope: readonly string[];
    actorUserId: string;
    metricKeys?: readonly string[] | undefined;
  }): Promise<ExportResult> {
    if (input.scope.brandId) assertBrandInScope(input.brandScope, input.scope.brandId);

    const days =
      (input.period.end.getTime() - input.period.start.getTime()) / (24 * 60 * 60 * 1_000);
    if (days > this.#policy.export.maxWindowDays) {
      throw exportWindowTooWide(this.#policy.export.maxWindowDays);
    }

    const where = {
      workspaceId: this.#workspaceId,
      ...brandIdQueryFilter({ brandId: input.scope.brandId, brandScope: input.brandScope }),
      ...(input.scope.socialConnectionId
        ? { socialConnectionId: input.scope.socialConnectionId }
        : {}),
      ...(input.scope.provider ? { provider: input.scope.provider } : {}),
      ...(input.scope.contentItemId ? { contentItemId: input.scope.contentItemId } : {}),
      ...(input.scope.subjectType ? { subjectType: input.scope.subjectType } : {}),
      ...(input.scope.campaignId ? { item: { is: { campaignId: input.scope.campaignId } } } : {}),
      ...(input.metricKeys?.length ? { metricKey: { in: [...input.metricKeys] } } : {}),
      periodStart: { gte: input.period.start },
      periodEnd: { lte: input.period.end },
    };

    /*
     * THE COUNT IS TAKEN BEFORE THE ROWS. A customer asking for something too
     * large is told so, with the ceiling, rather than handed the first fifty
     * thousand rows of a two-hundred-thousand-row answer — which would be a file
     * that looks complete and is not.
     */
    const total = await this.#db.metricObservation.count({ where });
    if (total > this.#policy.export.maxRows) throw exportTooLarge(this.#policy.export.maxRows);

    const rows = await this.#db.metricObservation.findMany({
      where,
      orderBy: [{ periodStart: 'asc' }, { metricKey: 'asc' }],
      // THE ALLOW-LIST. Ids, the observation key and the run link are absent by
      // construction rather than by remembering to omit them.
      select: {
        subjectType: true,
        subjectExternalId: true,
        provider: true,
        metricKey: true,
        value: true,
        unit: true,
        granularity: true,
        periodStart: true,
        periodEnd: true,
        observedAt: true,
        sourceKind: true,
        brand: { select: { name: true } },
        connection: { select: { displayName: true } },
        item: { select: { title: true } },
      },
    });

    const lines = [csvRow([...EXPORT_COLUMNS])];
    let containsMockData = false;
    for (const row of rows) {
      if (row.sourceKind === 'MOCK') containsMockData = true;
      lines.push(
        csvRow([
          row.brand?.name ?? '',
          row.provider,
          // The ACCOUNT'S DISPLAY NAME, which is public on the platform — never
          // its external id, which is an identifier a customer has no use for and
          // that reads as an internal handle.
          row.connection?.displayName ?? '',
          row.subjectType,
          row.item?.title ?? '',
          row.metricKey,
          row.value,
          unitLabel(row.unit),
          row.granularity,
          row.periodStart,
          row.periodEnd,
          row.observedAt,
          row.sourceKind,
        ]),
      );
    }

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'analytics.exported',
      actorType: 'USER',
      actorId: input.actorUserId,
      resourceType: 'MetricObservation',
      ...(input.scope.brandId ? { brandId: input.scope.brandId } : {}),
      // COUNTS AND A RANGE, never the data. An audit record that carried the rows
      // would be a second copy of the export in a table nobody expects one in.
      after: {
        rowCount: rows.length,
        periodStart: input.period.start.toISOString(),
        periodEnd: input.period.end.toISOString(),
        containsMockData,
      },
    });

    return { csv: lines.join('\r\n') + '\r\n', rowCount: rows.length, containsMockData };
  }

  /** The filename a download is offered under. No customer text, no path. */
  filenameFor(period: AnalyticsPeriod): string {
    const stamp = this.#clock.now().toISOString().slice(0, 10);
    const from = period.start.toISOString().slice(0, 10);
    const to = period.end.toISOString().slice(0, 10);
    return `brandspace-analytics-${from}_${to}-${stamp}.csv`;
  }
}

/** A stable, non-localized unit token. The UI renders its own words. */
function unitLabel(unit: MetricUnit): string {
  switch (unit) {
    case 'COUNT':
      return 'count';
    case 'RATIO_MILLI':
      return 'per_mille';
    case 'SECONDS':
      return 'seconds';
    case 'DELTA':
      return 'delta';
  }
}
