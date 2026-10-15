import { Card, Stack, colorTokens, spacingTokens, typographyTokens } from '@brandspace/ui';
import { CONFIG_DOMAIN_KEYS, isConfigDomain, parseConfigPayload } from '@brandspace/config';
import { areaCopy } from '../../../../i18n/simple-areas';
import { domainName } from '../../../../i18n/simple-names';
import { formatWhen } from '../../../../components/simple-ui';
import { plainChange } from '../../../../server/simple-areas/history';
import { areaContext, loadDocs } from '../../../../server/simple-areas/runtime';
import { getPlatformPrisma, requirePageActor } from '../../../../server/platform-context';

export const dynamic = 'force-dynamic';

/**
 * /changes — every settings change, newest first: who, when, why, and each
 * changed value old -> new (owner decision, Control Center Simple mode).
 *
 * It reads the Configuration Service's own `config.activated` audit events,
 * so a change made in Advanced appears here exactly like one made in Simple —
 * the same row, written by the one method both reach.
 *
 * Each row is read through the cards (`plainChange`): the item's name and the
 * editor's own field labels and values, never the stored path the event keeps
 * for Advanced. A change no card shows is counted and left to Advanced.
 */
const LIMIT = 50;

const field = (value: unknown, name: string): unknown =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[name]
    : undefined;

const countOf = (value: unknown): number => {
  const list = field(value, 'changes');
  return Array.isArray(list) ? list.length : 0;
};

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  await requirePageActor(locale, 'platform.audit.read');
  const t = areaCopy(locale);
  const prisma = getPlatformPrisma();
  const events = await prisma.auditEvent.findMany({
    where: { action: 'config.activated' },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    take: LIMIT,
  });
  const actorIds = [
    ...new Set(
      events.map((event) => event.actorId).filter((id): id is string => typeof id === 'string'),
    ),
  ];
  const people = new Map(
    (
      await prisma.platformUser.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, name: true, email: true },
      })
    ).map((user) => [user.id, user.name ?? user.email]),
  );

  // The two versions each event moved between, read once for the whole page.
  const activated = await prisma.configurationVersion.findMany({
    where: {
      id: { in: events.map((event) => event.resourceId).filter((id): id is string => !!id) },
    },
    select: { id: true, domain: true, environment: true, payload: true },
  });
  const byId = new Map(activated.map((version) => [version.id, version]));
  const previousKeys = events.flatMap((event) => {
    const version = event.resourceId ? byId.get(event.resourceId) : undefined;
    const number = field(event.before, 'versionNumber');
    return version && typeof number === 'number'
      ? [{ domain: version.domain, environment: version.environment, versionNumber: number }]
      : [];
  });
  const previous = previousKeys.length
    ? await prisma.configurationVersion.findMany({
        where: { OR: previousKeys },
        select: { domain: true, environment: true, versionNumber: true, payload: true },
      })
    : [];
  const previousOf = (domain: string, environment: string, versionNumber: number) =>
    previous.find(
      (v) =>
        v.domain === domain && v.environment === environment && v.versionNumber === versionNumber,
    );
  const docs = await loadDocs(CONFIG_DOMAIN_KEYS);
  const ctx = await areaContext(locale, docs);
  const read = (domain: string, payload: unknown) =>
    isConfigDomain(domain)
      ? (parseConfigPayload(domain, payload) as unknown as Record<string, unknown>)
      : null;

  return (
    <Stack>
      <p
        style={{
          margin: 0,
          ...typographyTokens.bodySm,
          color: colorTokens.textSecondary,
          maxInlineSize: '68ch',
        }}
        data-testid="changes-intro"
      >
        {t('ch2.intro', { count: LIMIT })}
      </p>
      {events.length === 0 ? (
        <Card testId="changes-empty">
          <p style={{ margin: 0, ...typographyTokens.bodySm }}>{t('ui.empty')}</p>
        </Card>
      ) : (
        events.map((event) => {
          const domain = String(field(event.after, 'domain') ?? '');
          const version = event.resourceId ? byId.get(event.resourceId) : undefined;
          const number = field(event.before, 'versionNumber');
          const was =
            version && typeof number === 'number'
              ? previousOf(version.domain, version.environment, number)
              : undefined;
          const now = version && isConfigDomain(domain) ? read(domain, version.payload) : null;
          const plain =
            now && isConfigDomain(domain)
              ? plainChange({
                  domain,
                  before: was ? read(domain, was.payload) : null,
                  after: now,
                  docs,
                  ctx,
                })
              : { area: null, lines: [] };
          const technical = countOf(event.after);
          return (
            <Card key={event.id} testId="change-row">
              <div style={{ display: 'grid', gap: spacingTokens.xs }}>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: spacingTokens.xs,
                    justifyContent: 'space-between',
                  }}
                >
                  <h3 style={{ margin: 0, ...typographyTokens.h3 }}>
                    {plain.area
                      ? t(plain.area.title)
                      : t('ch2.technical', { name: domainName(locale, domain) })}
                  </h3>
                  <span style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
                    {formatWhen(locale, event.occurredAt)}
                  </span>
                </div>
                <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
                  {t('ch2.by', {
                    person: (event.actorId && people.get(event.actorId)) || t('ch2.someone'),
                  })}
                </span>
                {event.reason ? (
                  <p style={{ margin: 0, ...typographyTokens.bodySm }} data-testid="change-reason">
                    {event.reason}
                  </p>
                ) : null}
                {plain.lines.length > 0 ? (
                  <ul
                    style={{
                      margin: 0,
                      paddingInlineStart: spacingTokens.md,
                      ...typographyTokens.caption,
                    }}
                    data-testid="change-lines"
                  >
                    {plain.lines.map((line, index) => (
                      <li key={`${line.label}-${index}`}>
                        <bdi>{line.label}</bdi>: <bdi>{line.before}</bdi> → <bdi>{line.after}</bdi>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p
                    style={{ margin: 0, ...typographyTokens.caption, color: colorTokens.textMuted }}
                  >
                    {technical > 0
                      ? t('w.technicalChanges', { count: technical })
                      : t('ch2.noDetail')}
                  </p>
                )}
              </div>
            </Card>
          );
        })
      )}
    </Stack>
  );
}
