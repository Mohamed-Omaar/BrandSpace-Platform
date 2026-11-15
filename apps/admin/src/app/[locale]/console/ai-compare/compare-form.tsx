'use client';

import { useActionState } from 'react';
import { buttonClass } from '@brandspace/ui';
import { Card, Field } from '../../../../components/console-ui';
import { compareImagesAction } from './actions';
import { COMPARE_FORMATS, type CompareSideView, type CompareState } from './shared';

const COPY = {
  en: {
    brief: 'Brief',
    briefHint: 'What to draw, exactly as a post would ask for it.',
    format: 'Format',
    quality: 'Quality',
    modelA: 'First model',
    modelB: 'Second model',
    run: 'Run both',
    running: 'Running… (up to 3 minutes)',
    time: 'Time',
    cost: 'Provider cost',
    noRates: 'No rates entered for this model',
    tokens: 'Tokens reported',
    size: 'Size sent',
    failed: 'Failed',
    errors: {
      FORBIDDEN: 'Only the Platform Owner can run a comparison.',
      BRIEF: 'Write a brief (up to 4,000 characters).',
      INVALID: 'Choose a format, a quality and two image models.',
      FAILED: 'The comparison could not be completed.',
    },
    none: 'No image models are configured yet.',
  },
  ar: {
    brief: 'الطلب',
    briefHint: 'ما يُرسم، تمامًا كما يطلبه منشور.',
    format: 'المقاس',
    quality: 'الجودة',
    modelA: 'النموذج الأول',
    modelB: 'النموذج الثاني',
    run: 'تشغيل الاثنين',
    running: 'جارٍ التشغيل… (حتى 3 دقائق)',
    time: 'الوقت',
    cost: 'تكلفة المزود',
    noRates: 'لم تُدخل أسعار لهذا النموذج',
    tokens: 'الرموز المُبلغ عنها',
    size: 'المقاس المُرسل',
    failed: 'فشل',
    errors: {
      FORBIDDEN: 'مالك المنصة وحده يشغّل المقارنة.',
      BRIEF: 'اكتب الطلب (حتى 4000 حرف).',
      INVALID: 'اختر المقاس والجودة ونموذجَي صور.',
      FAILED: 'تعذّر إكمال المقارنة.',
    },
    none: 'لا توجد نماذج صور مضبوطة بعد.',
  },
} as const;

/** Micro-minor units → the major unit, at the precision a per-image price needs. */
function money(microMinor: string, currency: string): string {
  const major = Number(BigInt(microMinor)) / 100_000_000;
  return `${major.toFixed(4)} ${currency}`;
}

export function CompareForm({
  locale,
  models,
  defaults,
}: {
  readonly locale: string;
  readonly models: readonly { readonly key: string; readonly label: string }[];
  readonly defaults: { readonly modelA: string; readonly modelB: string };
}) {
  const copy = locale === 'ar' ? COPY.ar : COPY.en;
  const [state, action, pending] = useActionState<CompareState, FormData>(compareImagesAction, {});
  if (models.length === 0) return <p data-testid="compare-none">{copy.none}</p>;

  const select = (name: 'modelA' | 'modelB', value: string) => (
    <select
      id={name}
      name={name}
      defaultValue={value}
      className="bs-control bs-select"
      data-testid={`compare-${name}`}
    >
      {models.map((model) => (
        <option key={model.key} value={model.key}>
          {model.label}
        </option>
      ))}
    </select>
  );

  const side = (view: CompareSideView, index: number) => (
    <Card key={`${view.modelKey}-${index}`} testId={`compare-side-${index}`}>
      <div className="bs-cmp-side">
        <b className="bs-cmp-model" dir="ltr">
          {view.modelKey}
        </b>
        <dl className="bs-cmp-facts">
          <dt>{copy.time}</dt>
          <dd data-testid={`compare-time-${index}`} dir="ltr">
            {(view.latencyMs / 1000).toFixed(1)} s
          </dd>
          <dt>{copy.cost}</dt>
          <dd data-testid={`compare-cost-${index}`} dir="ltr">
            {view.costMicroMinor === null
              ? copy.noRates
              : money(view.costMicroMinor, view.costCurrency)}
          </dd>
          <dt>{copy.size}</dt>
          <dd dir="ltr">{view.sizeSent ?? '—'}</dd>
          <dt>{copy.tokens}</dt>
          <dd dir="ltr">
            {view.usage
              ? `${view.usage.promptTokens ?? 0} → ${view.usage.completionTokens ?? 0}`
              : '—'}
          </dd>
        </dl>
        {view.ok ? (
          view.images.map((src, imageIndex) => (
            <img
              key={imageIndex}
              src={src}
              alt={`${view.modelKey} ${imageIndex + 1}`}
              className="bs-cmp-img"
              data-testid={`compare-image-${index}`}
            />
          ))
        ) : (
          <p className="bs-cmp-failed" role="alert" data-testid={`compare-failed-${index}`}>
            {copy.failed}: <span dir="ltr">{view.failureClass}</span>
          </p>
        )}
      </div>
    </Card>
  );

  return (
    <>
      <form action={action} className="bs-cmp-form" data-testid="compare-form">
        <Field label={copy.brief} htmlFor="brief" hint={copy.briefHint}>
          <textarea
            id="brief"
            name="brief"
            required
            maxLength={4000}
            rows={4}
            dir="auto"
            className="bs-control bs-field"
            data-testid="compare-brief"
          />
        </Field>
        <div className="bs-cmp-row">
          <Field label={copy.format} htmlFor="format">
            <select
              id="format"
              name="format"
              defaultValue="1080x1350"
              className="bs-control bs-select"
              data-testid="compare-format"
            >
              {COMPARE_FORMATS.map((format) => (
                <option key={format} value={format}>
                  {format}
                </option>
              ))}
            </select>
          </Field>
          <Field label={copy.quality} htmlFor="quality">
            <select
              id="quality"
              name="quality"
              defaultValue="medium"
              className="bs-control bs-select"
              data-testid="compare-quality"
            >
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </Field>
          <Field label={copy.modelA} htmlFor="modelA">
            {select('modelA', defaults.modelA)}
          </Field>
          <Field label={copy.modelB} htmlFor="modelB">
            {select('modelB', defaults.modelB)}
          </Field>
        </div>
        <button
          type="submit"
          className={buttonClass('primary')}
          disabled={pending}
          aria-busy={pending || undefined}
          data-testid="compare-run"
        >
          {pending ? copy.running : copy.run}
        </button>
      </form>
      {state.error ? (
        <p role="alert" className="bs-cmp-failed" data-testid="compare-error">
          {copy.errors[state.error]}
        </p>
      ) : null}
      {state.sides ? (
        <div className="bs-cmp-grid" data-testid="compare-results">
          {state.sides.map(side)}
        </div>
      ) : null}
    </>
  );
}
