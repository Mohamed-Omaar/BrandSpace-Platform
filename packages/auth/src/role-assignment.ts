import { AppError } from '@brandspace/shared';

/**
 * THE ROLE-ASSIGNMENT LADDER — one definition, every grant path.
 *
 * WHY THIS FILE EXISTS. The ladder used to live inside `memberships.ts`, where
 * `changeRole` and `removeMember` consulted it. `InvitationService.create` —
 * the OTHER way a role reaches a person — checked only that the inviter held
 * `member.invite`, and never compared the requested role against what the
 * inviter may grant. A `workspace_admin` holds `member.invite`, so editing one
 * form field issued an invitation for `workspace_owner`: a one-step escalation
 * to exactly the three authorities admin is denied (billing, deletion and
 * ownership transfer).
 *
 * The defect was not that the rule was wrong. It was that the rule had one
 * enforcement site and two grant paths. A second copy would have had the same
 * shape and the same failure mode, so this module is the single copy and both
 * paths import it.
 *
 * NOT AUTHORIZATION ON ITS OWN. Holding the permission (`member.assign_role`
 * or `member.invite`) is a separate question, checked by the caller. This
 * module answers only "may an actor in role X hand out role Y", which is the
 * question docs/SECURITY.md §4.3 calls "Assign roles — Admin: below own level".
 *
 * PLATFORM ACTORS ARE NOT ON THIS LADDER. A platform inviter has no workspace
 * role to rank, and its authority comes from a platform permission plus
 * verified MFA (D-27). `assertMayAssignRole` is therefore never asked about
 * one; `InvitationService` keeps that branch separate and says so.
 */

/**
 * Roles an actor may assign, by the role the actor holds.
 *
 * A role that is absent from this table may assign NOTHING. That is the
 * fail-closed direction: a new role added to the seed does not silently gain
 * the authority to mint owners.
 */
const ASSIGNABLE_BY: Record<string, readonly string[]> = {
  // The owner may appoint anyone, including another owner.
  workspace_owner: [
    'workspace_owner',
    'workspace_admin',
    'marketing_manager',
    'content_creator',
    'copywriter',
    'designer',
    'approver',
    'analyst',
    'client_viewer',
  ],
  // docs/SECURITY.md §4.3: "Assign roles — Admin: below own level."
  workspace_admin: [
    'marketing_manager',
    'content_creator',
    'copywriter',
    'designer',
    'approver',
    'analyst',
    'client_viewer',
  ],
};

/**
 * Which roles this actor may assign.
 *
 * Exposed so a screen can render only the assignable options — but rendering is
 * not authorization. `assertMayAssignRole` is the control, and it runs on the
 * server for every grant path regardless of what the form contained.
 */
export function assignableRoleKeys(actorRoleKey: string): readonly string[] {
  return ASSIGNABLE_BY[actorRoleKey] ?? [];
}

/**
 * Refuse an actor that may not hand out the requested role.
 *
 * The message names the role, not the ladder, so it is useful to a legitimate
 * operator without describing the shape of the rule to somebody probing it.
 */
export function assertMayAssignRole(
  actorRoleKey: string,
  targetRoleKey: string,
  operation: string,
): void {
  if (!assignableRoleKeys(actorRoleKey).includes(targetRoleKey)) {
    throw new AppError('FORBIDDEN', `${operation}: your role may not assign "${targetRoleKey}".`);
  }
}
