/**
 * ROUND 4 (3.1) — THE STATUSES A SAVE CHANGES NOTHING ABOUT, and so the only
 * ones that save as they are typed. An APPROVED, IN_REVIEW or SCHEDULED post
 * waits for "Save edit": a save there revokes an approval, withdraws a review
 * or unschedules (`revokeApprovalOnEdit`). The editor reads this to decide
 * whether to autosave, and the save action reads it again on the server, in
 * the save's own transaction — so a pause that ends just after "Send for
 * review" cannot withdraw the review it raced.
 */
export const AUTOSAVE_STATUSES: readonly string[] = ['DRAFT', 'CHANGES_REQUESTED', 'FAILED'];
