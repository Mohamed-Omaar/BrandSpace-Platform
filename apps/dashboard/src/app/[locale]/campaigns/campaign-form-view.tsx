import {
  Card,
  Field,
  buttonStyle,
  colorTokens,
  inputStyle,
  radiusTokens,
  spacingTokens,
  textareaStyle,
  typographyTokens,
} from '@brandspace/ui';
import type { MessageKey } from '../../../i18n/messages';
import { CAMPAIGN_OBJECTIVES, CAMPAIGN_STATUSES } from '../../../server/campaign-form';

/**
 * THE CAMPAIGN FORM, WRITTEN ONCE AND RENDERED TWICE.
 *
 * Create and edit differ in exactly two ways — the action they post to and
 * whether a status can be set — so they share this. Two hand-written copies of
 * one form is how two forms end up validating differently, which is the defect
 * the Settings navigation already taught this repository (D-197).
 *
 * A SERVER COMPONENT WITH NO CLIENT STATE. Every control is a plain form
 * control inside a `<form action={...}>`: the browser submits it, the server
 * decodes it with `campaignFormFrom`, and there is nothing to hydrate. That is
 * also why the decoder can insist a missing field is a refusal — a real
 * submission from this markup always carries every one of them.
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
}

export interface CampaignFormLabels {
  readonly name: string;
  readonly nameHint: string;
  readonly objective: string;
  readonly brief: string;
  readonly briefHint: string;
  readonly briefAr: string;
  readonly briefEn: string;
  readonly description: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly channels: string;
  readonly channelsHint: string;
  readonly status: string;
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
  hidden,
  values,
  labels,
  platforms,
  withStatus,
  testId,
}: {
  readonly action: (formData: FormData) => Promise<void>;
  /** `locale`, and either `brandId` (create) or `campaignId` + `version` (edit). */
  readonly hidden: Readonly<Record<string, string>>;
  readonly values: CampaignFormValues;
  readonly labels: CampaignFormLabels;
  readonly platforms: readonly PlatformOption[];
  readonly withStatus: boolean;
  readonly testId: string;
}) {
  return (
    <Card testId={testId}>
      <form action={action} style={{ display: 'grid', gap: spacingTokens.md }}>
        {Object.entries(hidden).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}

        <Field label={labels.name} htmlFor="campaign-name" hint={labels.nameHint}>
          <input
            className="bs-control"
            id="campaign-name"
            name="name"
            defaultValue={values.name}
            maxLength={160}
            required
            data-testid="campaign-name"
            style={inputStyle()}
          />
        </Field>

        <div className="bs-form-row">
          <Field label={labels.objective} htmlFor="campaign-objective">
            <select
              className="bs-control"
              id="campaign-objective"
              name="objective"
              defaultValue={values.objective}
              data-testid="campaign-objective"
              style={inputStyle()}
            >
              {CAMPAIGN_OBJECTIVES.map((objective) => (
                <option key={objective} value={objective}>
                  {labels.objectiveLabel(objective)}
                </option>
              ))}
            </select>
          </Field>

          {withStatus ? (
            <Field label={labels.status} htmlFor="campaign-status">
              <select
                className="bs-control"
                id="campaign-status"
                name="status"
                defaultValue={values.status}
                data-testid="campaign-status-select"
                style={inputStyle()}
              >
                {CAMPAIGN_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {labels.statusLabel(status)}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
        </div>

        <div className="bs-form-row">
          <Field label={labels.startDate} htmlFor="campaign-start">
            <input
              className="bs-control"
              id="campaign-start"
              name="startDate"
              type="date"
              defaultValue={values.startDate}
              data-testid="campaign-start"
              style={inputStyle()}
            />
          </Field>
          <Field label={labels.endDate} htmlFor="campaign-end">
            <input
              className="bs-control"
              id="campaign-end"
              name="endDate"
              type="date"
              defaultValue={values.endDate}
              data-testid="campaign-end"
              style={inputStyle()}
            />
          </Field>
        </div>

        {/*
          BOTH LOCALES SIDE BY SIDE, because a brief written in one language and
          forgotten in the other is the commonest way a bilingual product ends
          up half-translated (CLAUDE.md §4). The decoder writes both or neither.
        */}
        <fieldset style={fieldsetStyle()}>
          <legend style={legendStyle()}>{labels.brief}</legend>
          <p style={{ ...typographyTokens.bodySm, color: colorTokens.textMuted, margin: 0 }}>
            {labels.briefHint}
          </p>
          <div className="bs-form-row">
            <Field label={labels.briefEn} htmlFor="campaign-brief-en">
              <textarea
                className="bs-control"
                id="campaign-brief-en"
                name="briefEn"
                rows={4}
                defaultValue={values.briefEn}
                data-testid="campaign-brief-en"
                dir="ltr"
                style={textareaStyle()}
              />
            </Field>
            <Field label={labels.briefAr} htmlFor="campaign-brief-ar">
              <textarea
                className="bs-control"
                id="campaign-brief-ar"
                name="briefAr"
                rows={4}
                defaultValue={values.briefAr}
                data-testid="campaign-brief-ar"
                dir="rtl"
                style={textareaStyle()}
              />
            </Field>
          </div>
        </fieldset>

        <Field label={labels.description} htmlFor="campaign-description">
          <textarea
            className="bs-control"
            id="campaign-description"
            name="description"
            rows={3}
            defaultValue={values.description}
            data-testid="campaign-description"
            style={textareaStyle()}
          />
        </Field>

        {/*
          THE PLATFORMS COME FROM THE ACTIVATED CONFIGURATION, never from this
          file (CLAUDE.md §2.2), and the decoder refuses anything not on the
          list it is handed — so a checkbox that is not here cannot be posted.
        */}
        <fieldset style={fieldsetStyle()} data-testid="campaign-channels">
          <legend style={legendStyle()}>{labels.channels}</legend>
          <p style={{ ...typographyTokens.bodySm, color: colorTokens.textMuted, margin: 0 }}>
            {labels.channelsHint}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens.sm }}>
            {platforms.map((platform) => (
              <label
                key={platform.key}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: spacingTokens.xs,
                  ...typographyTokens.bodySm,
                  color: colorTokens.textPrimary,
                  paddingBlock: spacingTokens.xs,
                  paddingInline: spacingTokens.sm,
                  borderRadius: radiusTokens.sm,
                  background: colorTokens.surfaceMuted,
                }}
              >
                <input
                  type="checkbox"
                  name="channels"
                  value={platform.key}
                  defaultChecked={values.channels.includes(platform.key)}
                  data-testid={`campaign-channel-${platform.key}`}
                />
                {platform.label}
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <button type="submit" style={buttonStyle('brand')} data-testid="campaign-submit">
            {labels.submit}
          </button>
        </div>
      </form>
    </Card>
  );
}

function fieldsetStyle(): React.CSSProperties {
  return {
    border: 'none',
    margin: 0,
    padding: 0,
    display: 'grid',
    gap: spacingTokens.sm,
  };
}

function legendStyle(): React.CSSProperties {
  return {
    ...typographyTokens.bodySm,
    color: colorTokens.textPrimary,
    fontWeight: 600,
    padding: 0,
  };
}

/** The message keys this form needs, so a caller cannot forget one. */
export const CAMPAIGN_FORM_KEYS = {
  name: 'campaigns.name',
  nameHint: 'campaigns.nameHint',
  objective: 'campaigns.objective',
  brief: 'campaigns.brief',
  briefHint: 'campaigns.briefHint',
  briefAr: 'campaigns.briefAr',
  briefEn: 'campaigns.briefEn',
  description: 'campaigns.description',
  startDate: 'campaigns.startDate',
  endDate: 'campaigns.endDate',
  channels: 'campaigns.channels',
  channelsHint: 'campaigns.channelsHint',
  status: 'campaigns.status',
} satisfies Record<string, MessageKey>;
