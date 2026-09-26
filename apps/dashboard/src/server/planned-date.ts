import 'server-only';
import { calendarMarkers, formatLocalTime } from '@brandspace/content';
import { TenantOnboardingPolicySource, industryKeyFor } from '@brandspace/onboarding';
import { systemClock } from '@brandspace/shared';
import { currentEnvironment } from './customer-context';
import { inContentStudio } from './content-context';

/**
 * G6 (D-329) — THE DAY A ★ CHIP OPENED THE STUDIO FOR.
 *
 * `?date=YYYY-MM-DD` from the calendar. Accepted only as a date shape and only
 * when it has not passed in the WORKSPACE's zone; anything else is ignored, not
 * refused — a stale link opens an ordinary Studio. When the day is one of the
 * workspace's holidays or its brands' observances, its name comes back too.
 * The date only PROPOSES: the calendar validates the slot like any other.
 */
export async function plannedDateFrom(
  raw: string | undefined,
  workspaceId: string,
  locale: string,
): Promise<{ readonly date: string; readonly label: string | null } | null> {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return inContentStudio(workspaceId, async (services) => {
    const [calendar, policy] = await Promise.all([services.calendar(), services.policy()]);
    const today = formatLocalTime(systemClock.now(), calendar.timezone).slice(0, 10);
    if (raw < today) return null;
    const [workspace, onboarding, brands] = await Promise.all([
      services.db.workspace.findUnique({ where: { id: workspaceId }, select: { country: true } }),
      new TenantOnboardingPolicySource(services.db, currentEnvironment()).load(),
      services.db.brand.findMany({ where: { deletedAt: null }, select: { industry: true } }),
    ]);
    const keys = brands
      .map((brand) => industryKeyFor(brand.industry, onboarding.industries))
      .filter((key): key is string => key !== null);
    const markers = [
      ...calendarMarkers(policy.calendar, {
        country: workspace?.country ?? null,
        industryKey: null,
        from: raw,
        to: raw,
      }),
      ...keys.flatMap((industryKey) =>
        calendarMarkers(policy.calendar, { country: null, industryKey, from: raw, to: raw }),
      ),
    ];
    const first = markers[0];
    return {
      date: raw,
      label: first ? (locale === 'ar' ? first.name.ar : first.name.en) : null,
    };
  });
}
