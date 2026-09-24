/**
 * WHAT AN ACTIVITY EVENT IS CALLED, IN THE READER'S LANGUAGE (P6-13).
 *
 * The Activity log printed `entry.action` — `content.review_requested`,
 * `copilot.plan_confirmed`, `workspace.member.role_changed` — to customers, in
 * English identifiers, in both locales. CLAUDE.md §4 makes no exception for
 * enum values: a machine key on a screen is untranslated copy.
 *
 * THREE RUNGS, AND NEVER THE RAW KEY:
 *
 *   1. an exact label — `activity.action.<action>`;
 *   2. the event's FAMILY — `activity.family.<first segment>` ("Brand Brain
 *      activity"), for an action this catalogue has not named yet (a dynamic
 *      `copilot.tool.<key>`, or a new event added after this list);
 *   3. a generic "Workspace event".
 *
 * `tests/unit/phase6-activity.test.ts` scans every audit action literal the
 * code writes and fails if one reaches rung 3, so a new event family cannot
 * ship without at least a family name.
 *
 * PURE — the unit suite imports it; the page passes the dictionary.
 */
export function activityActionLabel(
  action: string,
  dictionary: Readonly<Record<string, string | undefined>>,
): string {
  const exact = dictionary[`activity.action.${action}`];
  if (exact) return exact;
  const family = dictionary[`activity.family.${action.split('.')[0] ?? ''}`];
  if (family) return family;
  return dictionary['activity.action.other'] ?? '';
}

/** The kind of thing an event touched, or null — a raw type is never shown. */
export function activityResourceLabel(
  resourceType: string | null,
  dictionary: Readonly<Record<string, string | undefined>>,
): string | null {
  if (!resourceType) return null;
  return dictionary[`activity.resource.${resourceType}`] ?? null;
}
