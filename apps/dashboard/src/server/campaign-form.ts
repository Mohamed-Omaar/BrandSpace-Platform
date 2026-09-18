import { AppError } from '@brandspace/shared';

/**
 * THE CAMPAIGN FORM, DECODED ONCE, AND FAIL-CLOSED.
 *
 * NOT `server-only`. The rules below are the whole point of the file and the
 * unit suite asserts them directly; a module the tests cannot import is a
 * module whose rules are asserted only through a browser (the Phase 7 round-5
 * lesson, recorded on `automation-form.ts`).
 *
 * MISSING IS NOT EMPTY, AND NEITHER IS A CHOICE (D-184). Every control the
 * screen renders is submitted by a real browser, so a field that is ABSENT did
 * not come from the screen and is refused rather than defaulted. A field that
 * is PRESENT AND BLANK is the author clearing it, which is a different
 * instruction and gets a different answer.
 *
 * NOTHING HERE TOUCHES THE DATABASE. It turns a `FormData` into a value the
 * `CampaignService` will accept, and the service still re-checks everything it
 * cares about — the brand scope, the version, the date order. A decoder is the
 * first gate, never the only one.
 */

export const CAMPAIGN_OBJECTIVES = [
  'AWARENESS',
  'ENGAGEMENT',
  'TRAFFIC',
  'LEADS',
  'RETENTION',
  'LAUNCH',
] as const;
export type CampaignObjectiveKey = (typeof CAMPAIGN_OBJECTIVES)[number];

/**
 * The statuses a CUSTOMER may set from the screen.
 *
 * `ARCHIVED` is deliberately absent: archiving is its own action with its own
 * audit event and its own soft delete, and letting it arrive as a dropdown
 * value would give one state two doors with two different behaviours behind
 * them.
 */
export const CAMPAIGN_STATUSES = ['DRAFT', 'PLANNED', 'ACTIVE', 'PAUSED', 'COMPLETED'] as const;
export type CampaignStatusKey = (typeof CAMPAIGN_STATUSES)[number];

const NAME_MAX = 160;
const BRIEF_MAX = 4000;
const DESCRIPTION_MAX = 2000;

export interface CampaignFormInput {
  readonly name: string;
  readonly objective: CampaignObjectiveKey;
  readonly brief: { ar: string; en: string } | undefined;
  readonly description: string | null;
  readonly startDate: Date | null;
  readonly endDate: Date | null;
  readonly channels: readonly string[];
  readonly status: CampaignStatusKey | undefined;
}

function refuse(field: string): AppError {
  return new AppError('VALIDATION_FAILED', `The ${field} field was not submitted.`);
}

/** A present-but-blank text field, distinguished from an absent one. */
function textField(form: FormData, key: string): string {
  const raw = form.get(key);
  if (raw === null) throw refuse(key);
  return String(raw);
}

/**
 * A DATE, OR NOTHING, AND NEVER A SILENT TODAY.
 *
 * `<input type="date">` submits `''` when the author has cleared it, which
 * means "no date" rather than "the epoch" — and `new Date('')` is `Invalid
 * Date`, which Prisma would happily try to write. An unparseable value that is
 * NOT empty is a refusal, because it did not come from the control.
 */
function dateField(form: FormData, key: string): Date | null {
  const raw = textField(form, key).trim();
  if (raw === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new AppError('VALIDATION_FAILED', `The ${key} field is not a date.`);
  }
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError('VALIDATION_FAILED', `The ${key} field is not a date.`);
  }
  return parsed;
}

/**
 * Decode the create/edit form.
 *
 * `allowedChannels` is the ACTIVATED platform list (CLAUDE.md §2.2) — the set
 * of platforms is an operator's fact, so this function is told what is legal
 * rather than knowing it. A channel outside the list is refused rather than
 * dropped: silently discarding a checkbox the screen offered would tell the
 * author their campaign covers a platform it does not.
 */
export function campaignFormFrom(
  form: FormData,
  options: { readonly allowedChannels: readonly string[]; readonly withStatus: boolean },
): CampaignFormInput {
  const name = textField(form, 'name').trim();
  if (name === '') throw new AppError('VALIDATION_FAILED', 'A campaign needs a name.');
  if (name.length > NAME_MAX) {
    throw new AppError('VALIDATION_FAILED', 'That campaign name is too long.');
  }

  const objective = textField(form, 'objective');
  if (!CAMPAIGN_OBJECTIVES.includes(objective as CampaignObjectiveKey)) {
    throw new AppError('VALIDATION_FAILED', 'That objective is not one this product offers.');
  }

  const briefAr = textField(form, 'briefAr').trim().slice(0, BRIEF_MAX);
  const briefEn = textField(form, 'briefEn').trim().slice(0, BRIEF_MAX);
  /*
   * BOTH LOCALES OR NEITHER. The column is `{ ar, en }` and both are
   * first-class (CLAUDE.md §4); writing one side and leaving the other empty
   * would produce a brief that reads as missing in one language and present in
   * the other, which is worse than having none.
   */
  const brief = briefAr === '' && briefEn === '' ? undefined : { ar: briefAr, en: briefEn };

  const descriptionRaw = textField(form, 'description').trim();
  const description = descriptionRaw === '' ? null : descriptionRaw.slice(0, DESCRIPTION_MAX);

  const startDate = dateField(form, 'startDate');
  const endDate = dateField(form, 'endDate');
  if (startDate && endDate && endDate < startDate) {
    throw new AppError('VALIDATION_FAILED', 'A campaign cannot end before it starts.');
  }

  const channels = form.getAll('channels').map((value) => String(value));
  for (const channel of channels) {
    if (!options.allowedChannels.includes(channel)) {
      throw new AppError('VALIDATION_FAILED', 'That channel is not an enabled platform.');
    }
  }
  // De-duplicated, because a repeated checkbox name is a submission artefact
  // rather than an instruction to list a platform twice.
  const uniqueChannels = [...new Set(channels)];

  let status: CampaignStatusKey | undefined;
  if (options.withStatus) {
    const raw = textField(form, 'status');
    if (!CAMPAIGN_STATUSES.includes(raw as CampaignStatusKey)) {
      throw new AppError('VALIDATION_FAILED', 'That status is not one a campaign can be set to.');
    }
    status = raw as CampaignStatusKey;
  }

  return {
    name,
    objective: objective as CampaignObjectiveKey,
    brief,
    description,
    startDate,
    endDate,
    channels: uniqueChannels,
    status,
  };
}

/**
 * The localized brief, read back defensively.
 *
 * The column is `Json?`, so what comes out is `unknown` — a value written by an
 * older shape, by a migration, or by a hand-edited row. A reader that assumed
 * `{ar, en}` would throw on a page render; this returns empty strings and lets
 * the screen show an empty field, which is the honest rendering of "there is
 * nothing here to show".
 */
export function briefFrom(value: unknown): { ar: string; en: string } {
  if (typeof value !== 'object' || value === null) return { ar: '', en: '' };
  const record = value as Record<string, unknown>;
  return {
    ar: typeof record['ar'] === 'string' ? record['ar'] : '',
    en: typeof record['en'] === 'string' ? record['en'] : '',
  };
}
