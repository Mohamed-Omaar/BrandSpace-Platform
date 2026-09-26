import { describe, expect, it } from 'vitest';
import { defaultPayload } from '@brandspace/config';
import {
  AUTOMATION_ACTIONS,
  AUTOMATION_TRIGGERS,
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  conditionsSchema,
  evaluateCondition,
  evaluateConditions,
  findAction,
  isExternalAction,
  parseAutomationPolicy,
  runIdempotencyKeyFor,
} from '@brandspace/automation';
import {
  COPILOT_ENTITLEMENT_KEYS,
  COPILOT_TOOLS,
  TOOL_EXECUTORS,
  availableTools,
  canonicalJson,
  digestsMatch,
  findTool,
  hashConfirmationToken,
  highestActionClass,
  issueConfirmationToken,
  planHashOf,
  requiresConfirmation,
  toolCallIdempotencyKey,
  type CanonicalStep,
} from '@brandspace/copilot';
import { LEARNING_INFERENCE_VERSION, confidenceFor } from '@brandspace/intelligence';
import { ALL_PERMISSIONS, ROLE_DEFINITIONS } from '@brandspace/shared';

/**
 * Phase 7 — the ASSISTANT'S and the AUTOMATION ENGINE'S pure logic.
 *
 * Nothing here touches a database, and all of it decides whether a mutation
 * happens: which tools a person is offered, what a confirmation is bound to,
 * whether a tool runs twice, and whether a rule fires. These are the functions
 * where a subtle mistake is invisible in review and catastrophic in production.
 */

describe('the Copilot tool registry', () => {
  it('every tool key is unique and every tool has an executor', () => {
    const keys = COPILOT_TOOLS.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(TOOL_EXECUTORS[key], `${key} executor`).toBeTypeOf('function');
    }
  });

  it('every tool names a permission that actually exists in the catalogue', () => {
    /*
     * A TOOL GUARDED BY A PERMISSION NOBODY HOLDS is a tool nobody can use; a
     * tool guarded by a MISSPELLED one is a tool everybody can use, because
     * `includes` on a typo is always false and the surrounding code reads as
     * though it checked something.
     */
    const known = new Set(ALL_PERMISSIONS.map((p) => p.key));
    for (const tool of COPILOT_TOOLS) {
      expect(known, `${tool.key} -> ${tool.permission}`).toContain(tool.permission);
    }
  });

  it('a tool that changes anything requires a brand, and read-only tools are honest about it', () => {
    for (const tool of COPILOT_TOOLS) {
      if (tool.actionClass !== 'READ_ONLY') {
        expect(tool.brandScope, `${tool.key}`).toBe('required');
      }
    }
  });

  it('only a tool that spends credits declares an entitlement that could refuse it', () => {
    for (const tool of COPILOT_TOOLS) {
      if (tool.spendsCredits) {
        expect(tool.entitlementKey, `${tool.key} spends credits`).toBeTruthy();
      }
    }
    expect(COPILOT_ENTITLEMENT_KEYS.length).toBeGreaterThan(0);
  });

  it('no EXTERNAL_OR_DESTRUCTIVE tool claims to be undoable', () => {
    for (const tool of COPILOT_TOOLS) {
      if (tool.actionClass === 'EXTERNAL_OR_DESTRUCTIVE') {
        expect(tool.undoable, `${tool.key}`).toBe(false);
      }
    }
  });

  it('availableTools offers exactly what the caller holds, and nothing adjacent', () => {
    const offered = availableTools(['copilot.use', 'campaigns.read']);
    expect(offered.map((t) => t.key)).toEqual(['campaign.list']);
    expect(availableTools([])).toHaveLength(0);
    // Q12 — without `copilot.use` nothing is offered, whatever else is held.
    expect(availableTools(['campaigns.read', 'content.read'])).toHaveLength(0);
  });

  it('`client_viewer` is offered NOTHING — D-62 and D-130, asserted from the role itself', () => {
    /*
     * READ FROM THE ROLE DEFINITION, not from a literal. The Viewer's grant is
     * exactly `workspace.read`, and if a future change widened it this test
     * would fail here rather than in a screenshot six weeks later.
     */
    const viewer = ROLE_DEFINITIONS.find((r) => r.key === 'client_viewer');
    expect(viewer?.permissionKeys).toEqual(['workspace.read']);
    expect(availableTools(viewer?.permissionKeys ?? [])).toHaveLength(0);
    // And once the Viewer reads content (a later release), still nothing.
    expect(availableTools([...(viewer?.permissionKeys ?? []), 'content.read'])).toHaveLength(0);
  });

  it('an unknown tool key resolves to nothing', () => {
    expect(findTool('database.query')).toBeUndefined();
    expect(findTool('video.generate')).toBeUndefined();
  });
});

describe('action classification decides whether a human is asked', () => {
  it('a plan of reads is READ_ONLY and needs no confirmation', () => {
    const steps = ['analytics.summary', 'campaign.list'];
    expect(highestActionClass(steps)).toBe('READ_ONLY');
    expect(requiresConfirmation(highestActionClass(steps))).toBe(false);
  });

  it('one reversible write lifts the whole plan to INTERNAL_REVERSIBLE', () => {
    const steps = ['analytics.summary', 'campaign.create'];
    expect(highestActionClass(steps)).toBe('INTERNAL_REVERSIBLE');
    // AND IT STILL ASKS. A customer who typed a sentence and got four drafts
    // and a calendar entry without being asked has been surprised by their own
    // tooling — so this product confirms reversible writes too, not only §2.5's
    // external class.
    expect(requiresConfirmation(highestActionClass(steps))).toBe(true);
  });

  it('ONE external step lifts the whole plan and forces a confirmation', () => {
    /*
     * THE PLAN IS AS DANGEROUS AS ITS MOST DANGEROUS STEP. A publish buried
     * behind two harmless reads is still a publish, and a classification that
     * looked at the first step, or at the majority, would miss exactly the case
     * that matters.
     */
    const steps = ['analytics.summary', 'publishing.publish_now', 'campaign.list'];
    expect(highestActionClass(steps)).toBe('EXTERNAL_OR_DESTRUCTIVE');
    expect(requiresConfirmation(highestActionClass(steps))).toBe(true);
  });

  it('an empty plan is READ_ONLY rather than accidentally privileged', () => {
    expect(highestActionClass([])).toBe('READ_ONLY');
  });

  it('an UNKNOWN tool is treated as the most dangerous class, not the least', () => {
    /*
     * FAIL CLOSED. A key the registry does not recognise must not be classified
     * as a harmless read — that is the direction in which a mistake ships.
     */
    expect(highestActionClass(['something.new'])).toBe('EXTERNAL_OR_DESTRUCTIVE');
    expect(requiresConfirmation(highestActionClass(['something.new']))).toBe(true);
  });
});

describe('the plan hash is a function of the plan, not of how it was built', () => {
  const step = (overrides: Partial<CanonicalStep> = {}): CanonicalStep => ({
    ordinal: 1,
    toolKey: 'campaign.create',
    actionClass: 'INTERNAL_REVERSIBLE',
    arguments: { brandId: 'b1', name: 'Launch', objective: 'AWARENESS' },
    ...overrides,
  });

  it('key ORDER does not change the hash', () => {
    /*
     * THE DEFECT THIS PREVENTS IS INVISIBLE. Prisma returns stored JSON with its
     * own key ordering, so a plan re-read from the database would hash
     * differently from the plan as constructed, and EVERY confirmation would
     * fail with nothing in the logs to explain it.
     */
    const a = planHashOf([step({ arguments: { name: 'Launch', brandId: 'b1' } })]);
    const b = planHashOf([step({ arguments: { brandId: 'b1', name: 'Launch' } })]);
    expect(a).toBe(b);
  });

  it('step ORDER within the array does not change the hash, but the ordinals do', () => {
    const forwards = planHashOf([
      step({ ordinal: 1 }),
      step({ ordinal: 2, toolKey: 'campaign.list' }),
    ]);
    const backwards = planHashOf([
      step({ ordinal: 2, toolKey: 'campaign.list' }),
      step({ ordinal: 1 }),
    ]);
    expect(forwards).toBe(backwards);
  });

  it('changing ANY argument changes the hash — the confirmation stops fitting', () => {
    const original = planHashOf([step()]);
    expect(planHashOf([step({ arguments: { brandId: 'b1', name: 'Different' } })])).not.toBe(
      original,
    );
    expect(planHashOf([step({ toolKey: 'campaign.update' })])).not.toBe(original);
    expect(planHashOf([step({ actionClass: 'EXTERNAL_OR_DESTRUCTIVE' })])).not.toBe(original);
  });

  it('adding a step changes the hash', () => {
    expect(planHashOf([step(), step({ ordinal: 2, toolKey: 'campaign.list' })])).not.toBe(
      planHashOf([step()]),
    );
  });

  it('canonicalJson drops undefined rather than writing the string "undefined"', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson([3, 1])).toBe('[3,1]');
  });
});

describe('the confirmation token is a bearer credential, and is treated as one', () => {
  it('a fresh token is high-entropy and its stored form is a digest', () => {
    const { token, hash } = issueConfirmationToken();
    // 32 bytes, base64url: obviously a secret rather than an identifier.
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
  });

  it('two tokens are never the same', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(issueConfirmationToken().token);
    expect(seen.size).toBe(200);
  });

  it('hashing is deterministic, so the stored hash matches on presentation', () => {
    const { token, hash } = issueConfirmationToken();
    expect(hashConfirmationToken(token)).toBe(hash);
  });

  it('digest comparison is length-safe and does not throw on a mismatch', () => {
    const { hash } = issueConfirmationToken();
    expect(digestsMatch(hash, hash)).toBe(true);
    expect(digestsMatch(hash, 'short')).toBe(false);
    expect(digestsMatch(hash, 'f'.repeat(64))).toBe(false);
  });
});

describe('a tool runs at most once, and the key is what makes that true', () => {
  const base = {
    planId: '77777777-7777-4777-8777-777777777777',
    ordinal: 1,
    toolKey: 'campaign.create',
    arguments: { brandId: 'b1', name: 'Launch' },
  };

  it('the same call produces the same key, so a retry replays rather than repeats', () => {
    expect(toolCallIdempotencyKey(base)).toBe(toolCallIdempotencyKey({ ...base }));
  });

  it('it is DERIVED, not minted: argument order does not produce a new key', () => {
    expect(toolCallIdempotencyKey({ ...base, arguments: { name: 'Launch', brandId: 'b1' } })).toBe(
      toolCallIdempotencyKey(base),
    );
  });

  it('a different plan, ordinal, tool or argument is a different call', () => {
    for (const variant of [
      { planId: '88888888-8888-4888-8888-888888888888' },
      { ordinal: 2 },
      { toolKey: 'campaign.update' },
      { arguments: { brandId: 'b1', name: 'Other' } },
    ]) {
      expect(toolCallIdempotencyKey({ ...base, ...variant }), JSON.stringify(variant)).not.toBe(
        toolCallIdempotencyKey(base),
      );
    }
  });
});

describe('the automation registry is CLOSED, and small on purpose', () => {
  it('there is no webhook, no script, no SQL and no arbitrary URL', () => {
    /*
     * THE ABSENCE IS THE CONTROL. A configurable action list is one migration
     * away from an arbitrary webhook, and an arbitrary webhook is
     * customer-controlled egress from a multi-tenant platform.
     */
    const types = AUTOMATION_ACTIONS.map((a) => a.type);
    for (const forbidden of [
      'CALL_WEBHOOK',
      'RUN_SCRIPT',
      'RUN_SQL',
      'HTTP_REQUEST',
      'SEND_EMAIL',
    ]) {
      expect(types).not.toContain(forbidden);
    }
    expect(types).toEqual([
      'NOTIFY',
      'SUBMIT_FOR_APPROVAL',
      'PLACE_ON_CALENDAR',
      'PROPOSE_PUBLISH',
    ]);
  });

  it('every action names a real permission and every trigger has a config schema', () => {
    const known = new Set(ALL_PERMISSIONS.map((p) => p.key));
    for (const action of AUTOMATION_ACTIONS) {
      expect(known, `${action.type} -> ${action.permission}`).toContain(action.permission);
      expect(action.config.parse, `${action.type} config`).toBeTypeOf('function');
    }
    for (const trigger of AUTOMATION_TRIGGERS) {
      expect(trigger.config.parse, `${trigger.type} config`).toBeTypeOf('function');
    }
  });

  it('exactly one action is external, and it is the one that leaves the platform', () => {
    const external = AUTOMATION_ACTIONS.filter((a) => isExternalAction(a.type));
    expect(external.map((a) => a.type)).toEqual(['PROPOSE_PUBLISH']);
    expect(isExternalAction('NOTIFY')).toBe(false);
  });

  it('an unknown action type resolves to nothing rather than to a default', () => {
    expect(findAction('CALL_WEBHOOK' as never)).toBeUndefined();
  });

  it('the condition grammar is a closed field list and a closed operator list', () => {
    expect(CONDITION_FIELDS.length).toBeGreaterThan(0);
    expect(CONDITION_OPERATORS.length).toBeGreaterThan(0);
    expect(() =>
      conditionsSchema.parse([{ field: 'raw_sql', operator: 'equals', value: 'x' }]),
    ).toThrow();
    expect(() =>
      conditionsSchema.parse([{ field: 'content.status', operator: 'matches_regex', value: '.*' }]),
    ).toThrow();
  });
});

describe('condition evaluation does not coerce, and has no OR', () => {
  const facts = {
    'content.status': 'APPROVED',
    'content.platformCount': 3,
    'content.hasCampaign': true,
  };

  it('equals is strict: "3" does not equal 3', () => {
    /*
     * NO COERCION, DELIBERATELY. A rule that fired because "0" == 0 would be a
     * rule whose author cannot predict it, and an automation nobody can predict
     * is an automation nobody should have switched on.
     */
    expect(
      evaluateCondition({ field: 'content.platformCount', operator: 'equals', value: 3 }, facts),
    ).toBe(true);
    expect(
      evaluateCondition(
        { field: 'content.platformCount', operator: 'equals', value: '3' as never },
        facts,
      ),
    ).toBe(false);
  });

  it('a comparison against a non-number is FALSE rather than a runtime surprise', () => {
    expect(
      evaluateCondition({ field: 'content.status', operator: 'greater_than', value: 2 }, facts),
    ).toBe(false);
  });

  it('a missing fact makes the condition false, never true', () => {
    expect(
      evaluateCondition({ field: 'metric.value', operator: 'greater_than', value: 1 }, {}),
    ).toBe(false);
    expect(
      evaluateCondition(
        { field: 'content.hasCampaign', operator: 'is_true', value: undefined },
        {},
      ),
    ).toBe(false);
  });

  it('is_true and is_false require an actual boolean', () => {
    expect(
      evaluateCondition(
        { field: 'content.hasCampaign', operator: 'is_true', value: undefined },
        facts,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { field: 'content.platformCount', operator: 'is_true', value: undefined },
        facts,
      ),
    ).toBe(false);
  });

  it('in and not_in need a list and a string', () => {
    expect(
      evaluateCondition(
        { field: 'content.status', operator: 'in', value: ['APPROVED', 'SCHEDULED'] },
        facts,
      ),
    ).toBe(true);
    expect(
      evaluateCondition({ field: 'content.status', operator: 'not_in', value: ['DRAFT'] }, facts),
    ).toBe(true);
    expect(
      evaluateCondition(
        { field: 'content.status', operator: 'in', value: 'APPROVED' as never },
        facts,
      ),
    ).toBe(false);
  });

  it('ALL conditions must hold — there is no OR', () => {
    expect(
      evaluateConditions(
        [
          { field: 'content.status', operator: 'equals', value: 'APPROVED' },
          { field: 'content.platformCount', operator: 'greater_than', value: 1 },
        ],
        facts,
      ),
    ).toBe(true);
    expect(
      evaluateConditions(
        [
          { field: 'content.status', operator: 'equals', value: 'APPROVED' },
          { field: 'content.platformCount', operator: 'greater_than', value: 99 },
        ],
        facts,
      ),
    ).toBe(false);
  });

  it('no conditions means the rule always fires, which is what an empty list should mean', () => {
    expect(evaluateConditions([], facts)).toBe(true);
  });
});

describe('an automation run is de-duplicated by an hour bucket', () => {
  const base = {
    ruleId: '99999999-9999-4999-8999-999999999999',
    triggerType: 'CONTENT_APPROVED' as const,
    refId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  };

  it('the same rule, event and hour produce one key', () => {
    expect(runIdempotencyKeyFor({ ...base, bucket: '2026-09-16T12' })).toBe(
      runIdempotencyKeyFor({ ...base, bucket: '2026-09-16T12' }),
    );
  });

  it('a different hour is a different run, so a rule can fire again tomorrow', () => {
    expect(runIdempotencyKeyFor({ ...base, bucket: '2026-09-16T13' })).not.toBe(
      runIdempotencyKeyFor({ ...base, bucket: '2026-09-16T12' }),
    );
  });

  it('a different rule or a different subject is a different run', () => {
    expect(
      runIdempotencyKeyFor({
        ...base,
        ruleId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        bucket: 'x',
      }),
    ).not.toBe(runIdempotencyKeyFor({ ...base, bucket: 'x' }));
    expect(runIdempotencyKeyFor({ ...base, refId: null, bucket: 'x' })).not.toBe(
      runIdempotencyKeyFor({ ...base, bucket: 'x' }),
    );
  });
});

describe('automation ceilings are configuration, not constants', () => {
  it('the policy parses and every limit is a positive bound', () => {
    const policy = parseAutomationPolicy(defaultPayload('automations'));
    expect(policy.limits.maxRulesPerWorkspace).toBeGreaterThan(0);
    expect(policy.limits.maxConditionsPerRule).toBeGreaterThan(0);
    expect(policy.execution.confirmationTtlSeconds).toBeGreaterThan(0);
  });
});

describe('a learning write-back knows what it does not know', () => {
  it('confidence is DERIVED from deviation and repetition, never chosen', () => {
    const weak = confidenceFor(200, 1);
    const strong = confidenceFor(2_000, 5);
    expect(strong).toBeGreaterThan(weak);
  });

  it('confidence is capped well below certainty', () => {
    /*
     * THE CEILING IS THE HONEST PART. This is an inference from a fortnight of
     * one brand's own numbers; there is no reading of that which reaches
     * certainty, and a 1000 would invite a reviewer to stop reading.
     */
    expect(confidenceFor(1_000_000, 1_000)).toBeLessThanOrEqual(800);
    expect(confidenceFor(0, 0)).toBeGreaterThanOrEqual(100);
  });

  it('the inference version is recorded, so a rule change is visible in the data', () => {
    expect(LEARNING_INFERENCE_VERSION).toBeTruthy();
    expect(LEARNING_INFERENCE_VERSION).toMatch(/\d/);
  });
});
