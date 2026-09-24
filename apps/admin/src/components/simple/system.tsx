import type { AuthenticatedPlatformActor } from '@brandspace/auth';
import {
  Card,
  ContentGrid,
  Stack,
  StatusBadge,
  colorTokens,
  spacingTokens,
  typographyTokens,
  type BadgeTone,
} from '@brandspace/ui';
import { fill, simpleCopy, type SimpleKey } from '../../i18n/simple';
import { loadBillingIssues, loadReadiness, loadSystemState } from '../../server/owner-overview';
import type { ReadinessArea } from '../../server/owner-readiness';
import { AdvancedLink } from '../mode-switch';
import { ActionLink, formatCount, reasonText } from '../simple-ui';

/**
 * SYSTEM, IN THE OWNER'S WORDS (contract §18).
 *
 * The source of truth is unchanged: the database probe and `evaluateHealth`
 * verdict the health page and `/health/ready` use, the Integrations Hub's
 * views, and the billing inbox. This screen only translates. Where the
 * Control Center measures nothing — the background job queue — it says so
 * rather than drawing a green light.
 */

export type SystemWord =
  'operational' | 'attention' | 'setup' | 'down' | 'connectionIssue' | 'notMeasured' | 'withheld';

const TONE: Record<SystemWord, BadgeTone> = {
  operational: 'success',
  attention: 'warning',
  setup: 'neutral',
  down: 'danger',
  connectionIssue: 'danger',
  notMeasured: 'neutral',
  withheld: 'neutral',
};

function wordFor(area: ReadinessArea): SystemWord {
  switch (area.state) {
    case 'ready':
      return 'operational';
    case 'test_double':
      return area.required ? 'setup' : 'operational';
    case 'needs_attention':
      return area.reason === 'failed' ? 'connectionIssue' : 'attention';
    case 'setup_required':
    case 'disabled':
      return 'setup';
    case 'withheld':
      return 'withheld';
  }
}

function label(locale: string, word: SystemWord): string {
  const copy = simpleCopy(locale);
  if (word === 'withheld') return copy('state.withheld');
  return copy(`sys.${word}` as SimpleKey);
}

interface Row {
  readonly key: string;
  readonly title: string;
  readonly word: SystemWord;
  readonly detail: string;
  readonly href: string | null;
}

/**
 * The System screen's rows and overall word — ONE computation, used by the
 * System screen and by Home's "System" tile, so the two can never disagree.
 */
export function systemView(
  locale: string,
  system: Awaited<ReturnType<typeof loadSystemState>>,
  readiness: Awaited<ReturnType<typeof loadReadiness>>,
  billing: Awaited<ReturnType<typeof loadBillingIssues>>,
): { readonly rows: readonly Row[]; readonly overall: SystemWord } {
  const copy = simpleCopy(locale);
  const base = `/${locale}/console`;
  const rows: Row[] = [
    {
      key: 'database',
      title: copy('sys.database'),
      word: system.databaseOk ? 'operational' : 'down',
      detail: system.databaseOk ? copy('sys.database.ok') : copy('sys.database.down'),
      href: null,
    },
    {
      key: 'jobs',
      title: copy('sys.jobs'),
      word: 'notMeasured',
      detail: copy('sys.jobs.detail'),
      href: null,
    },
    ...readiness.areas
      .filter((area) => area.key !== 'plans')
      .map((area) => ({
        key: area.key,
        title: copy(`area.${area.key}` as SimpleKey),
        word: wordFor(area),
        detail: reasonText(locale, area),
        href: area.state === 'withheld' ? null : `${base}${area.href}`,
      })),
    {
      key: 'billing',
      title: copy('sys.billing'),
      word: billing.count > 0 ? 'attention' : 'operational',
      detail:
        billing.count > 0
          ? fill(copy('sys.billing.stuck'), {
              count: billing.capped ? '200+' : formatCount(locale, billing.count),
            })
          : copy('sys.billing.ok'),
      href: billing.count > 0 ? `${base}/usage#billing` : null,
    },
    {
      key: 'monitoring',
      title: copy('sys.monitoring'),
      word: system.tracingExporting ? 'operational' : 'setup',
      detail: system.tracingExporting ? copy('sys.monitoring.ok') : copy('sys.monitoring.off'),
      href: null,
    },
  ];

  /*
   * The overall word. `Not operational` only when the readiness verdict says
   * so (a required dependency is down). A problem somewhere is `Needs
   * attention`; a gap that is only missing setup is `Setup required`.
   */
  const overall: SystemWord =
    system.report.status === 'not_ready'
      ? 'down'
      : rows.some((row) => row.word === 'attention' || row.word === 'connectionIssue')
        ? 'attention'
        : readiness.areas.some(
              (area) => area.required && area.state !== 'ready' && area.state !== 'withheld',
            )
          ? 'setup'
          : 'operational';
  return { rows, overall };
}

/** The word for a system state, in the reader's language. */
export function systemLabel(locale: string, word: SystemWord): string {
  return label(locale, word);
}

export async function SimpleSystem({
  locale,
  actor,
}: {
  readonly locale: string;
  readonly actor: AuthenticatedPlatformActor;
}) {
  const copy = simpleCopy(locale);
  const [system, readiness, billing] = await Promise.all([
    loadSystemState(),
    loadReadiness(actor),
    loadBillingIssues(),
  ]);

  const { rows, overall } = systemView(locale, system, readiness, billing);

  return (
    <Stack>
      <p
        style={{
          margin: 0,
          ...typographyTokens.bodySm,
          color: colorTokens.textSecondary,
          maxInlineSize: '68ch',
        }}
      >
        {copy('sys.intro')}
      </p>
      <Card testId="system-overall">
        <div
          style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: spacingTokens.sm }}
        >
          <span style={{ ...typographyTokens.h3 }}>{copy('sys.overall')}</span>
          <StatusBadge
            label={label(locale, overall)}
            tone={TONE[overall]}
            dot
            testId="system-overall-state"
          />
        </div>
      </Card>
      <ContentGrid min="16rem" testId="system-rows">
        {rows.map((row) => (
          <Card key={row.key} testId={`system-${row.key}`}>
            <div style={{ display: 'grid', gap: spacingTokens.xs }}>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  justifyContent: 'space-between',
                  gap: spacingTokens.xs,
                }}
              >
                <h3 style={{ margin: 0, ...typographyTokens.h3 }}>{row.title}</h3>
                <StatusBadge
                  label={label(locale, row.word)}
                  tone={TONE[row.word]}
                  dot
                  testId={`system-${row.key}-state`}
                />
              </div>
              <p
                style={{ margin: 0, ...typographyTokens.bodySm, color: colorTokens.textSecondary }}
              >
                {row.detail}
              </p>
              {row.href && row.word !== 'operational' ? (
                <div>
                  <ActionLink href={row.href} testId={`system-${row.key}-fix`}>
                    {copy('common.fix')}
                  </ActionLink>
                </div>
              ) : null}
            </div>
          </Card>
        ))}
      </ContentGrid>
      <div>
        <AdvancedLink
          locale={locale}
          href="/health"
          label={copy('mode.technicalDetails')}
          testId="system-technical"
        />
      </div>
    </Stack>
  );
}
