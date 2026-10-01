import {
  AUTOMATION_ACTIONS,
  AUTOMATION_TRIGGERS,
  AutomationEngine,
  findAction,
  isAuthorablePair,
  satisfiesActionPermissions,
  triggerAvailable,
  type AutomationPolicy,
  type EntitlementPort,
} from '@brandspace/automation';
import type {
  AutomationRuleCheck,
  AutomationRulePair,
  AutomationRulePort,
  LiveAuthorization,
} from '@brandspace/copilot';
import type { TenantScopedClient } from '@brandspace/database';

/**
 * THE COPILOT'S DOOR INTO AUTOMATIONS (P6-12), in one module the isolation
 * suite imports directly — so what is tested is what the route runs.
 *
 * `@brandspace/copilot` may not import `@brandspace/automation` (ARCHITECTURE
 * §4.1), so the registry check and the engine are injected from here, the
 * surface that is allowed to hold both.
 */

/**
 * THE PAIRS A NEW RULE MAY BE WRITTEN WITH (Phase 2B-3 PR 2): every registered
 * trigger against every registered action, kept where `isAuthorablePair` — the
 * one gate `createRule` and the Automations screen also ask — says yes. Derived
 * on every call, never listed, so a pair the registry retires or adds is
 * retired or added here in the same change.
 */
function authorablePairs(): readonly AutomationRulePair[] {
  return AUTOMATION_TRIGGERS.flatMap((trigger) =>
    AUTOMATION_ACTIONS.filter((action) => isAuthorablePair(trigger.type, action.type)).map(
      (action) => ({ triggerType: trigger.type, actionType: action.type }),
    ),
  );
}

/**
 * The automations registry's verdict on a rule the Copilot proposes: both keys
 * are real AND AUTHORABLE, the action can run on what the trigger produces, and
 * the CALLER holds the action's own permissions — the things `createRule`
 * refuses on, asked before the plan is shown so a customer is never asked to
 * confirm a rule the engine would then refuse. What the prompt offers is
 * `authorablePairs`, from the same gate.
 */
export const automationRuleCheck: AutomationRuleCheck = {
  authorablePairs,
  admissible({ triggerType, actionType, permissionKeys }) {
    const action = findAction(actionType);
    return (
      action !== undefined &&
      isAuthorablePair(triggerType, actionType) &&
      satisfiesActionPermissions(permissionKeys, action.permissions)
    );
  },
};

/**
 * THE SAME CHECK, FOR THIS ENVIRONMENT'S THRESHOLDS (Phase 2B-3 PR 4). An
 * analytics event whose operator thresholds are not all set is refused by
 * `createRule` (`triggerAvailable`), so the Copilot neither offers it nor
 * admits a rule on it — the D-425 parity: never ask a customer to confirm a
 * rule the engine would refuse. What the route injects.
 */
export function automationRuleCheckFor(
  policy: AutomationPolicy,
  /*
   * PHASE 2B-3 PR 6 — the actions this workspace's plan includes
   * (`entitledActionTypes`, owner decision 11). Required: a check built without
   * it would offer an AI action to a workspace whose plan does not include it.
   */
  entitled: ReadonlySet<string>,
): AutomationRuleCheck {
  return {
    authorablePairs: () =>
      automationRuleCheck
        .authorablePairs()
        .filter(
          (pair) => triggerAvailable(policy, pair.triggerType) && entitled.has(pair.actionType),
        ),
    admissible: (input) =>
      triggerAvailable(policy, input.triggerType) &&
      entitled.has(input.actionType) &&
      automationRuleCheck.admissible(input),
  };
}

export type CopilotAutomationPort = AutomationRulePort & {
  deleteRule(input: { ruleId: string; actor: LiveAuthorization }): Promise<void>;
};

/**
 * CREATE a rule — always disabled — and remove one the assistant made. The
 * engine is built with NO PORTS, exactly as the dashboard's authoring engine
 * is: authoring needs none, and an engine that could notify, submit or publish
 * here would be this surface doing the worker's job.
 */
export function copilotAutomationPort(input: {
  db: TenantScopedClient;
  workspaceId: string;
  policy: AutomationPolicy;
  /**
   * PHASE 2B-3 PR 6 — the plan question `createRule` asks for an action that
   * declares an entitlement. A read, not an action; without it such an action
   * is refused (fail closed).
   */
  entitlements?: EntitlementPort;
}): CopilotAutomationPort {
  const engine = new AutomationEngine({
    db: input.db,
    workspaceId: input.workspaceId,
    policy: input.policy,
    ports: input.entitlements ? { entitlements: input.entitlements } : {},
  });
  return {
    async createRule(rule) {
      const created = await engine.createRule({
        brandId: rule.brandId,
        name: rule.name,
        triggerType: rule.triggerType as never,
        triggerConfig: rule.triggerConfig,
        conditions: rule.conditions,
        actionType: rule.actionType as never,
        actionConfig: rule.actionConfig,
        enabled: rule.enabled,
        actor: rule.actor,
      });
      return { id: created.id, version: created.version, name: created.name };
    },
    async deleteRule({ ruleId, actor }) {
      await engine.deleteRule({ ruleId, actor });
    },
  };
}
