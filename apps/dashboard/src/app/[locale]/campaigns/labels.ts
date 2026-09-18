import type { MessageKey } from '../../../i18n/messages';
import type { CampaignFormLabels } from './campaign-form-view';

/**
 * The campaign screens' shared label maps.
 *
 * WHY A MODULE AND NOT A CONSTANT IN EACH PAGE. The create page, the detail
 * page and the composer's selector all name the same six objectives and the
 * same six statuses. Three copies of a map from an enum to a message key is
 * three chances for one of them to miss a member the day somebody adds one —
 * and `Record<Key, MessageKey>` here makes that a compile error instead.
 */

export const OBJECTIVE_KEYS = {
  AWARENESS: 'campaigns.objective.AWARENESS',
  ENGAGEMENT: 'campaigns.objective.ENGAGEMENT',
  TRAFFIC: 'campaigns.objective.TRAFFIC',
  LEADS: 'campaigns.objective.LEADS',
  RETENTION: 'campaigns.objective.RETENTION',
  LAUNCH: 'campaigns.objective.LAUNCH',
} as const satisfies Record<string, MessageKey>;

export const STATUS_KEYS = {
  DRAFT: 'campaigns.status.DRAFT',
  PLANNED: 'campaigns.status.PLANNED',
  ACTIVE: 'campaigns.status.ACTIVE',
  PAUSED: 'campaigns.status.PAUSED',
  COMPLETED: 'campaigns.status.COMPLETED',
  ARCHIVED: 'campaigns.status.ARCHIVED',
} as const satisfies Record<string, MessageKey>;

type Translate = (key: MessageKey) => string;

export function objectiveLabel(t: Translate, key: string): string {
  return t(OBJECTIVE_KEYS[key as keyof typeof OBJECTIVE_KEYS] ?? OBJECTIVE_KEYS.AWARENESS);
}

export function statusLabel(t: Translate, key: string): string {
  return t(STATUS_KEYS[key as keyof typeof STATUS_KEYS] ?? STATUS_KEYS.DRAFT);
}

/** Every label the shared campaign form needs, in one place. */
export function formLabels(t: Translate, submit: string): CampaignFormLabels {
  return {
    name: t('campaigns.name'),
    nameHint: t('campaigns.nameHint'),
    objective: t('campaigns.objective'),
    brief: t('campaigns.brief'),
    briefHint: t('campaigns.briefHint'),
    briefAr: t('campaigns.briefAr'),
    briefEn: t('campaigns.briefEn'),
    description: t('campaigns.description'),
    startDate: t('campaigns.startDate'),
    endDate: t('campaigns.endDate'),
    channels: t('campaigns.channels'),
    channelsHint: t('campaigns.channelsHint'),
    status: t('campaigns.status'),
    submit,
    objectiveLabel: (key) => objectiveLabel(t, key),
    statusLabel: (key) => statusLabel(t, key),
  };
}

/** A campaign's period, or an honest sentence saying it has none. */
export function periodLabel(
  start: Date | null,
  end: Date | null,
  locale: string,
  none: string,
): string {
  if (!start && !end) return none;
  const format = (value: Date): string =>
    new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
      // Western Arabic numerals in Arabic by default (CLAUDE.md §4).
      numberingSystem: 'latn',
    }).format(value);
  if (start && end) return `${format(start)} – ${format(end)}`;
  return format((start ?? end) as Date);
}

/** A date as `<input type="date">` wants it, or an empty control. */
export function dateInputValue(value: Date | null): string {
  if (!value) return '';
  return value.toISOString().slice(0, 10);
}

/** The content statuses a campaign's content list can show. */
export const CONTENT_STATUS_KEYS = {
  DRAFT: 'content.status.DRAFT',
  IN_REVIEW: 'content.status.IN_REVIEW',
  CHANGES_REQUESTED: 'content.status.CHANGES_REQUESTED',
  APPROVED: 'content.status.APPROVED',
  SCHEDULED: 'content.status.SCHEDULED',
  PUBLISHING: 'content.status.PUBLISHING',
  PUBLISHED: 'content.status.PUBLISHED',
  PARTIALLY_PUBLISHED: 'content.status.PARTIALLY_PUBLISHED',
  FAILED: 'content.status.FAILED',
  ARCHIVED: 'content.status.ARCHIVED',
} as const satisfies Record<string, MessageKey>;

export function contentStatusLabel(t: Translate, key: string): string {
  return t(
    CONTENT_STATUS_KEYS[key as keyof typeof CONTENT_STATUS_KEYS] ?? CONTENT_STATUS_KEYS.DRAFT,
  );
}
