/**
 * D-566 — CONNECTED AI APPS, PER PLAN.
 *
 * The one yes/no feature that decides, per plan, whether a workspace's members
 * may connect Claude, ChatGPT or any MCP client. It is a plan-decided boolean
 * feature like any other: the owner registers and grants it from the Control
 * Center (Simple → AI apps, or the plan cards), the kill switch in feature
 * flags wins over everything, and a workspace whose plan does not grant it is
 * not entitled. The whole-feature switch for everyone is `ai-apps.enabled`.
 *
 * The KEY is code, as every feature key is; whether it is on, and for which
 * plans, is configuration (CLAUDE.md §2.2).
 */
export const AI_APPS_FEATURE = 'feature.ai_apps';

/** The feature's registry entry, written by the Control Center when it is first granted. */
export const AI_APPS_FEATURE_DEFINITION = {
  key: AI_APPS_FEATURE,
  name: {
    en: 'Connect AI apps (Claude, ChatGPT)',
    ar: 'ربط تطبيقات الذكاء الاصطناعي (Claude وChatGPT)',
  },
  category: 'integrations',
  valueType: 'boolean',
  defaultValue: false,
  enumValues: [],
  dependsOn: [],
  status: 'active',
} as const;
