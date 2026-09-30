import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AutomationActionType, AutomationTrigger } from '@prisma/client';
import {
  AUTOMATION_ACTIONS,
  AUTOMATION_TRIGGERS,
  CONDITION_FIELD_CONTRACTS,
  CONDITION_FIELD_TRIGGERS,
  PLANNED_AUTOMATION_ACTIONS,
  PLANNED_AUTOMATION_TRIGGERS,
  RETIRED_AUTOMATION_TRIGGERS,
  actionPermissionKeys,
  actionSupportsTrigger,
  channelForPlatformKey,
  conditionRejection,
  conditionSchema,
  evaluateCondition,
  findAction,
  findPlannedAction,
  findTrigger,
  isAuthorablePair,
  isExternalAction,
  isOlderAutomation,
  satisfiesActionPermissions,
  type ActionPermissions,
  type AutomationCondition,
} from '@brandspace/automation';
import { providerForPlatformKey } from '@brandspace/social-connectors';
import { ALL_PERMISSIONS, ROLE_DEFINITIONS } from '@brandspace/shared';
import { messages } from '../../apps/dashboard/src/i18n/messages';
import { runPresentation } from '../../apps/dashboard/src/server/automation-run-display';

/**
 * PHASE 2B-3, PR 1 — THE FOUNDATION: registry parity, the typed action
 * authorization contract, the `stringSet` kind, and older-automation
 * classification.
 *
 * NOTHING HERE MAKES ANYTHING NEW AUTHORABLE. What these tests pin is that the
 * enum values M1a/M1b added are accounted for, that the requirements declared
 * for the G13 actions are the approved ones, and that every action that ships
 * today requires EXACTLY what it required before.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const m1c = readFileSync(
  path.join(
    root,
    'packages/database/prisma/migrations/20261010092000_automation_g13_checks_and_state/migration.sql',
  ),
  'utf8',
);

// ---------------------------------------------------------------------------
// Registry parity — every enum value is accounted for exactly once
// ---------------------------------------------------------------------------

describe('registry parity with the database enums', () => {
  it('every AutomationTrigger value is shipped, planned or retired — exactly once', () => {
    const shipped = AUTOMATION_TRIGGERS.map((trigger) => trigger.type as string);
    const planned = PLANNED_AUTOMATION_TRIGGERS.map((trigger) => trigger.type as string);
    const retired = [...RETIRED_AUTOMATION_TRIGGERS] as string[];
    const all = [...shipped, ...planned, ...retired];
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual(Object.values(AutomationTrigger).sort());
  });

  it('every AutomationActionType value is shipped or planned — exactly once', () => {
    const shipped = AUTOMATION_ACTIONS.map((action) => action.type as string);
    const planned = PLANNED_AUTOMATION_ACTIONS.map((action) => action.type as string);
    const all = [...shipped, ...planned];
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual(Object.values(AutomationActionType).sort());
  });

  it('the shipped catalogue is exactly what it was; the G13 values are planned', () => {
    // Phase 2B-3 PR 2: POST_FAILED ships with its producer.
    expect(AUTOMATION_TRIGGERS.map((trigger) => trigger.type)).toEqual([
      'CONTENT_APPROVED',
      'CONTENT_SCHEDULED',
      'POST_PUBLISHED',
      'POST_FAILED',
      'ANALYTICS_REFRESHED',
      'METRIC_THRESHOLD_CROSSED',
      'SCHEDULED_TIME',
    ]);
    expect(PLANNED_AUTOMATION_TRIGGERS.map((trigger) => trigger.type)).toEqual([
      'REVIEW_WAITING_24H',
      'CAMPAIGN_STARTED',
      'CAMPAIGN_ENDED',
      'WEEKLY_ENGAGEMENT_DROPPED',
      'SCHEDULE_GAP',
      'POST_TOP_10_PERCENT',
      'FACT_EXPIRING',
    ]);
    // Phase 2B-3 PR 2: four G13 actions ship with their settings; the rest
    // stay planned (REMIND_REVIEWER moves to PR 3, owner decision D3).
    expect(AUTOMATION_ACTIONS.map((action) => action.type)).toEqual([
      'NOTIFY',
      'SUBMIT_FOR_APPROVAL',
      'PLACE_ON_CALENDAR',
      'PROPOSE_PUBLISH',
      'SCHEDULE_NEXT_FREE_SLOT',
      'NOTIFY_PERSON',
      'ADD_TO_CAMPAIGN',
      'MAKE_DRAFT_COPY',
    ]);
    expect(PLANNED_AUTOMATION_ACTIONS.map((action) => action.type)).toEqual([
      'REMIND_REVIEWER',
      'DRAFT_IDEAS',
      'RETRY_PUBLISH',
      'PAUSE_CAMPAIGN',
    ]);
    // CONNECTION_EXPIRING is deferred: no enum value, no declaration.
    expect(Object.values(AutomationTrigger)).not.toContain('CONNECTION_EXPIRING');
  });

  it('each trigger reference matches `automation_event_ref_matches_trigger` (M1c)', () => {
    const declared = [...AUTOMATION_TRIGGERS, ...PLANNED_AUTOMATION_TRIGGERS];
    for (const trigger of declared) {
      const branch = new RegExp(`WHEN '${trigger.type}'\\s+THEN ([^\\n]+)`).exec(m1c)?.[1];
      expect(branch, `${trigger.type} has a CHECK branch`).toBeDefined();
      if (trigger.refType === null) {
        expect(branch).toMatch(/"refType" IS NULL\s+AND "refId" IS NULL/);
      } else {
        expect(branch).toContain(`"refType" = '${trigger.refType}'`);
        expect(branch).toContain('"refId" IS NOT NULL');
      }
    }
    // The retired trigger has NO branch, so an event for it is unrepresentable.
    expect(m1c).not.toMatch(/WHEN 'ANOMALY_DETECTED'/);
  });

  it('`ruleAddressed` matches `automation_event_rule_addressed_when_derived` (M1c)', () => {
    const list = /WHEN "triggerType" IN \(([^)]*)\) THEN "ruleId" IS NOT NULL/.exec(m1c)?.[1] ?? '';
    const derived = [...list.matchAll(/'([A-Z0-9_]+)'/g)].map((match) => match[1]).sort();
    const declared = [...AUTOMATION_TRIGGERS, ...PLANNED_AUTOMATION_TRIGGERS]
      .filter((trigger) => trigger.ruleAddressed)
      .map((trigger) => trigger.type as string)
      .sort();
    expect(derived).toEqual(declared);
  });

  it('`asksFirst` matches `automation_rule_external_requires_confirmation` (M1c)', () => {
    const list = /"actionType" NOT IN \(([^)]*)\)/.exec(m1c)?.[1] ?? '';
    const external = [...list.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]).sort();
    const declared = [...AUTOMATION_ACTIONS, ...PLANNED_AUTOMATION_ACTIONS]
      .filter((action) => action.asksFirst)
      .map((action) => action.type as string)
      .sort();
    expect(external).toEqual(declared);
  });

  it('`asksFirst` is exactly the EXTERNAL_OR_DESTRUCTIVE class, shipped and planned', () => {
    for (const action of [...AUTOMATION_ACTIONS, ...PLANNED_AUTOMATION_ACTIONS]) {
      expect(action.asksFirst, action.type).toBe(action.actionClass === 'EXTERNAL_OR_DESTRUCTIVE');
    }
  });
});

// ---------------------------------------------------------------------------
// The typed authorization contract
// ---------------------------------------------------------------------------

describe('every shipped action requires EXACTLY what it required before', () => {
  /** The single `permission` each action carried before PR 1. */
  const BEFORE: Record<string, string> = {
    NOTIFY: 'workspace.read',
    SUBMIT_FOR_APPROVAL: 'content.submit',
    PLACE_ON_CALENDAR: 'content.schedule',
    PROPOSE_PUBLISH: 'publishing.manage',
  };

  /** Phase 2B-3 PR 2: the four actions that shipped before G13. */
  const LEGACY = AUTOMATION_ACTIONS.filter((action) => action.type in BEFORE);

  it('allOf with one element, no anyOf, no entitlements, no credits', () => {
    expect(LEGACY.map((action) => action.type).sort()).toEqual(Object.keys(BEFORE).sort());
    for (const action of LEGACY) {
      expect(action.permissions, action.type).toEqual({ allOf: [BEFORE[action.type]], anyOf: [] });
      expect(action.entitlements, action.type).toEqual([]);
      expect(action.spendsCredits, action.type).toBe(false);
      // Phase 2B-3 PR 2 (the G13 flip): no NEW rule is written with a pre-G13
      // action, and every stored one still runs.
      expect(action.authorable, action.type).toBe(false);
      expect(action.executable, action.type).toBe(true);
    }
  });

  it('for EVERY role, the new check answers what the old `includes` answered', () => {
    for (const role of ROLE_DEFINITIONS) {
      for (const action of LEGACY) {
        const before = role.permissionKeys.includes(BEFORE[action.type] as string);
        expect(
          satisfiesActionPermissions(role.permissionKeys, action.permissions),
          `${role.key} × ${action.type}`,
        ).toBe(before);
      }
    }
  });

  it('only PROPOSE_PUBLISH asks first, as before', () => {
    expect(AUTOMATION_ACTIONS.filter((action) => action.asksFirst).map((a) => a.type)).toEqual([
      'PROPOSE_PUBLISH',
    ]);
    expect(
      AUTOMATION_ACTIONS.filter((action) => isExternalAction(action.type)).map((a) => a.type),
    ).toEqual(['PROPOSE_PUBLISH']);
  });
});

/**
 * A G13 action's declaration, wherever it lives: shipped (Phase 2B-3 PR 2) or
 * still planned. The requirement is the same either way.
 */
const declared = (type: string) => findAction(type) ?? findPlannedAction(type);

describe('the declared G13 requirements (Correction 1)', () => {
  it('ADD_TO_CAMPAIGN is anyOf [content.create, campaigns.manage] — the only anyOf', () => {
    expect(declared('ADD_TO_CAMPAIGN')?.permissions).toEqual({
      allOf: [],
      anyOf: ['content.create', 'campaigns.manage'],
    });
    const withAnyOf = [...AUTOMATION_ACTIONS, ...PLANNED_AUTOMATION_ACTIONS].filter(
      (action) => action.permissions.anyOf.length > 0,
    );
    expect(withAnyOf.map((action) => action.type)).toEqual(['ADD_TO_CAMPAIGN']);
  });

  it('DRAFT_IDEAS is strict allOf [content.create, copilot.use], and spends credits', () => {
    const draft = findPlannedAction('DRAFT_IDEAS');
    expect(draft?.permissions).toEqual({ allOf: ['content.create', 'copilot.use'], anyOf: [] });
    expect(draft?.spendsCredits).toBe(true);
    expect(draft?.entitlements).toEqual(['limit.automation_ai_actions']);
  });

  it('the rest of report §9, as declared', () => {
    const expected: Record<string, readonly string[]> = {
      SCHEDULE_NEXT_FREE_SLOT: ['content.schedule'],
      NOTIFY_PERSON: ['workspace.read'],
      REMIND_REVIEWER: ['content.submit'],
      MAKE_DRAFT_COPY: ['content.create'],
      RETRY_PUBLISH: ['publishing.manage'],
      PAUSE_CAMPAIGN: ['campaigns.manage'],
    };
    for (const [type, allOf] of Object.entries(expected)) {
      const action = declared(type);
      expect(action?.permissions, type).toEqual({ allOf, anyOf: [] });
      expect(action?.entitlements, type).toEqual([]);
      expect(action?.spendsCredits, type).toBe(false);
    }
  });

  it('every key any declaration names is a real workspace permission', () => {
    const known = new Set(ALL_PERMISSIONS.map((permission) => permission.key));
    for (const action of [...AUTOMATION_ACTIONS, ...PLANNED_AUTOMATION_ACTIONS]) {
      const keys = actionPermissionKeys(action.permissions);
      expect(keys.length, action.type).toBeGreaterThan(0);
      for (const key of keys) expect(known, `${action.type} -> ${key}`).toContain(key);
    }
  });

  it('nothing planned is authorable, executable, or reachable through the registry', () => {
    for (const action of PLANNED_AUTOMATION_ACTIONS) {
      expect(action.authorable).toBe(false);
      expect(action.executable).toBe(false);
      expect(findAction(action.type), action.type).toBeUndefined();
      expect(isExternalAction(action.type), action.type).toBe(false);
      for (const trigger of AUTOMATION_TRIGGERS) {
        expect(actionSupportsTrigger(action.type, trigger.type)).toBe(false);
        expect(isAuthorablePair(trigger.type, action.type)).toBe(false);
      }
    }
    for (const trigger of PLANNED_AUTOMATION_TRIGGERS) {
      expect(trigger.authorable).toBe(false);
      expect(trigger.executable).toBe(false);
      expect(findTrigger(trigger.type), trigger.type).toBeUndefined();
      for (const action of AUTOMATION_ACTIONS) {
        expect(isAuthorablePair(trigger.type, action.type)).toBe(false);
      }
    }
  });
});

describe('allOf / anyOf evaluation', () => {
  const addToCampaign = declared('ADD_TO_CAMPAIGN')?.permissions as ActionPermissions;
  const draftIdeas = findPlannedAction('DRAFT_IDEAS')?.permissions as ActionPermissions;
  const role = (key: string): readonly string[] =>
    ROLE_DEFINITIONS.find((definition) => definition.key === key)?.permissionKeys ?? [];

  it('anyOf: either permission is enough, neither is not', () => {
    expect(satisfiesActionPermissions(['content.create'], addToCampaign)).toBe(true);
    expect(satisfiesActionPermissions(['campaigns.manage'], addToCampaign)).toBe(true);
    expect(satisfiesActionPermissions(['content.create', 'campaigns.manage'], addToCampaign)).toBe(
      true,
    );
    expect(satisfiesActionPermissions(['content.schedule', 'copilot.use'], addToCampaign)).toBe(
      false,
    );
    expect(satisfiesActionPermissions([], addToCampaign)).toBe(false);
  });

  it('allOf: both are required, one is not enough', () => {
    expect(satisfiesActionPermissions(['content.create', 'copilot.use'], draftIdeas)).toBe(true);
    // A custom role with `content.create` and not `copilot.use`.
    expect(satisfiesActionPermissions(['content.create'], draftIdeas)).toBe(false);
    expect(satisfiesActionPermissions(['copilot.use'], draftIdeas)).toBe(false);
  });

  it('the default roles, against the two declarations', () => {
    // Designer holds `copilot.use` and not `content.create`.
    expect(role('designer')).toContain('copilot.use');
    expect(role('designer')).not.toContain('content.create');
    expect(satisfiesActionPermissions(role('designer'), draftIdeas)).toBe(false);
    for (const key of ['workspace_owner', 'workspace_admin', 'marketing_manager']) {
      expect(satisfiesActionPermissions(role(key), draftIdeas), key).toBe(true);
      expect(satisfiesActionPermissions(role(key), addToCampaign), key).toBe(true);
    }
    for (const key of ['approver', 'analyst', 'client_viewer']) {
      expect(satisfiesActionPermissions(role(key), draftIdeas), key).toBe(false);
    }
  });

  it('a requirement that names nothing FAILS CLOSED rather than admitting everyone', () => {
    expect(satisfiesActionPermissions(['workspace.read'], { allOf: [], anyOf: [] })).toBe(false);
  });

  it('allOf and anyOf apply together', () => {
    const both: ActionPermissions = { allOf: ['a'], anyOf: ['b', 'c'] };
    expect(satisfiesActionPermissions(['a', 'c'], both)).toBe(true);
    expect(satisfiesActionPermissions(['a'], both)).toBe(false);
    expect(satisfiesActionPermissions(['b', 'c'], both)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// stringSet + content.channels
// ---------------------------------------------------------------------------

describe('the stringSet kind and content.channels', () => {
  const includes = (value: unknown): AutomationCondition =>
    ({ field: 'content.channels', operator: 'includes', value }) as AutomationCondition;
  const excludes = (value: unknown): AutomationCondition =>
    ({ field: 'content.channels', operator: 'excludes', value }) as AutomationCondition;

  it('is declared as a set of providers, answered by includes / excludes only', () => {
    const contract = CONDITION_FIELD_CONTRACTS['content.channels'];
    expect(contract.kind).toBe('stringSet');
    expect(contract.operators).toEqual(['includes', 'excludes']);
    expect(contract.options).toEqual(['FACEBOOK', 'INSTAGRAM', 'TIKTOK', 'LINKEDIN', 'X']);
    expect(CONDITION_FIELD_TRIGGERS['content.channels']).toEqual([
      'CONTENT_APPROVED',
      'CONTENT_SCHEDULED',
      'POST_PUBLISHED',
      'POST_FAILED',
    ]);
  });

  it('includes / excludes against a real set', () => {
    const facts = { 'content.channels': ['INSTAGRAM', 'LINKEDIN'] };
    expect(evaluateCondition(includes('INSTAGRAM'), facts)).toBe(true);
    expect(evaluateCondition(includes('TIKTOK'), facts)).toBe(false);
    expect(evaluateCondition(excludes('TIKTOK'), facts)).toBe(true);
    expect(evaluateCondition(excludes('INSTAGRAM'), facts)).toBe(false);
    // An empty set includes nothing and excludes everything.
    expect(evaluateCondition(includes('X'), { 'content.channels': [] })).toBe(false);
    expect(evaluateCondition(excludes('X'), { 'content.channels': [] })).toBe(true);
  });

  it('a fact that is not a set answers NEITHER — fail closed, never widened', () => {
    for (const facts of [
      {},
      { 'content.channels': null },
      { 'content.channels': 'INSTAGRAM' },
      { 'content.channels': 3 },
    ]) {
      expect(evaluateCondition(includes('INSTAGRAM'), facts)).toBe(false);
      expect(evaluateCondition(excludes('INSTAGRAM'), facts)).toBe(false);
    }
  });

  it('a list value, a number or an unknown provider is refused as a value', () => {
    expect(conditionRejection(includes('INSTAGRAM'), 'CONTENT_APPROVED')).toBeNull();
    expect(conditionRejection(excludes('X'), 'POST_PUBLISHED')).toBeNull();
    expect(conditionRejection(includes(['INSTAGRAM']), 'CONTENT_APPROVED')).toBe('value');
    expect(conditionRejection(includes('instagram'), 'CONTENT_APPROVED')).toBe('value');
    expect(conditionRejection(includes('THREADS'), 'CONTENT_APPROVED')).toBe('value');
    expect(conditionRejection(includes(''), 'CONTENT_APPROVED')).toBe('value');
    expect(
      conditionRejection({ field: 'content.channels', operator: 'includes' }, 'CONTENT_APPROVED'),
    ).toBe('value');
  });

  it('the set operators belong to the set field, and the set field to them', () => {
    expect(
      conditionRejection(
        { field: 'content.channels', operator: 'equals', value: 'INSTAGRAM' },
        'CONTENT_APPROVED',
      ),
    ).toBe('operator');
    expect(
      conditionRejection(
        { field: 'content.channels', operator: 'in', value: ['INSTAGRAM'] },
        'CONTENT_APPROVED',
      ),
    ).toBe('operator');
    expect(
      conditionRejection(
        { field: 'publish.provider', operator: 'includes', value: 'INSTAGRAM' },
        'POST_PUBLISHED',
      ),
    ).toBe('operator');
    expect(conditionRejection(includes('INSTAGRAM'), 'SCHEDULED_TIME')).toBe('field');
  });

  it('the value survives the schema as a plain string', () => {
    expect(conditionSchema.parse(includes('INSTAGRAM'))).toEqual(includes('INSTAGRAM'));
  });

  it('a channel is the same provider the publisher resolves', () => {
    for (const key of [
      'facebook',
      'instagram',
      'tiktok',
      'linkedin',
      'x',
      'Instagram',
      'LinkedIn',
      'X',
      'threads',
      'pinterest',
      '',
    ]) {
      expect(channelForPlatformKey(key), key).toBe(providerForPlatformKey(key));
    }
  });
});

// ---------------------------------------------------------------------------
// Older automations
// ---------------------------------------------------------------------------

describe('older-automation classification', () => {
  it('a rule on the retired ANOMALY_DETECTED trigger is an older automation', () => {
    expect(isOlderAutomation({ triggerType: 'ANOMALY_DETECTED', actionType: 'NOTIFY' })).toBe(true);
  });

  it('every shipped, supported pair is NOT an older automation', () => {
    // Phase 2B-3 PR 2: a shipped trigger or action may be executable without
    // being authorable (authorability and executability are separate); a pair
    // is current exactly when both halves are authorable.
    for (const trigger of AUTOMATION_TRIGGERS) {
      for (const action of AUTOMATION_ACTIONS) {
        expect(
          isOlderAutomation({ triggerType: trigger.type, actionType: action.type }),
          `${trigger.type} × ${action.type}`,
        ).toBe(!(trigger.authorable && action.authorable));
      }
    }
  });

  it('a rule naming anything not authorable is captioned, whichever half it is', () => {
    expect(isOlderAutomation({ triggerType: 'REVIEW_WAITING_24H', actionType: 'NOTIFY' })).toBe(
      true,
    );
    expect(
      isOlderAutomation({ triggerType: 'CONTENT_APPROVED', actionType: 'REMIND_REVIEWER' }),
    ).toBe(true);
    expect(isOlderAutomation({ triggerType: 'NOT_A_TRIGGER', actionType: 'NOTIFY' })).toBe(true);
  });

  it('the caption and the missing trigger label exist in en and ar', () => {
    expect(messages.en['automations.olderAutomation']).toBe('(older automation)');
    expect(messages.ar['automations.olderAutomation']).toBe('(أتمتة أقدم)');
    expect(messages.en['automations.trigger.ANOMALY_DETECTED']).toBeTruthy();
    expect(messages.ar['automations.trigger.ANOMALY_DETECTED']).toBeTruthy();
    for (const operator of ['includes', 'excludes'] as const) {
      expect(messages.en[`automations.operator.${operator}`]).toBeTruthy();
      expect(messages.ar[`automations.operator.${operator}`]).toBeTruthy();
    }
    expect(messages.en['automations.field.content.channels']).toBeTruthy();
    expect(messages.ar['automations.field.content.channels']).toBeTruthy();
  });

  it('the rule list captions exactly the rules `isOlderAutomation` names', () => {
    const page = readFileSync(
      path.join(root, 'apps/dashboard/src/app/[locale]/automations/page.tsx'),
      'utf8',
    );
    expect(page).toContain('{isOlderAutomation(rule) ? (');
    expect(page).toContain("t('automations.olderAutomation')");
    // The authoring form offers only authorable pairs.
    expect(page).toContain('isAuthorablePair(trigger.type, action.type)');
  });
});

// ---------------------------------------------------------------------------
// A stale-value skip reads as what it is (owner review of PR 1, D-408)
// ---------------------------------------------------------------------------

describe('run history: a condition_value_unavailable skip has its own label and reason', () => {
  const EN =
    "Skipped — something this rule's conditions name is no longer available (a campaign, person or brand). Edit the rule to choose a current one.";
  const AR =
    'تم التخطي — شيء تذكره شروط هذه القاعدة لم يعد متاحًا (حملة أو شخص أو علامة تجارية). عدّل القاعدة واختر قيمة حالية.';

  it('maps the skip to a distinct badge and the localized reason, never the raw code', () => {
    const shown = runPresentation({
      status: 'SKIPPED',
      failureCode: 'condition_value_unavailable',
    });
    expect(shown).toEqual({
      statusKey: 'automations.status.valueUnavailable',
      reason: { kind: 'message', key: 'automations.failure.condition_value_unavailable' },
    });
    expect(shown.statusKey).not.toBe('automations.status.SKIPPED');
  });

  it('carries the exact owner copy in en and ar, and a badge that is not "Conditions did not hold"', () => {
    expect(messages.en['automations.failure.condition_value_unavailable']).toBe(EN);
    expect(messages.ar['automations.failure.condition_value_unavailable']).toBe(AR);
    expect(messages.en['automations.status.valueUnavailable']).toBe('Skipped');
    expect(messages.ar['automations.status.valueUnavailable']).toBe('تم التخطي');
    expect(messages.en['automations.status.valueUnavailable']).not.toBe(
      messages.en['automations.status.SKIPPED'],
    );
    expect(messages.ar['automations.status.valueUnavailable']).not.toBe(
      messages.ar['automations.status.SKIPPED'],
    );
    for (const copy of [EN, AR]) expect(copy).not.toContain('condition_value_unavailable');
  });

  it('leaves every other run exactly as it read before', () => {
    // A plain condition skip keeps "Conditions did not hold" and no reason line.
    expect(runPresentation({ status: 'SKIPPED', failureCode: null })).toEqual({
      statusKey: 'automations.status.SKIPPED',
      reason: { kind: 'none' },
    });
    // Every other code keeps the generic "Reason: {code}" line.
    for (const [status, code] of [
      ['SKIPPED', 'something_else'],
      ['BLOCKED_BY_POLICY', 'daily_ceiling_reached'],
      ['BLOCKED_BY_AUTHORIZATION', 'creator_lost_permission'],
      ['FAILED', 'unknown_action'],
      ['BLOCKED_BY_POLICY', 'condition_value_unavailable'],
    ] as const) {
      expect(runPresentation({ status, failureCode: code })).toEqual({
        statusKey: `automations.status.${status}`,
        reason: { kind: 'generic', code },
      });
    }
    // A member's own skip still has no reason line.
    expect(runPresentation({ status: 'CANCELLED', failureCode: 'skipped_by_member' })).toEqual({
      statusKey: 'automations.status.CANCELLED',
      reason: { kind: 'none' },
    });
    // And the generic reason copy itself is untouched.
    expect(messages.en['automations.failure']).toBe('Reason: {code}');
    expect(messages.ar['automations.failure']).toBe('السبب: {code}');
  });

  it('the run history renders through the presentation, not the raw status', () => {
    const page = readFileSync(
      path.join(root, 'apps/dashboard/src/app/[locale]/automations/page.tsx'),
      'utf8',
    );
    expect(page).toContain('const shown = runPresentation(run);');
    expect(page).toContain('label={t(shown.statusKey as MessageKey)}');
    expect(page).not.toContain('label={t(`automations.status.${run.status}` as MessageKey)}');
  });
});
