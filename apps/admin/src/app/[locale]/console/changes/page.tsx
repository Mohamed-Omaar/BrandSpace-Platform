import { Card, Stack, colorTokens, spacingTokens, typographyTokens } from '@brandspace/ui';
import type { ConfigDomain } from '@brandspace/config';
import { areaCopy } from '../../../../i18n/simple-areas';
import { formatWhen } from '../../../../components/simple-ui';
import { AREAS } from '../../../../server/simple-areas/registry';
import { getPlatformPrisma, requirePageActor } from '../../../../server/platform-context';

export const dynamic = 'force-dynamic';

/**
 * /changes — every settings change, newest first: who, when, why, and each
 * changed value old -> new (owner decision, Control Center Simple mode).
 *
 * It reads the Configuration Service's own `config.activated` audit events,
 * so a change made in Advanced appears here exactly like one made in Simple —
 * the same row, written by the one method both reach. Credential-like values
 * are masked when the event is written (`configLeafDiff`), never here.
 */
const LIMIT = 50;

interface Change {
  readonly path: string;
  readonly value: unknown;
}

const changesOf = (value: unknown): readonly Change[] => {
  const list = (value as { changes?: unknown } | null)?.changes;
  return Array.isArray(list) ? (list as Change[]) : [];
};

const shown = (value: unknown): string =>
  value === undefined ? '—' : value === null ? '∅' : typeof value === 'string' ? value : JSON.stringify(value);

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
  const actorIds = [...new Set(events.map((event) => event.actorId).filter((id): id is string => typeof id === 'string'))];
  const people = new Map(
    (await prisma.platformUser.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, email: true } })).map((user) => [
      user.id,
      user.name ?? user.email,
    ]),
  );
  const areaOf = (domain: string) =>
    AREAS.find((area) => area.collections.some((collection) => collection.domains.includes(domain as ConfigDomain)));

  return (
    <Stack>
      <p style={{ margin: 0, ...typographyTokens.bodySm, color: colorTokens.textSecondary, maxInlineSize: '68ch' }} data-testid="changes-intro">
        {t('ch2.intro', { count: LIMIT })}
      </p>
      {events.length === 0 ? (
        <Card testId="changes-empty">
          <p style={{ margin: 0, ...typographyTokens.bodySm }}>{t('ui.empty')}</p>
        </Card>
      ) : (
        events.map((event) => {
          const after = changesOf(event.after);
          const before = changesOf(event.before);
          const domain = String((event.after as { domain?: unknown } | null)?.domain ?? '');
          const area = areaOf(domain);
          return (
            <Card key={event.id} testId="change-row">
              <div style={{ display: 'grid', gap: spacingTokens.xs }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens.xs, justifyContent: 'space-between' }}>
                  <h3 style={{ margin: 0, ...typographyTokens.h3 }}>{area ? t(area.title) : domain}</h3>
                  <span style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>{formatWhen(locale, event.occurredAt)}</span>
                </div>
                <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
                  {t('ch2.by', { person: (event.actorId && people.get(event.actorId)) || t('ch2.someone') })}
                </span>
                {event.reason ? <p style={{ margin: 0, ...typographyTokens.bodySm }}>{event.reason}</p> : null}
                {after.length > 0 ? (
                  <ul style={{ margin: 0, paddingInlineStart: spacingTokens.md, ...typographyTokens.caption }} data-testid="change-lines">
                    {after.map((change, index) => (
                      <li key={`${change.path}-${index}`}>
                        <bdi dir="ltr">{change.path}</bdi>: <bdi>{shown(before[index]?.value)}</bdi> → <bdi>{shown(change.value)}</bdi>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p style={{ margin: 0, ...typographyTokens.caption, color: colorTokens.textMuted }}>{t('ch2.noDetail')}</p>
                )}
              </div>
            </Card>
          );
        })
      )}
    </Stack>
  );
}
