import { describe, expect, it } from 'vitest';
import {
  ACTION_OUTCOME_STATUS,
  AUTHORING_CONDITION_FIELDS,
  AUTOMATION_ACTIONS,
  AUTOMATION_TRIGGERS,
  CONDITION_FIELD_TRIGGERS,
  authorableConditionFieldsFor,
  conditionFieldsFor,
  conditionFieldsForRule,
  conditionRejection,
  findAction,
  findTrigger,
  isActionOutcomeCode,
  isAuthorablePair,
  isOlderAutomation,
  type AutomationCondition,
} from '@brandspace/automation';

/**
 * PHASE 2B-3, PR 2 — THE G13 AUTHORING CONTRACT, AS DECLARED.
 *
 * The compatibility table (which trigger each G13 action may be paired with),
 * the conditions a new rule may name per trigger, each action's settings, and
 * the typed outcomes an action ends with when it does not act.
 */

const G13_PAIRS: Record<string, readonly string[]> = {
  SCHEDULE_NEXT_FREE_SLOT: ['CONTENT_APPROVED'],
  NOTIFY_PERSON: ['CONTENT_APPROVED', 'POST_PUBLISHED', 'POST_FAILED'],
  ADD_TO_CAMPAIGN: ['CONTENT_APPROVED'],
  MAKE_DRAFT_COPY: ['CONTENT_APPROVED', 'POST_PUBLISHED', 'POST_FAILED'],
};

describe('the compatibility table', () => {
  it('each G13 action names exactly its approved triggers — eight pairs', () => {
    for (const [type, triggers] of Object.entries(G13_PAIRS)) {
      expect(findAction(type)?.authoringTriggers, type).toEqual(triggers);
    }
    expect(Object.values(G13_PAIRS).flat()).toHaveLength(8);
  });

  it('no legacy action may ever be authored on POST_FAILED', () => {
    for (const type of ['NOTIFY', 'SUBMIT_FOR_APPROVAL', 'PLACE_ON_CALENDAR', 'PROPOSE_PUBLISH']) {
      expect(findAction(type)?.authoringTriggers, type).not.toContain('POST_FAILED');
    }
  });

  it('every G13 pairing is one the engine can execute', () => {
    for (const action of AUTOMATION_ACTIONS.filter((entry) => entry.type in G13_PAIRS)) {
      for (const trigger of action.authoringTriggers) {
        const definition = findTrigger(trigger);
        expect(definition, `${action.type} × ${trigger}`).toBeDefined();
        if (action.needsContentItem) {
          expect(definition?.contentItemVia, `${action.type} × ${trigger}`).not.toBeNull();
        }
      }
    }
  });

  it('POST_FAILED is a domain trigger on the concluding attempt, reaching the post', () => {
    expect(findTrigger('POST_FAILED')).toMatchObject({
      refType: 'PublishAttempt',
      contentItemVia: 'publishAttempt',
      ruleAddressed: false,
      timeBucketed: false,
      authorable: true,
    });
  });
});

describe('the conditions a new rule may name', () => {
  const G13 = [
    'content.channels',
    'content.campaignId',
    'content.hasCampaign',
    'content.type',
    'content.authorUserId',
  ];

  it('per trigger, exactly the approved lists', () => {
    expect(AUTHORING_CONDITION_FIELDS).toEqual({
      CONTENT_APPROVED: G13,
      POST_PUBLISHED: G13,
      POST_FAILED: [...G13, 'publish.failureClass'],
    });
  });

  it('every offered field is one the trigger produces', () => {
    for (const [trigger, fields] of Object.entries(AUTHORING_CONDITION_FIELDS)) {
      for (const field of fields ?? []) {
        expect(CONDITION_FIELD_TRIGGERS[field], `${trigger} ${field}`).toContain(trigger);
      }
    }
  });

  it('what is no longer offered is still produced for stored rules', () => {
    for (const field of ['content.status', 'content.pillar', 'content.platformCount', 'brand.id']) {
      expect(authorableConditionFieldsFor('CONTENT_APPROVED')).not.toContain(field);
      expect(conditionFieldsFor('CONTENT_APPROVED')).toContain(field);
    }
    expect(authorableConditionFieldsFor('POST_PUBLISHED')).not.toContain('publish.provider');
    expect(conditionFieldsFor('POST_PUBLISHED')).toContain('publish.provider');
  });

  it('a G13 rule is held to the G13 list; a rule on a pre-G13 action to what is produced', () => {
    expect(
      AUTOMATION_ACTIONS.filter((action) => action.catalogue === 'g13').map(
        (action) => action.type,
      ),
    ).toEqual(Object.keys(G13_PAIRS));
    expect(
      conditionFieldsForRule({ triggerType: 'POST_FAILED', actionType: 'MAKE_DRAFT_COPY' }),
    ).toEqual(authorableConditionFieldsFor('POST_FAILED'));
    expect(
      conditionFieldsForRule({ triggerType: 'CONTENT_APPROVED', actionType: 'NOTIFY' }),
    ).toEqual(conditionFieldsFor('CONTENT_APPROVED'));
  });

  it('conditionRejection refuses a produced-but-not-offered field only when asked to', () => {
    const status: AutomationCondition = {
      field: 'content.status',
      operator: 'equals',
      value: 'APPROVED',
    };
    expect(
      conditionRejection(
        status,
        'CONTENT_APPROVED',
        authorableConditionFieldsFor('CONTENT_APPROVED'),
      ),
    ).toBe('field');
    expect(conditionRejection(status, 'CONTENT_APPROVED')).toBeNull();
  });
});

describe('the G13 action settings', () => {
  const parse = (type: string, value: unknown) => findAction(type)?.config.safeParse(value);

  it('NOTIFY_PERSON takes one member id and nothing else', () => {
    const id = '3f0c9a1e-4b7d-4c2a-9e51-6d8f0b2a7c13';
    expect(parse('NOTIFY_PERSON', { userId: id })?.data).toEqual({ userId: id });
    expect(parse('NOTIFY_PERSON', {})?.success).toBe(false);
    expect(parse('NOTIFY_PERSON', { userId: 'sara' })?.success).toBe(false);
    // No template, no payload, no link: the notice is always `automation.notice`.
    expect(parse('NOTIFY_PERSON', { userId: id, templateKey: 'x' })?.data).toEqual({ userId: id });
  });

  it('ADD_TO_CAMPAIGN takes one campaign id', () => {
    const id = '7b1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
    expect(parse('ADD_TO_CAMPAIGN', { campaignId: id })?.data).toEqual({ campaignId: id });
    expect(parse('ADD_TO_CAMPAIGN', {})?.success).toBe(false);
    expect(parse('ADD_TO_CAMPAIGN', { campaignId: 'summer' })?.success).toBe(false);
  });

  it('SCHEDULE_NEXT_FREE_SLOT and MAKE_DRAFT_COPY take no settings', () => {
    expect(parse('SCHEDULE_NEXT_FREE_SLOT', {})?.data).toEqual({});
    expect(parse('MAKE_DRAFT_COPY', {})?.data).toEqual({});
  });
});

describe('the typed outcomes', () => {
  it('each code ends the run SKIPPED or BLOCKED_BY_POLICY, as approved', () => {
    expect(ACTION_OUTCOME_STATUS).toEqual({
      already_has_time: 'SKIPPED',
      no_free_day: 'BLOCKED_BY_POLICY',
      approval_required: 'BLOCKED_BY_POLICY',
      schedule_quota_reached: 'BLOCKED_BY_POLICY',
      channel_disconnected: 'BLOCKED_BY_POLICY',
      not_schedulable: 'BLOCKED_BY_POLICY',
      recipient_unavailable: 'BLOCKED_BY_POLICY',
      campaign_unavailable: 'BLOCKED_BY_POLICY',
      already_in_campaign: 'SKIPPED',
      content_in_review: 'SKIPPED',
      content_not_editable: 'SKIPPED',
      content_unavailable: 'SKIPPED',
      source_campaign_unavailable: 'BLOCKED_BY_POLICY',
      draft_limit_reached: 'BLOCKED_BY_POLICY',
    });
    expect(isActionOutcomeCode('no_free_day')).toBe(true);
    expect(isActionOutcomeCode('toString')).toBe(false);
    expect(isActionOutcomeCode(undefined)).toBe(false);
  });
});

describe('the G13 flip — exactly what a new rule may be written as', () => {
  it('three triggers and four actions are authorable, by name', () => {
    expect(AUTOMATION_TRIGGERS.filter((t) => t.authorable).map((t) => t.type)).toEqual([
      'CONTENT_APPROVED',
      'POST_PUBLISHED',
      'POST_FAILED',
    ]);
    expect(AUTOMATION_ACTIONS.filter((a) => a.authorable).map((a) => a.type)).toEqual([
      'SCHEDULE_NEXT_FREE_SLOT',
      'NOTIFY_PERSON',
      'ADD_TO_CAMPAIGN',
      'MAKE_DRAFT_COPY',
    ]);
  });

  it('the retired four and four are registered, executable and not authorable', () => {
    for (const type of [
      'CONTENT_SCHEDULED',
      'ANALYTICS_REFRESHED',
      'METRIC_THRESHOLD_CROSSED',
      'SCHEDULED_TIME',
    ]) {
      expect(findTrigger(type)?.authorable, type).toBe(false);
    }
    for (const type of ['NOTIFY', 'SUBMIT_FOR_APPROVAL', 'PLACE_ON_CALENDAR', 'PROPOSE_PUBLISH']) {
      expect(findAction(type)?.authorable, type).toBe(false);
      expect(findAction(type)?.executable, type).toBe(true);
    }
  });

  it('the authorable pairs are exactly the eight approved ones', () => {
    const pairs: string[] = [];
    for (const trigger of AUTOMATION_TRIGGERS) {
      for (const action of AUTOMATION_ACTIONS) {
        if (isAuthorablePair(trigger.type, action.type))
          pairs.push(`${trigger.type} × ${action.type}`);
      }
    }
    expect(pairs).toEqual([
      'CONTENT_APPROVED × SCHEDULE_NEXT_FREE_SLOT',
      'CONTENT_APPROVED × NOTIFY_PERSON',
      'CONTENT_APPROVED × ADD_TO_CAMPAIGN',
      'CONTENT_APPROVED × MAKE_DRAFT_COPY',
      'POST_PUBLISHED × NOTIFY_PERSON',
      'POST_PUBLISHED × MAKE_DRAFT_COPY',
      'POST_FAILED × NOTIFY_PERSON',
      'POST_FAILED × MAKE_DRAFT_COPY',
    ]);
  });

  it('every stored legacy shape is an older automation; every G13 pair is not', () => {
    expect(isOlderAutomation({ triggerType: 'CONTENT_APPROVED', actionType: 'NOTIFY' })).toBe(true);
    expect(isOlderAutomation({ triggerType: 'SCHEDULED_TIME', actionType: 'NOTIFY_PERSON' })).toBe(
      true,
    );
    expect(isOlderAutomation({ triggerType: 'POST_FAILED', actionType: 'MAKE_DRAFT_COPY' })).toBe(
      false,
    );
  });
});
