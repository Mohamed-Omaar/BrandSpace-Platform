import type { Clock } from '@brandspace/shared';
import type { ContentPolicy } from './policy';

/**
 * D-116 and D-117 — how long persisted AI output is kept, and who decides.
 *
 * THE REGISTRY BELOW IS THE POINT OF F-73. The finding was not "chat has no
 * retention" — chat has one. It was that persistence had no *customer-facing*
 * control and no way to tell whether a feature that persists output has anyone
 * responsible for deleting it. A feature that forgets to answer that question
 * leaves customer content on disk with no owner, and nothing else in the system
 * would notice. So every feature that persists generated output declares itself
 * here, and a unit test fails the build when one does not.
 */

/** What a feature that persists AI output must declare. D-117. */
export interface AiOutputRetentionDeclaration {
  /** Stable key, used in tests and in the settings screen's explanation. */
  readonly featureKey: string;
  /**
   * The package responsible for deleting it. A name, so the answer to "who
   * purges this?" is in the source rather than in somebody's memory.
   */
  readonly retentionOwner: string;
  /** The rows that actually hold customer content. */
  readonly persists: readonly string[];
  /** How the window is decided. */
  readonly behaviour:
    | { readonly kind: 'configured-days'; readonly configPath: string }
    | { readonly kind: 'subscription-linked'; readonly configPath: string };
  /** True when the workspace's own D-117 control narrows the window. */
  readonly honoursWorkspaceControl: boolean;
}

/**
 * Every feature on the platform that persists generated AI output.
 *
 * Adding a feature that persists output without adding it here is a build
 * failure — see `tests/unit/content-retention-registry.test.ts`.
 */
export const AI_OUTPUT_RETENTION_REGISTRY: readonly AiOutputRetentionDeclaration[] = [
  {
    featureKey: 'brand-brain.chat',
    retentionOwner: '@brandspace/brand-brain',
    persists: ['brand_brain_message.body'],
    behaviour: { kind: 'configured-days', configPath: 'brand-brain.chat.retentionDays' },
    // Phase 5A predates the control. The window is the operator's; the customer
    // cannot shorten it yet. Recorded honestly rather than claimed.
    honoursWorkspaceControl: false,
  },
  {
    featureKey: 'content-studio',
    retentionOwner: '@brandspace/content',
    persists: ['content_item', 'content_variant.body'],
    behaviour: { kind: 'subscription-linked', configPath: 'content.retention' },
    honoursWorkspaceControl: true,
  },
];

/**
 * Records this control must NEVER reach — D-116 and D-117 both say so, and it
 * is the half of the decision that is easy to lose in a refactor.
 *
 * The credit ledger is a financial record and the audit log is a security
 * record. A content-retention control able to erase either would be a control
 * that erases evidence, which is precisely what a retention feature must not
 * become. Asserted by a test against the purge's actual behaviour.
 */
export const RETENTION_EXCLUDED_TABLES: readonly string[] = [
  'audit_event',
  'credit_transaction',
  'ai_usage_ledger',
  'ai_request',
  'invoice',
];

export interface RetentionInput {
  /** Whether the workspace's subscription entitles it to indefinite retention. */
  readonly subscriptionActive: boolean;
  /** When the subscription ended, for the grace window. */
  readonly cancelledAt?: Date | null;
  /** The workspace's own D-117 control. Null means "not set". */
  readonly workspaceRetentionDays?: number | null;
}

/**
 * When may this content be purged?
 *
 * `null` means "not yet" — the D-116 default while a subscription is active.
 *
 * THE CUSTOMER'S CONTROL CAN ONLY SHORTEN, NEVER LENGTHEN. A workspace that
 * asks for 14 days gets 14 days even while subscribed; a workspace that asks
 * for 3,650 does not thereby extend a cancelled account's grace period past
 * what the owner approved. Retention is a promise the platform makes and a
 * limit the customer may tighten, not a dial they can use to make the platform
 * store their content for ever.
 *
 * The control is also floored by `minCustomerRetentionDays`, so the setting
 * cannot be used to delete work before the person who generated it has come
 * back from lunch.
 */
export function resolveContentExpiry(
  policy: ContentPolicy,
  input: RetentionInput,
  clock: Clock,
): Date | null {
  const now = clock.now();
  const candidates: Date[] = [];

  if (!input.subscriptionActive) {
    const from = input.cancelledAt ?? now;
    candidates.push(
      new Date(from.getTime() + policy.retention.cancellationGraceDays * 24 * 3600_000),
    );
  }

  const requested = input.workspaceRetentionDays;
  if (typeof requested === 'number' && requested > 0) {
    const days = Math.max(requested, policy.retention.minCustomerRetentionDays);
    candidates.push(new Date(now.getTime() + days * 24 * 3600_000));
  }

  if (candidates.length === 0) return null;
  // The EARLIEST wins: every candidate is a promise to delete by then, and
  // honouring the latest would break the others.
  return candidates.reduce((earliest, d) => (d < earliest ? d : earliest));
}
