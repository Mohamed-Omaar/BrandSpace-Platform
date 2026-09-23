import {
  AutomationEngine,
  actionSupportsTrigger,
  findAction,
  findTrigger,
  type AutomationPolicy,
} from '@brandspace/automation';
import type {
  AutomationRuleCheck,
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
 * The automations registry's verdict on a rule the Copilot proposes: both keys
 * are real, the action can run on what the trigger produces, and the CALLER
 * holds the action's own permission — the three things `createRule` refuses on,
 * asked before the plan is shown so a customer is never asked to confirm a rule
 * the engine would then refuse.
 */
export const automationRuleCheck: AutomationRuleCheck = {
  admissible({ triggerType, actionType, permissionKeys }) {
    const action = findAction(actionType);
    return (
      findTrigger(triggerType) !== undefined &&
      action !== undefined &&
      actionSupportsTrigger(actionType as never, triggerType as never) &&
      permissionKeys.includes(action.permission)
    );
  },
};

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
}): CopilotAutomationPort {
  const engine = new AutomationEngine({
    db: input.db,
    workspaceId: input.workspaceId,
    policy: input.policy,
    ports: {},
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
