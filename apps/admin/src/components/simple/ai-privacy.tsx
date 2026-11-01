import { Field, StateMessage, Stack, spacingTokens } from '@brandspace/ui';
import { currentEnvironment, getConfigService } from '../../server/platform-context';
import { simpleCopy, type SimpleKey } from '../../i18n/simple';

/**
 * PR A2 (item 8) — THE D-13 PRIVACY QUESTIONS IN THE SIMPLE AI SET-UP.
 *
 * D-13 refuses to activate an AI provider until three things are recorded:
 * that it does not train on customer data, its data-retention terms, and where
 * the privacy review is written down. They lived only in the Advanced JSON
 * editor, so Activate in the Simple set-up was refused with a generic sentence
 * and no way to answer. They are asked here, on the activation form, and saved
 * onto the provider record in the same configuration version.
 *
 * Composed only from the shared `Field` and `Stack` and the `bs-control`
 * classes: no inline style, no literal (D-581).
 */

export interface AiPrivacyAnswers {
  readonly noTrainingGuarantee: boolean | null;
  readonly dataRetentionPolicy: string | null;
  readonly privacyReviewRef: string | null;
}

/** What the provider record already holds, so the form opens with it. */
export async function aiPrivacyOf(providerKey: string): Promise<AiPrivacyAnswers> {
  const document = (await getConfigService().get('ai.providers', currentEnvironment())) as {
    providers?: Record<string, unknown>[];
  };
  const record = (document.providers ?? []).find((provider) => provider['key'] === providerKey);
  return {
    noTrainingGuarantee:
      typeof record?.['noTrainingGuarantee'] === 'boolean' ? record['noTrainingGuarantee'] : null,
    dataRetentionPolicy:
      typeof record?.['dataRetentionPolicy'] === 'string' ? record['dataRetentionPolicy'] : null,
    privacyReviewRef:
      typeof record?.['privacyReviewRef'] === 'string' ? record['privacyReviewRef'] : null,
  };
}

const RETENTION = ['zero_retention', 'limited_retention', 'retains_data'] as const;

export function AiPrivacyFields({
  locale,
  current,
}: {
  readonly locale: string;
  readonly current: AiPrivacyAnswers;
}) {
  const copy = simpleCopy(locale);
  return (
    <Stack gap={spacingTokens.sm}>
      <Field
        label={copy('d13.training')}
        htmlFor="d13-training"
        hint={copy('d13.trainingHint')}
        required
      >
        <select
          id="d13-training"
          name="d13.noTrainingGuarantee"
          required
          defaultValue={
            current.noTrainingGuarantee === null ? '' : String(current.noTrainingGuarantee)
          }
          className="bs-control bs-field"
          data-testid="d13-training"
        >
          <option value="">{copy('d13.choose')}</option>
          <option value="true">{copy('d13.trainingYes')}</option>
          <option value="false">{copy('d13.trainingNo')}</option>
        </select>
      </Field>
      <Field
        label={copy('d13.retention')}
        htmlFor="d13-retention"
        hint={copy('d13.retentionHint')}
        required
      >
        <select
          id="d13-retention"
          name="d13.dataRetentionPolicy"
          required
          defaultValue={
            current.dataRetentionPolicy && current.dataRetentionPolicy !== 'unverified'
              ? current.dataRetentionPolicy
              : ''
          }
          className="bs-control bs-field"
          data-testid="d13-retention"
        >
          <option value="">{copy('d13.choose')}</option>
          {RETENTION.map((value) => (
            <option key={value} value={value}>
              {copy(`d13.retention.${value}` as SimpleKey)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={copy('d13.review')} htmlFor="d13-review" hint={copy('d13.reviewHint')} required>
        <input
          id="d13-review"
          name="d13.privacyReviewRef"
          required
          minLength={3}
          maxLength={200}
          defaultValue={current.privacyReviewRef ?? ''}
          className="bs-control bs-field"
          data-testid="d13-review"
        />
      </Field>
    </Stack>
  );
}

/** The configuration paths a refusal named, as the field names the owner sees. */
const FIELD_KEYS: Readonly<Record<string, SimpleKey>> = {
  noTrainingGuarantee: 'd13.training',
  dataRetentionPolicy: 'd13.retention',
  privacyReviewRef: 'd13.review',
  baseUrl: 'd13.field.baseUrl',
  apiKeySecretRef: 'd13.field.apiKey',
};

/**
 * PR A2 (item 8) — WHICH FIELD STOPPED THE ACTIVATION. The refusal carries the
 * configuration paths of its errors (`providers.0.privacyReviewRef`); this
 * names each in the owner's words instead of "Something went wrong".
 */
export function RefusedFields({
  locale,
  fields,
}: {
  readonly locale: string;
  readonly fields: string | null;
}) {
  if (!fields) return null;
  const copy = simpleCopy(locale);
  const names = [
    ...new Set(
      fields
        .split(',')
        .map((path) => path.split('.').pop() ?? '')
        .map((leaf) => (FIELD_KEYS[leaf] ? copy(FIELD_KEYS[leaf]) : leaf))
        .filter((name) => name !== ''),
    ),
  ];
  if (names.length === 0) return null;
  return (
    <StateMessage
      kind="error"
      title={copy('d13.refused')}
      description={names.join(locale === 'ar' ? '، ' : ', ')}
      testId="activation-refused-fields"
    />
  );
}
