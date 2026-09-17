'use client';

import { useMemo, useState } from 'react';
import {
  buttonStyle,
  colorTokens,
  inputStyle,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';

/**
 * THE AUTOMATION AUTHORING FORM.
 *
 * WHY IT IS A CLIENT COMPONENT, AND WHAT THAT DOES NOT MEAN.
 *
 * The screen used to render every trigger and every action as two independent
 * pickers and post `triggerConfig: {}` whatever you chose. So a customer could
 * select "every day at a time" and never say WHICH time, or "when a metric
 * crosses a line" and never say which metric or which line — and the server
 * refused the rule with a validation error naming a field the form had never
 * shown them. Two of the six triggers were, in practice, unauthorable.
 *
 * They also picked a trigger and an action that `actionSupportsTrigger` would
 * reject, and found out after submitting.
 *
 * So the form has to REACT to the trigger: different triggers need different
 * fields, and a different set of actions and condition fields is legal for each.
 * That is client state, and this is the smallest component that holds it.
 *
 * WHAT IS STILL IMPOSSIBLE, and is the whole reason the registry is closed:
 * there is no free-text field that becomes behaviour. Every trigger, action,
 * condition field and operator below is an option rendered from a list the
 * ENGINE declares; the only free text is a rule's name. No code, no expression,
 * no SQL, no webhook, no URL — none of them has an input to be typed into.
 *
 * NO FUNCTIONS CROSS THE BOUNDARY. Labels arrive as plain strings, already
 * translated on the server. Passing a translator into a client component is what
 * took the Copilot screen down at render, and it is not repeated here.
 */

export interface TriggerOption {
  readonly type: string;
  readonly label: string;
  /** Action types `actionSupportsTrigger` allows for this trigger. */
  readonly actionTypes: readonly string[];
  /** Condition fields that have a real producer in this trigger's context. */
  readonly conditionFields: readonly string[];
  readonly needsSchedule: boolean;
  readonly needsThreshold: boolean;
}

export interface AutomationFormLabels {
  readonly name: string;
  readonly brand: string;
  readonly trigger: string;
  readonly action: string;
  readonly submit: string;
  readonly hour: string;
  readonly days: string;
  readonly metric: string;
  readonly direction: string;
  readonly above: string;
  readonly below: string;
  readonly threshold: string;
  readonly windowDays: string;
  readonly conditionLegend: string;
  readonly conditionNone: string;
  readonly conditionField: string;
  readonly conditionOperator: string;
  readonly conditionValue: string;
  readonly weekdays: readonly string[];
}

export interface AutomationFormProps {
  readonly locale: string;
  readonly brands: readonly { readonly id: string; readonly name: string }[];
  readonly triggers: readonly TriggerOption[];
  readonly actionLabels: Readonly<Record<string, string>>;
  readonly conditionFieldLabels: Readonly<Record<string, string>>;
  readonly operators: readonly { readonly value: string; readonly label: string }[];
  readonly metrics: readonly { readonly key: string; readonly label: string }[];
  readonly labels: AutomationFormLabels;
  readonly action: (formData: FormData) => void | Promise<void>;
}

const FIELD: React.CSSProperties = { display: 'grid', gap: '0.25rem' };

export function AutomationForm(props: AutomationFormProps): React.JSX.Element {
  const [triggerType, setTriggerType] = useState(props.triggers[0]?.type ?? '');
  const [conditionField, setConditionField] = useState('');
  const [conditionOperator, setConditionOperator] = useState(props.operators[0]?.value ?? '');

  const trigger = useMemo(
    () => props.triggers.find((option) => option.type === triggerType) ?? props.triggers[0],
    [props.triggers, triggerType],
  );

  /*
   * `is_true` AND `is_false` TAKE NO VALUE, and the schema marks the value
   * optional for exactly them. Showing a value box beside them would invite
   * somebody to type something the engine then ignores, which is its own small
   * lie about what a rule does.
   */
  const needsValue = conditionOperator !== 'is_true' && conditionOperator !== 'is_false';

  const caption = { ...typographyTokens.caption, color: colorTokens.textSecondary } as const;

  return (
    <form action={props.action} data-testid="automation-form">
      <input type="hidden" name="locale" value={props.locale} />
      <div style={{ display: 'grid', gap: spacingTokens.md }}>
        <div
          style={{ display: 'flex', gap: spacingTokens.md, flexWrap: 'wrap', alignItems: 'end' }}
        >
          <label style={FIELD}>
            <span style={caption}>{props.labels.name}</span>
            <input
              name="name"
              required
              maxLength={120}
              className="bs-control"
              style={inputStyle()}
            />
          </label>
          <label style={FIELD}>
            <span style={caption}>{props.labels.brand}</span>
            <select name="brandId" className="bs-control" data-testid="automation-brand">
              {props.brands.map((brand) => (
                <option key={brand.id} value={brand.id}>
                  {brand.name}
                </option>
              ))}
            </select>
          </label>
          <label style={FIELD}>
            <span style={caption}>{props.labels.trigger}</span>
            <select
              name="triggerType"
              className="bs-control"
              data-testid="automation-trigger"
              value={triggerType}
              onChange={(event) => {
                setTriggerType(event.target.value);
                // A field that is not produced by the NEW trigger must not
                // survive the change.
                setConditionField('');
              }}
            >
              {props.triggers.map((option) => (
                <option key={option.type} value={option.type}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label style={FIELD}>
            <span style={caption}>{props.labels.action}</span>
            {/*
              ONLY THE ACTIONS THIS TRIGGER SUPPORTS. `actionSupportsTrigger`
              decided this list on the server; an action that needs a content
              item is simply absent from a trigger that has none, so an
              incompatible pair cannot be selected rather than being refused
              after submit.
            */}
            <select name="actionType" className="bs-control" data-testid="automation-action">
              {(trigger?.actionTypes ?? []).map((type) => (
                <option key={type} value={type}>
                  {props.actionLabels[type] ?? type}
                </option>
              ))}
            </select>
          </label>
        </div>

        {trigger?.needsSchedule ? (
          <fieldset
            style={{
              border: 'none',
              padding: 0,
              margin: 0,
              display: 'grid',
              gap: spacingTokens.sm,
            }}
            data-testid="automation-schedule"
          >
            <div style={{ display: 'flex', gap: spacingTokens.md, flexWrap: 'wrap' }}>
              <label style={FIELD}>
                <span style={caption}>{props.labels.hour}</span>
                <select name="hourLocal" className="bs-control" data-testid="automation-hour">
                  {Array.from({ length: 24 }, (_, hour) => (
                    <option key={hour} value={hour}>
                      {String(hour).padStart(2, '0')}:00
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
              <legend style={caption}>{props.labels.days}</legend>
              <div style={{ display: 'flex', gap: spacingTokens.sm, flexWrap: 'wrap' }}>
                {props.labels.weekdays.map((day, index) => (
                  <label
                    key={day}
                    style={{ display: 'flex', gap: '0.25rem', alignItems: 'center', ...caption }}
                  >
                    <input type="checkbox" name="daysOfWeek" value={index} />
                    <span>{day}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </fieldset>
        ) : null}

        {trigger?.needsThreshold ? (
          <fieldset
            style={{
              border: 'none',
              padding: 0,
              margin: 0,
              display: 'flex',
              gap: spacingTokens.md,
              flexWrap: 'wrap',
            }}
            data-testid="automation-threshold"
          >
            <label style={FIELD}>
              <span style={caption}>{props.labels.metric}</span>
              <select name="metricKey" className="bs-control" data-testid="automation-metric">
                {props.metrics.map((metric) => (
                  <option key={metric.key} value={metric.key}>
                    {metric.label}
                  </option>
                ))}
              </select>
            </label>
            <label style={FIELD}>
              <span style={caption}>{props.labels.direction}</span>
              <select name="direction" className="bs-control" data-testid="automation-direction">
                <option value="above">{props.labels.above}</option>
                <option value="below">{props.labels.below}</option>
              </select>
            </label>
            <label style={FIELD}>
              <span style={caption}>{props.labels.threshold}</span>
              <input
                name="threshold"
                type="number"
                step={1}
                required
                className="bs-control"
                style={inputStyle()}
                data-testid="automation-threshold-value"
              />
            </label>
            <label style={FIELD}>
              <span style={caption}>{props.labels.windowDays}</span>
              <input
                name="windowDays"
                type="number"
                min={1}
                max={90}
                defaultValue={7}
                className="bs-control"
                style={inputStyle()}
                data-testid="automation-window"
              />
            </label>
          </fieldset>
        ) : null}

        <fieldset
          style={{
            border: 'none',
            padding: 0,
            margin: 0,
            display: 'flex',
            gap: spacingTokens.md,
            flexWrap: 'wrap',
            alignItems: 'end',
          }}
          data-testid="automation-condition"
        >
          <legend style={caption}>{props.labels.conditionLegend}</legend>
          <label style={FIELD}>
            <span style={caption}>{props.labels.conditionField}</span>
            {/*
              ONLY THE FIELDS THIS TRIGGER ACTUALLY PRODUCES. The server derived
              this from `CONDITION_FIELD_TRIGGERS`, the same table the runtime
              gatherer is held to — so a customer cannot pick a field that would
              compare false for ever on the rule they are writing.
            */}
            <select
              name="conditionField"
              className="bs-control"
              data-testid="automation-condition-field"
              value={conditionField}
              onChange={(event) => setConditionField(event.target.value)}
            >
              <option value="">{props.labels.conditionNone}</option>
              {(trigger?.conditionFields ?? []).map((field) => (
                <option key={field} value={field}>
                  {props.conditionFieldLabels[field] ?? field}
                </option>
              ))}
            </select>
          </label>
          {conditionField === '' ? null : (
            <>
              <label style={FIELD}>
                <span style={caption}>{props.labels.conditionOperator}</span>
                <select
                  name="conditionOperator"
                  className="bs-control"
                  data-testid="automation-condition-operator"
                  value={conditionOperator}
                  onChange={(event) => setConditionOperator(event.target.value)}
                >
                  {props.operators.map((operator) => (
                    <option key={operator.value} value={operator.value}>
                      {operator.label}
                    </option>
                  ))}
                </select>
              </label>
              {needsValue ? (
                <label style={FIELD}>
                  <span style={caption}>{props.labels.conditionValue}</span>
                  <input
                    name="conditionValue"
                    maxLength={200}
                    className="bs-control"
                    style={inputStyle()}
                    data-testid="automation-condition-value"
                  />
                </label>
              ) : null}
            </>
          )}
        </fieldset>

        <div>
          <button type="submit" style={buttonStyle('brand', 'sm')} data-testid="automation-submit">
            {props.labels.submit}
          </button>
        </div>
      </div>
    </form>
  );
}
