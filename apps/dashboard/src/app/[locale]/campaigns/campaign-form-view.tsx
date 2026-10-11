import Link from 'next/link';
import type { ReactNode } from 'react';
import type { MessageKey } from '../../../i18n/messages';
import {
  CAMPAIGN_OBJECTIVES,
  CAMPAIGN_STATUSES,
  PLANNED_POSTS_MAX,
} from '../../../server/campaign-form';
import { ChannelMark } from '../calendar/prototype-calendar';
import { PlannedPostsStepper } from './campaign-dialog';

/**
 * THE CAMPAIGN FORM, WRITTEN ONCE AND RENDERED TWICE — now the body of the
 * prototype's 560px campaign dialog (D-496; `Main.dc.html` L1574–1593).
 *
 * Create and edit differ in the action they post to, whether a status can be
 * set and whether "Archive" is offered, so they share this. Two hand-written
 * copies of one form is how two forms end up validating differently, which is
 * the defect the Settings navigation already taught this repository (D-197).
 *
 * THE PROTOTYPE'S ORDER AND CONTROLS: name, the two dates, objective chips
 * (one choice), channel chips (several), "Planned posts" − n +, internal
 * notes, the error line, then the footer — "Archive" at the start, Cancel and
 * the submit at the end. The chips are real radios and checkboxes inside
 * `.bsp-chip.bsp-lk-chip`, so the form posts without script.
 *
 * KEPT FROM THE PRODUCT (D-468 (a)), which the prototype's dialog does not
 * draw: the brief in both languages (the campaign's own field, prefilled from
 * Strategy, D-292) and, when editing, the status. A brand choice appears only
 * when Campaigns is on "All brands" with more than one brand (D-191).
 */

export interface CampaignFormValues {
  readonly name: string;
  readonly objective: string;
  readonly briefAr: string;
  readonly briefEn: string;
  readonly description: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly channels: readonly string[];
  readonly status: string;
  readonly plannedPostCount: number;
}

export interface CampaignFormLabels {
  readonly name: string;
  readonly namePh: string;
  readonly brand: string;
  readonly objective: string;
  readonly brief: string;
  readonly briefAr: string;
  readonly briefEn: string;
  readonly description: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly channels: string;
  readonly plannedPosts: string;
  readonly fewer: string;
  readonly more: string;
  readonly status: string;
  readonly cancel: string;
  readonly submit: string;
  readonly objectiveLabel: (key: string) => string;
  readonly statusLabel: (key: string) => string;
}

export interface PlatformOption {
  readonly key: string;
  readonly label: string;
}

export function CampaignFormView({
  action,
  formId,
  hidden,
  values,
  labels,
  platforms,
  withStatus,
  brands,
  cancelHref,
  error,
  footerStart,
  testId,
}: {
  readonly action: (formData: FormData) => Promise<void>;
  readonly formId: string;
  /** `locale`, and either `brandId` (create) or `campaignId` + `version` (edit). */
  readonly hidden: Readonly<Record<string, string>>;
  readonly values: CampaignFormValues;
  readonly labels: CampaignFormLabels;
  readonly platforms: readonly PlatformOption[];
  readonly withStatus: boolean;
  /** Create on "All brands" with several brands: the brand is chosen here. */
  readonly brands?: readonly { readonly id: string; readonly name: string }[] | undefined;
  readonly cancelHref: string;
  readonly error?: string | null | undefined;
  /** The footer's start: the two-step "Archive" when editing. */
  readonly footerStart?: ReactNode;
  readonly testId: string;
}) {
  return (
    <>
      <form id={formId} action={action} className="bsp-cp-form" data-testid={testId}>
        {Object.entries(hidden).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}

        <label className="bsp-cp-field">
          <span className="bsp-lbl">{labels.name}</span>
          <input
            className="bs-control bsp-cp-in"
            name="name"
            defaultValue={values.name}
            placeholder={labels.namePh}
            maxLength={160}
            required
            dir="auto"
            data-testid="campaign-name"
          />
        </label>

        {brands && brands.length > 1 ? (
          <label className="bsp-cp-field">
            <span className="bsp-lbl">{labels.brand}</span>
            <select
              className="bs-control bsp-cp-in"
              name="brandId"
              required
              defaultValue=""
              data-testid="campaign-brand"
            >
              <option value="" disabled>
                {labels.brand}
              </option>
              {brands.map((brand) => (
                <option key={brand.id} value={brand.id}>
                  {brand.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <div className="bsp-cp-dates">
          <label className="bsp-cp-field">
            <span className="bsp-lbl">{labels.startDate}</span>
            <input
              className="bs-control bsp-cp-in bsp-cp-date"
              name="startDate"
              type="date"
              defaultValue={values.startDate}
              data-testid="campaign-start"
            />
          </label>
          <label className="bsp-cp-field">
            <span className="bsp-lbl">{labels.endDate}</span>
            <input
              className="bs-control bsp-cp-in bsp-cp-date"
              name="endDate"
              type="date"
              defaultValue={values.endDate}
              data-testid="campaign-end"
            />
          </label>
        </div>

        <div
          className="bsp-cp-group"
          role="radiogroup"
          aria-labelledby={`${formId}-objective`}
          data-testid="campaign-objective"
        >
          <span className="bsp-lbl" id={`${formId}-objective`}>
            {labels.objective}
          </span>
          <div className="bsp-cp-chips">
            {CAMPAIGN_OBJECTIVES.map((objective) => (
              <label key={objective} className="bsp-chip bsp-lk-chip">
                <input
                  type="radio"
                  name="objective"
                  value={objective}
                  defaultChecked={values.objective === objective}
                  required
                  data-testid={`campaign-objective-${objective}`}
                />
                {labels.objectiveLabel(objective)}
              </label>
            ))}
          </div>
        </div>

        {/*
          THE PLATFORMS COME FROM THE ACTIVATED CONFIGURATION, never from this
          file (CLAUDE.md §2.2), and the decoder refuses anything not on the
          list it is handed — so a chip that is not here cannot be posted.
        */}
        <div
          className="bsp-cp-group"
          role="group"
          aria-labelledby={`${formId}-channels`}
          data-testid="campaign-channels"
        >
          <span className="bsp-lbl" id={`${formId}-channels`}>
            {labels.channels}
          </span>
          <div className="bsp-cp-chips">
            {platforms.map((platform) => (
              <label key={platform.key} className="bsp-chip bsp-lk-chip">
                <input
                  type="checkbox"
                  name="channels"
                  value={platform.key}
                  defaultChecked={values.channels.includes(platform.key)}
                  data-testid={`campaign-channel-${platform.key}`}
                />
                <span className="bsp-cp-chip-mark" aria-hidden="true">
                  <ChannelMark
                    channel={{ key: platform.key, name: platform.label }}
                    size={14}
                    label={false}
                  />
                </span>
                <span className="bsp-ltr">{platform.label}</span>
              </label>
            ))}
          </div>
        </div>

        <PlannedPostsStepper
          label={labels.plannedPosts}
          initial={values.plannedPostCount}
          max={PLANNED_POSTS_MAX}
          minusLabel={labels.fewer}
          plusLabel={labels.more}
        />

        {withStatus ? (
          <label className="bsp-cp-field">
            <span className="bsp-lbl">{labels.status}</span>
            <select
              className="bs-control bsp-cp-in"
              name="status"
              defaultValue={values.status}
              data-testid="campaign-status-select"
            >
              {CAMPAIGN_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {labels.statusLabel(status)}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {/*
          BOTH LOCALES SIDE BY SIDE, because a brief written in one language and
          forgotten in the other is the commonest way a bilingual product ends
          up half-translated (CLAUDE.md §4).
        */}
        <div className="bsp-cp-dates">
          <label className="bsp-cp-field">
            <span className="bsp-lbl">{labels.briefEn}</span>
            <textarea
              className="bs-control bsp-cp-in bsp-cp-notes"
              name="briefEn"
              rows={3}
              defaultValue={values.briefEn}
              dir="ltr"
              data-testid="campaign-brief-en"
            />
          </label>
          <label className="bsp-cp-field">
            <span className="bsp-lbl">{labels.briefAr}</span>
            <textarea
              className="bs-control bsp-cp-in bsp-cp-notes"
              name="briefAr"
              rows={3}
              defaultValue={values.briefAr}
              dir="rtl"
              data-testid="campaign-brief-ar"
            />
          </label>
        </div>

        <label className="bsp-cp-field">
          <span className="bsp-lbl">{labels.description}</span>
          <textarea
            className="bs-control bsp-cp-in bsp-cp-notes"
            name="description"
            rows={3}
            defaultValue={values.description}
            dir="auto"
            data-testid="campaign-description"
          />
        </label>

        {error ? (
          <p role="alert" className="bsp-cp-err" data-testid="campaign-form-error">
            {error}
          </p>
        ) : null}
      </form>

      <div className="bsp-cp-foot">
        {footerStart}
        <span className="bsp-cp-foot-grow" />
        <Link href={cancelHref} className="bsp-btn bsp-sec" data-testid="campaign-cancel">
          {labels.cancel}
        </Link>
        <button
          type="submit"
          form={formId}
          className="bsp-btn bsp-pur"
          data-testid="campaign-submit"
        >
          {labels.submit}
        </button>
      </div>
    </>
  );
}

/** The message keys this form needs, so a caller cannot forget one. */
export const CAMPAIGN_FORM_KEYS = {
  name: 'campaigns.name',
  namePh: 'campaigns.form.namePh',
  brand: 'campaigns.form.brand',
  objective: 'campaigns.objective',
  brief: 'campaigns.brief',
  briefAr: 'campaigns.briefAr',
  briefEn: 'campaigns.briefEn',
  description: 'campaigns.description',
  startDate: 'campaigns.form.starts',
  endDate: 'campaigns.form.ends',
  channels: 'campaigns.channels',
  plannedPosts: 'campaigns.form.plannedPosts',
  fewer: 'campaigns.form.fewer',
  more: 'campaigns.form.more',
  status: 'campaigns.status',
  cancel: 'campaigns.form.cancel',
} satisfies Record<string, MessageKey>;
