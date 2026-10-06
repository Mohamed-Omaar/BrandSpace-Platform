'use client';

import Link from 'next/link';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { colorTokens, inputStyle, spacingTokens, typographyTokens } from '@brandspace/ui';

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

/** Round 4 (5.3) — the prototype's three condition chips, shown before a trigger. */
const PREVIEW_CONDITION_FIELDS: readonly string[] = [
  'content.channels',
  'content.campaignId',
  'content.type',
];

export interface TriggerOption {
  readonly type: string;
  readonly label: string;
  /** Round 3 — the tile's own words, as the prototype writes them ("A post is approved"). */
  readonly tileLabel?: string;
  /** Review of #67 — "Listens to Approvals", under the tile's label. */
  readonly listens?: string;
  /** Action types `actionSupportsTrigger` allows for this trigger. */
  readonly actionTypes: readonly string[];
  /** Condition fields that have a real producer in this trigger's context. */
  readonly conditionFields: readonly string[];
  readonly needsSchedule: boolean;
  readonly needsThreshold: boolean;
  /**
   * Phase 2B-3 PR 4 — an analytics event whose operator thresholds are not all
   * set: shown, so the customer knows it exists, but not choosable, because
   * `createRule` would refuse it (`triggerAvailable`).
   */
  readonly unavailable?: boolean;
}

export interface ConditionChoice {
  readonly value: string;
  readonly label: string;
}

/**
 * ONE FIELD'S WHOLE AUTHORING CONTRACT, derived on the server from
 * `CONDITION_FIELD_CONTRACTS` (R4-1).
 *
 * THE SCREEN USED TO RENDER EVERY OPERATOR FOR EVERY FIELD, so `brand.id
 * greater_than`, `publish.provider is_true` and `metric.value in …` were all
 * one click away — stored, enabled, listed, and false for ever. And the value
 * box was always a text input, so a boolean field's `equals` posted the STRING
 * `"true"` against a real boolean fact.
 *
 * NOW THE FIELD DECIDES ALL THREE: which operators exist, which control renders,
 * and how the value is parsed. The same declaration refuses anything else
 * server-side, so this is the affordance and not the control.
 */
export interface ConditionFieldOption {
  readonly label: string;
  readonly kind: 'string' | 'number' | 'boolean' | 'stringSet';
  readonly operators: readonly ConditionChoice[];
  /** Closed or catalogued choices; empty means a free value control. */
  readonly options: readonly ConditionChoice[];
  /**
   * Phase 2B-3 (PR 1) — for a catalogue that depends on the RULE'S BRAND (its
   * campaigns, the members admitted to it), one list per brand the form can
   * pick. Replaces `options` for the brand currently selected.
   */
  readonly optionsByBrand?: Readonly<Record<string, readonly ConditionChoice[]>>;
}

export interface AutomationFormLabels {
  readonly name: string;
  /** Round 3 — the "⋯" that holds the rule's name and brand. */
  readonly moreFields?: string;
  /** Round 3 — said on the action tiles until a trigger is picked. */
  readonly pickTriggerFirst?: string;
  /** D-468 — the prototype builder's three steps, its read-back and its pills. */
  readonly when: string;
  readonly onlyIf: string;
  /** Round 4 (5.3) — why a condition chip waits before a trigger is chosen. */
  readonly chooseWhenFirst?: string | undefined;
  readonly then: string;
  readonly preview: string;
  /** The summary box before a trigger is chosen. */
  readonly previewEmpty?: string;
  readonly asksFirst: string;
  readonly usesCredits: string;
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
  readonly conditionValues: string;
  readonly conditionValuesHint: string;
  readonly weekdays: readonly string[];
  /** B12 — the edit form's extra words. Only read in edit mode. */
  readonly description?: string;
  readonly offsetHours?: string;
  /** Phase 2B-3 PR 2 — the G13 actions' own settings. */
  readonly actionPerson: string;
  readonly actionCampaign: string;
  /** Phase 2B-3 PR 5 — what a pause does and does not do. */
  readonly pauseNote: string;
  /**
   * Phase 2B-3 PR 2 — the empty first option of the trigger and action pickers
   * on a NEW rule, and what the browser says when either is left unchosen.
   */
  readonly chooseTrigger: string;
  readonly chooseAction: string;
  /** Phase 2B-3 PR 4 — a trigger that is not available yet; `{trigger}` is its label. */
  readonly triggerUnavailable: string;
  readonly conditionsKept?: string;
  readonly valueUnavailable?: string;
  readonly cancel?: string;
}

/**
 * B12 (Phase 2B-2b) — WHAT AN EXISTING RULE HOLDS, for the edit form.
 *
 * The trigger and the action are FIXED: the form names them and posts
 * neither — the server reads the stored ones. `extraConditions` is how many
 * conditions the rule holds beyond the one this form can show; when there
 * are any, the conditions are KEPT as they are rather than offered as one
 * control, so an edit can never silently drop a condition somebody wrote
 * (a Copilot-written rule may hold several).
 */
export interface AutomationFormInitial {
  readonly ruleId: string;
  readonly version: number;
  readonly name: string;
  readonly description: string;
  readonly brandName: string;
  readonly triggerType: string;
  readonly actionType: string;
  readonly hourLocal: number | null;
  readonly daysOfWeek: readonly number[];
  readonly metricKey: string | null;
  readonly direction: 'above' | 'below' | null;
  readonly threshold: number | null;
  readonly windowDays: number | null;
  /** `PLACE_ON_CALENDAR`'s one setting a person chooses; null for other actions. */
  readonly offsetHours: number | null;
  /** The rule's brand: its person and campaign lists are this brand's. */
  readonly brandId: string;
  /** Phase 2B-3 PR 2 — `NOTIFY_PERSON`'s person, `ADD_TO_CAMPAIGN`'s campaign. */
  readonly actionUserId: string | null;
  readonly actionCampaignId: string | null;
  readonly condition: {
    readonly field: string;
    readonly operator: string;
    readonly value: string | number | boolean | readonly string[] | null;
  } | null;
  readonly extraConditions: number;
}

export interface AutomationFormProps {
  readonly locale: string;
  readonly brands: readonly { readonly id: string; readonly name: string }[];
  readonly triggers: readonly TriggerOption[];
  readonly actionLabels: Readonly<Record<string, string>>;
  /** Every condition field's contract, keyed by field. */
  readonly conditionCatalogue: Readonly<Record<string, ConditionFieldOption>>;
  /**
   * Phase 2B-3 PR 2 — WHO `NOTIFY_PERSON` MAY NAME AND WHICH CAMPAIGN
   * `ADD_TO_CAMPAIGN` MAY NAME, per rule brand: the ACTIVE members whose scope
   * admits the brand, and the brand's live campaigns — the predicates the engine
   * applies on save and on every run.
   */
  readonly actionPeopleByBrand: Readonly<Record<string, readonly ConditionChoice[]>>;
  readonly actionCampaignsByBrand: Readonly<Record<string, readonly ConditionChoice[]>>;
  /**
   * Phase 2B-3 PR 5 — the campaigns `PAUSE_CAMPAIGN` may name, per rule brand:
   * only PLANNED or ACTIVE ones, the engine's save-time rule.
   */
  readonly actionPausableCampaignsByBrand: Readonly<Record<string, readonly ConditionChoice[]>>;
  readonly metrics: readonly { readonly key: string; readonly label: string }[];
  /** What each action's tile says of it: asks first, uses credits (the registry's own flags). */
  readonly actionNotes?: Readonly<
    Record<string, { readonly asksFirst: boolean; readonly spendsCredits: boolean }>
  >;
  readonly labels: AutomationFormLabels;
  readonly action: (formData: FormData) => void | Promise<void>;
  /** B12 — edit an existing rule instead of creating one. */
  readonly initial?: AutomationFormInitial | undefined;
  /** Where Cancel leads, in edit mode. */
  readonly cancelHref?: string | undefined;
}

const FIELD: React.CSSProperties = { display: 'grid', gap: '0.25rem' };

export function AutomationForm(props: AutomationFormProps): React.JSX.Element {
  const initial = props.initial;
  const editing = initial !== undefined;
  /*
   * NOTHING IS PRESELECTED ON A NEW RULE (Phase 2B-3 PR 2). The trigger and the
   * action start empty, behind "Choose …", and the form will not post until a
   * person has picked both. A preselected action was a silent default, and
   * three of the G13 actions change content (schedule, file into a campaign,
   * copy): a rule someone saved and switched on without looking at the action
   * would do one of those to every post it matched.
   */
  const [triggerType, setTriggerType] = useState(initial?.triggerType ?? '');
  const [conditionField, setConditionField] = useState(initial?.condition?.field ?? '');
  const [conditionOperator, setConditionOperator] = useState(initial?.condition?.operator ?? '');
  const [brandId, setBrandId] = useState(initial?.brandId ?? props.brands[0]?.id ?? '');
  /** Round 3 — the name a person typed; until then it follows the rule's sentence. */
  const [typedName, setName] = useState<string | null>(initial?.name ?? null);
  const moreRef = useRef<HTMLDetailsElement | null>(null);
  const keepConditions = (initial?.extraConditions ?? 0) > 0;

  const trigger = useMemo(
    () => props.triggers.find((option) => option.type === triggerType),
    [props.triggers, triggerType],
  );
  /*
   * THE ACTION IS CONTROLLED (Phase 2B-3 PR 2) because two of them carry a
   * setting the form must show: the person to notify and the campaign. An
   * action the new trigger does not offer is cleared, never swapped for the
   * trigger's first one.
   */
  const [chosenAction, setChosenAction] = useState(initial?.actionType ?? '');
  const actionType = editing
    ? (initial?.actionType ?? '')
    : (trigger?.actionTypes ?? []).includes(chosenAction)
      ? chosenAction
      : '';
  /*
   * LEFT UNCHOSEN, THE BROWSER SAYS SO IN THE PAGE'S LANGUAGE. `required` on
   * the pickers is what stops the post; the message it shows is set here, from
   * the same translated words as the empty option, rather than left to the
   * browser's own language.
   */
  const formId = useId();
  /** The first choosable trigger carries the group's "choose one" message. */
  const firstTrigger = props.triggers.findIndex((option) => !option.unavailable);
  const triggerPicker = useRef<HTMLInputElement>(null);
  const actionGroup = useRef<HTMLDivElement>(null);
  useEffect(() => {
    triggerPicker.current?.setCustomValidity(triggerType === '' ? props.labels.chooseTrigger : '');
  }, [triggerType, props.labels.chooseTrigger]);
  useEffect(() => {
    /*
     * The trigger decides which actions are offered, so which radio comes first
     * changes with it: every radio is cleared, then the first carries the words.
     */
    const radios = Array.from(
      actionGroup.current?.querySelectorAll<HTMLInputElement>('input[name="actionType"]') ?? [],
    );
    for (const radio of radios) radio.setCustomValidity('');
    radios[0]?.setCustomValidity(actionType === '' ? props.labels.chooseAction : '');
  }, [actionType, triggerType, props.labels.chooseAction]);
  /** The brand's list, plus the saved value when it is no longer offered. */
  const targetChoices = (
    byBrand: Readonly<Record<string, readonly ConditionChoice[]>>,
    saved: string | null,
  ): readonly ConditionChoice[] => {
    const offered = byBrand[brandId] ?? [];
    return saved && !offered.some((option) => option.value === saved)
      ? [...offered, { value: saved, label: props.labels.valueUnavailable ?? saved }]
      : offered;
  };

  const declared = conditionField === '' ? undefined : props.conditionCatalogue[conditionField];
  /*
   * A BRAND-DEPENDENT CATALOGUE FOLLOWS THE BRAND BEING WRITTEN FOR. An edited
   * rule's brand is fixed and its lists arrive already scoped to it.
   */
  const catalogued =
    declared && declared.optionsByBrand && !editing
      ? { ...declared, options: declared.optionsByBrand[brandId] ?? [] }
      : declared;
  /*
   * A SAVED VALUE THAT IS NO LONGER OFFERED STAYS SELECTED. A campaign that was
   * archived, or a person who left, is not in today's list — but the rule still
   * names them, and posting the form back must not quietly drop or change that.
   * The value is added to the list as "No longer available", selected.
   */
  const savedValues =
    initial?.condition && initial.condition.field === conditionField
      ? ([] as string[]).concat(
          Array.isArray(initial.condition.value)
            ? (initial.condition.value as readonly string[])
            : typeof initial.condition.value === 'string'
              ? [initial.condition.value]
              : [],
        )
      : [];
  const field =
    catalogued && catalogued.options.length > 0
      ? {
          ...catalogued,
          options: [
            ...catalogued.options,
            ...savedValues
              .filter((value) => !catalogued.options.some((option) => option.value === value))
              .map((value) => ({ value, label: props.labels.valueUnavailable ?? value })),
          ],
        }
      : catalogued;
  const savedDefault =
    initial?.condition && initial.condition.field === conditionField
      ? initial.condition.value
      : null;

  /*
   * THE OPERATOR LIST IS THE FIELD'S, NEVER THE WHOLE REGISTRY'S. A string fact
   * is asked about by identity and membership, a number by magnitude, a boolean
   * by `is_true`/`is_false` and nothing else — and the engine refuses every
   * other pairing independently, so this narrows a legal set rather than being
   * the thing that makes it legal.
   */
  const operators = field?.operators ?? [];
  const operator =
    operators.some((option) => option.value === conditionOperator) && conditionOperator !== ''
      ? conditionOperator
      : (operators[0]?.value ?? '');

  /*
   * `is_true` AND `is_false` TAKE NO VALUE, and the schema marks the value
   * optional for exactly them. Showing a value box beside them would invite
   * somebody to type something the engine then ignores, which is its own small
   * lie about what a rule does.
   */
  const needsValue = operator !== '' && operator !== 'is_true' && operator !== 'is_false';
  /*
   * `in` AND `not_in` TAKE A REAL LIST. They used to be offered beside a single
   * text box, which posted a string where the engine requires `string[]` — so
   * the condition compared false whatever was typed. A multi-select produces a
   * genuine array; a free-text field (a pillar has no enum to close it against)
   * is split on commas by the server action, and an empty list is refused.
   */
  const isList = operator === 'in' || operator === 'not_in';

  const caption = { ...typographyTokens.caption, color: colorTokens.textSecondary } as const;

  const actionLabel = actionType === '' ? '' : (props.actionLabels[actionType] ?? actionType);
  const name =
    typedName ??
    (trigger
      ? `${trigger.tileLabel ?? trigger.label}${actionLabel ? ` → ${actionLabel}` : ''}`
      : '');
  const notes = (type: string) => props.actionNotes?.[type];
  const pills = (type: string) => (
    <>
      {notes(type)?.asksFirst ? (
        <span className="bsp-xstatus bsp-warn">{props.labels.asksFirst}</span>
      ) : null}
      {notes(type)?.spendsCredits ? (
        <span className="bsp-xstatus bsp-ai">{props.labels.usesCredits}</span>
      ) : null}
    </>
  );

  /*
   * THE PROTOTYPE'S RULE BUILDER, `Main.dc.html` lines 1559–1566 (D-468): "1 ·
   * When" as a two-column grid of choices, "2 · Only if", "3 · Then" as a
   * second grid, each with its own settings under a lavender edge, and the
   * rule read back as one sentence. The choices are real radio buttons — one
   * `triggerType`, one `actionType` — so the form posts exactly what it did.
   */
  return (
    <form
      action={props.action}
      onInvalidCapture={(event) => {
        const more = moreRef.current;
        if (more && more.contains(event.target as Node)) more.open = true;
      }}
      className="bsp-au-form"
      data-testid={editing ? 'automation-edit-form' : 'automation-form'}
    >
      {/*
        Round 4 (5.3) — SAVE STAYS IN THE FRAME. The product's dialog holds
        more than the prototype's (two more actions, "Name and brand"), so at
        1440 × 900 it can scroll. The rule's parts scroll here, and the
        prototype's Cancel/Save row stays under them, never covered by them and
        never covering them.
      */}
      <div className="bsp-au-body">
        <input type="hidden" name="locale" value={props.locale} />
        {initial ? (
          <>
            <input type="hidden" name="ruleId" value={initial.ruleId} />
            <input type="hidden" name="version" value={initial.version} />
            {keepConditions ? <input type="hidden" name="conditionsMode" value="keep" /> : null}
          </>
        ) : null}

        <span className="bsp-lbl" id={`${formId}-when`}>
          1 · {props.labels.when}
        </span>
        {initial ? (
          <div className="bsp-au-tiles">
            <span className="bsp-au-tile" data-on="true">
              <span className="bsp-au-tile-l">
                {trigger?.tileLabel ?? trigger?.label ?? initial.triggerType}
              </span>
            </span>
          </div>
        ) : (
          <div
            role="radiogroup"
            aria-labelledby={`${formId}-when`}
            className="bsp-au-tiles"
            data-testid="automation-trigger"
          >
            {props.triggers.map((option, index) => (
              <label
                key={option.type}
                className="bsp-au-tile"
                data-on={triggerType === option.type ? 'true' : undefined}
                data-off={option.unavailable ? 'true' : undefined}
              >
                <input
                  type="radio"
                  name="triggerType"
                  value={option.type}
                  required
                  disabled={option.unavailable}
                  checked={triggerType === option.type}
                  ref={index === firstTrigger ? triggerPicker : undefined}
                  className="bs-control bsp-au-radio"
                  data-testid={`automation-trigger-${option.type}`}
                  onChange={() => {
                    setTriggerType(option.type);
                    // A field that is not produced by the NEW trigger must not
                    // survive the change.
                    setConditionField('');
                  }}
                />
                <span className="bsp-au-tile-l">
                  {option.unavailable
                    ? props.labels.triggerUnavailable.replace(
                        '{trigger}',
                        option.tileLabel ?? option.label,
                      )
                    : (option.tileLabel ?? option.label)}
                </span>
                {option.listens ? <span className="bsp-au-tile-s">{option.listens}</span> : null}
              </label>
            ))}
          </div>
        )}
        <div className="bsp-au-subb">
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
                  <select
                    name="hourLocal"
                    className="bs-control"
                    data-testid="automation-hour"
                    defaultValue={initial?.hourLocal ?? undefined}
                  >
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
                      <input
                        type="checkbox"
                        name="daysOfWeek"
                        value={index}
                        defaultChecked={initial?.daysOfWeek.includes(index) ?? false}
                      />
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
                <select
                  name="metricKey"
                  className="bs-control"
                  data-testid="automation-metric"
                  defaultValue={initial?.metricKey ?? undefined}
                >
                  {props.metrics.map((metric) => (
                    <option key={metric.key} value={metric.key}>
                      {metric.label}
                    </option>
                  ))}
                </select>
              </label>
              <label style={FIELD}>
                <span style={caption}>{props.labels.direction}</span>
                <select
                  name="direction"
                  className="bs-control"
                  data-testid="automation-direction"
                  defaultValue={initial?.direction ?? undefined}
                >
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
                  defaultValue={initial?.threshold ?? undefined}
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
                  defaultValue={initial?.windowDays ?? 7}
                  className="bs-control"
                  style={inputStyle()}
                  data-testid="automation-window"
                />
              </label>
            </fieldset>
          ) : null}
        </div>

        <span className="bsp-lbl">2 · {props.labels.onlyIf}</span>
        {/* Round 4 (5.3) — the chips sit straight under "Only if", as the prototype's. */}
        <div className="bsp-au-iff">
          {keepConditions ? (
            <p style={caption} data-testid="automation-conditions-kept">
              {(props.labels.conditionsKept ?? '').replace(
                '{count}',
                String((initial?.extraConditions ?? 0) + 1),
              )}
            </p>
          ) : (
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
              <legend className="bsp-au-sr">{props.labels.conditionLegend}</legend>
              {/*
              ROUND 3 — THE PROTOTYPE'S CHIPS ("No condition", "Channel is",
              "Campaign is", …), one radio each: ONLY THE FIELDS THIS TRIGGER
              ACTUALLY PRODUCES. The server derived the list from
              `CONDITION_FIELD_TRIGGERS`, the same table the runtime gatherer is
              held to — so a customer cannot pick a field that would compare
              false for ever on the rule they are writing.
            */}
              <div
                role="radiogroup"
                aria-label={props.labels.conditionField}
                className="bsp-au-chips"
                data-testid="automation-condition-field"
              >
                {/*
                ROUND 4 (5.3) — THE FOUR CHIPS BEFORE A TRIGGER IS CHOSEN: the
                prototype's "No condition · Channels · Campaign · Format" are
                drawn at once. Until "When" is chosen the three fields wait,
                dimmed and saying why — which fields are legal still depends on
                the trigger, so none can be picked before it.
              */}
                {['', ...(trigger ? trigger.conditionFields : PREVIEW_CONDITION_FIELDS)].map(
                  (name) => (
                    <label
                      key={name || 'none'}
                      className="bsp-chip bsp-au-chip"
                      data-on={conditionField === name ? 'true' : undefined}
                      data-waiting={!trigger && name !== '' ? 'true' : undefined}
                      title={!trigger && name !== '' ? props.labels.chooseWhenFirst : undefined}
                    >
                      <input
                        type="radio"
                        name="conditionField"
                        value={name}
                        checked={conditionField === name}
                        disabled={!trigger && name !== ''}
                        className="bs-control bsp-au-radio"
                        data-testid={`automation-condition-field-${name || 'none'}`}
                        onChange={() => {
                          setConditionField(name);
                          // THE OPERATOR MUST NOT SURVIVE THE FIELD. `greater_than`
                          // is legal on a count and meaningless on a provider;
                          // carrying it across would post a pair the engine refuses.
                          setConditionOperator('');
                        }}
                      />
                      {name === ''
                        ? props.labels.conditionNone
                        : (props.conditionCatalogue[name]?.label ?? name)}
                    </label>
                  ),
                )}
              </div>
              {field === undefined ? null : (
                <>
                  <label style={FIELD}>
                    <span style={caption}>{props.labels.conditionOperator}</span>
                    <select
                      name="conditionOperator"
                      className="bs-control"
                      data-testid="automation-condition-operator"
                      value={operator}
                      onChange={(event) => setConditionOperator(event.target.value)}
                    >
                      {operators.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {needsValue ? (
                    <label style={FIELD}>
                      <span style={caption}>
                        {isList ? props.labels.conditionValues : props.labels.conditionValue}
                      </span>
                      {/*
                    THE CONTROL IS THE FIELD'S KIND, NOT ALWAYS A TEXT BOX.

                    A closed or catalogued field gets a picker, so a status that
                    does not exist cannot be typed; a list operator gets a
                    MULTIPLE picker, so the browser posts several entries and
                    the server action assembles a real `string[]`; a number gets
                    a number input, so `greater_than` compares numerically
                    instead of refusing a mixed comparison.
                  */}
                      {field.options.length > 0 ? (
                        <select
                          name="conditionValue"
                          multiple={isList}
                          className="bs-control"
                          data-testid="automation-condition-value"
                          defaultValue={
                            isList
                              ? Array.isArray(savedDefault)
                                ? (savedDefault as string[])
                                : []
                              : typeof savedDefault === 'string'
                                ? savedDefault
                                : field.options[0]?.value
                          }
                        >
                          {field.options.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          name="conditionValue"
                          type={field.kind === 'number' ? 'number' : 'text'}
                          step={field.kind === 'number' ? 1 : undefined}
                          maxLength={field.kind === 'number' ? undefined : 200}
                          required
                          defaultValue={
                            typeof savedDefault === 'string' || typeof savedDefault === 'number'
                              ? savedDefault
                              : Array.isArray(savedDefault)
                                ? (savedDefault as string[]).join(', ')
                                : undefined
                          }
                          className="bs-control"
                          style={inputStyle()}
                          data-testid="automation-condition-value"
                        />
                      )}
                      {isList && field.options.length === 0 ? (
                        <span style={caption}>{props.labels.conditionValuesHint}</span>
                      ) : null}
                    </label>
                  ) : null}
                </>
              )}
            </fieldset>
          )}
        </div>

        <span className="bsp-lbl" id={`${formId}-then`}>
          3 · {props.labels.then}
        </span>
        {initial ? (
          <div className="bsp-au-tiles">
            <span className="bsp-au-tile bsp-au-act" data-on="true">
              {actionLabel}
              {pills(initial.actionType)}
            </span>
          </div>
        ) : (
          /*
           * ONLY THE ACTIONS THIS TRIGGER SUPPORTS. `actionSupportsTrigger`
           * decided this list on the server; an action that needs a content item
           * is simply absent from a trigger that has none, so an incompatible pair
           * cannot be chosen rather than being refused after submit.
           */
          <div
            role="radiogroup"
            ref={actionGroup}
            aria-labelledby={`${formId}-then`}
            className="bsp-au-tiles"
            data-testid="automation-action"
          >
            {(trigger?.actionTypes ?? []).map((type) => (
              <label
                key={type}
                className="bsp-au-tile bsp-au-act"
                data-on={actionType === type ? 'true' : undefined}
              >
                <input
                  type="radio"
                  name="actionType"
                  value={type}
                  required
                  checked={actionType === type}
                  className="bs-control bsp-au-radio"
                  data-testid={`automation-action-${type}`}
                  onChange={() => setChosenAction(type)}
                />
                {props.actionLabels[type] ?? type}
                {pills(type)}
              </label>
            ))}
            {/*
            ROUND 3 — "3 · THEN" IS DRAWN BEFORE A TRIGGER IS PICKED, as the
            prototype draws it: every action as a tile that waits for the
            trigger (only the trigger decides which of them may follow it).
          */}
            {trigger === undefined
              ? Object.keys(props.actionLabels)
                  .filter((type) =>
                    props.triggers.some(
                      (option) => !option.unavailable && option.actionTypes.includes(type),
                    ),
                  )
                  .map((type) => (
                    <span
                      key={type}
                      className="bsp-au-tile bsp-au-act"
                      data-off="true"
                      title={props.labels.pickTriggerFirst}
                      data-testid={`automation-action-waiting-${type}`}
                    >
                      {props.actionLabels[type] ?? type}
                      {pills(type)}
                    </span>
                  ))
              : null}
            {/*
            No trigger chosen yet: the radio the browser reports, so "choose an
            action" is said even while there is nothing to choose from.
          */}
            {(trigger?.actionTypes ?? []).length === 0 ? (
              <input
                type="radio"
                name="actionType"
                value=""
                required
                tabIndex={-1}
                aria-hidden="true"
                className="bs-control bsp-au-radio bsp-au-ghost"
                onChange={() => undefined}
                checked={false}
              />
            ) : null}
          </div>
        )}
        <div className="bsp-au-subb">
          {/*
          PHASE 2B-3 PR 2 — THE G13 ACTIONS' OWN SETTINGS. The person to notify
          and the campaign are picked from lists built for the rule's brand, so
          nothing typed becomes a target; the engine re-checks both on save and
          on every run. A saved choice that is no longer offered stays selected
          as "No longer available", so an edit never silently changes it.
        */}
          {actionType === 'NOTIFY_PERSON' ? (
            <label style={FIELD}>
              <span style={caption}>{props.labels.actionPerson}</span>
              <select
                name="actionUserId"
                required
                className="bs-control"
                data-testid="automation-action-person"
                defaultValue={initial?.actionUserId ?? undefined}
                key={`person-${brandId}`}
              >
                {targetChoices(props.actionPeopleByBrand, initial?.actionUserId ?? null).map(
                  (option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ),
                )}
              </select>
            </label>
          ) : null}
          {actionType === 'ADD_TO_CAMPAIGN' ? (
            <label style={FIELD}>
              <span style={caption}>{props.labels.actionCampaign}</span>
              <select
                name="actionCampaignId"
                required
                className="bs-control"
                data-testid="automation-action-campaign"
                defaultValue={initial?.actionCampaignId ?? undefined}
                key={`campaign-${brandId}`}
              >
                {targetChoices(props.actionCampaignsByBrand, initial?.actionCampaignId ?? null).map(
                  (option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ),
                )}
              </select>
            </label>
          ) : null}

          {actionType === 'PAUSE_CAMPAIGN' ? (
            <label style={FIELD}>
              <span style={caption}>{props.labels.actionCampaign}</span>
              <select
                name="actionCampaignId"
                required
                className="bs-control"
                data-testid="automation-action-pause-campaign"
                defaultValue={initial?.actionCampaignId ?? undefined}
                key={`pause-campaign-${brandId}`}
                aria-describedby="automation-pause-note"
              >
                {targetChoices(
                  props.actionPausableCampaignsByBrand,
                  initial?.actionCampaignId ?? null,
                ).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span id="automation-pause-note" style={caption} data-testid="automation-pause-note">
                {props.labels.pauseNote}
              </span>
            </label>
          ) : null}

          {initial && initial.offsetHours !== null ? (
            <label style={FIELD}>
              <span style={caption}>{props.labels.offsetHours}</span>
              <input
                name="offsetHours"
                type="number"
                min={0}
                max={720}
                step={1}
                required
                defaultValue={initial.offsetHours}
                className="bs-control"
                style={inputStyle()}
                data-testid="automation-offset-hours"
              />
            </label>
          ) : null}
        </div>

        {/*
        "THE RULE" — the prototype's summary box, always drawn (review of #67):
        the rule read back as one line, its condition included, or what is
        still to choose.
      */}
        <div className="bsp-au-prev" data-testid="automation-preview">
          <span className="bsp-au-prev-t">{props.labels.preview}</span>
          <span className="bsp-au-prev-l">
            {trigger ? (
              <>
                {trigger.label}
                {field
                  ? ` · ${props.conditionCatalogue[conditionField]?.label ?? conditionField}`
                  : ''}
                {actionLabel ? ` → ${actionLabel}` : ''}
              </>
            ) : (
              (props.labels.previewEmpty ?? '')
            )}
          </span>
        </div>

        {/*
        Review of #67, round 3 — the prototype's dialog starts at "1 · When"
        and has no name or brand field: a rule is read as its sentence. The
        product's name and brand are kept under one "⋯" before the buttons; the
        name follows the sentence until it is typed, so a closed "⋯" still posts
        one, and the browser's own refusal opens it.
      */}
        <details
          ref={moreRef}
          className="bsp-au-more"
          data-testid="automation-more"
          open={editing ? true : undefined}
        >
          <summary className="bsp-chip bsp-fdis-chip" aria-label={props.labels.moreFields}>
            <span aria-hidden="true">⋯</span>
            <span className="bsp-au-more-l">{props.labels.moreFields}</span>
          </summary>
          <div className="bsp-au-fields">
            <label className="bsp-au-field">
              <span className="bsp-lbl">{props.labels.name}</span>
              <input
                name="name"
                required
                maxLength={120}
                className="bs-control bsp-au-input"
                data-testid="automation-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            {initial ? (
              /*
               * FIXED ON AN EXISTING RULE: the brand, the trigger and the action are
               * named, not offered. Nothing is posted for them; the server uses the
               * stored ones.
               */
              <div className="bsp-au-field">
                <span className="bsp-lbl">{props.labels.brand}</span>
                <span className="bsp-au-fixed">{initial.brandName}</span>
              </div>
            ) : (
              <label className="bsp-au-field">
                <span className="bsp-lbl">{props.labels.brand}</span>
                <select
                  name="brandId"
                  className="bs-control bsp-au-input bs-select bsp-chevron"
                  data-testid="automation-brand"
                  value={brandId}
                  onChange={(event) => setBrandId(event.target.value)}
                >
                  {props.brands.map((brand) => (
                    <option key={brand.id} value={brand.id}>
                      {brand.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </details>

        {initial ? (
          <label className="bsp-au-field">
            <span className="bsp-lbl">{props.labels.description}</span>
            <textarea
              name="description"
              maxLength={500}
              rows={2}
              defaultValue={initial.description}
              className="bs-control bsp-au-input"
              data-testid="automation-description"
            />
          </label>
        ) : null}
      </div>

      <div className="bsp-au-foot">
        {props.cancelHref ? (
          <Link href={props.cancelHref} className="bsp-btn bsp-sec">
            {props.labels.cancel}
          </Link>
        ) : null}
        <button
          type="submit"
          className="bsp-btn bsp-pur"
          data-testid={editing ? 'automation-edit-submit' : 'automation-submit'}
        >
          {props.labels.submit}
        </button>
      </div>
    </form>
  );
}
