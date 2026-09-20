import { describe, expect, it } from 'vitest';
import { MAX_DELIVERY_ATTEMPTS } from '@brandspace/billing';
import { QUEUE_DEFINITIONS } from '@brandspace/jobs';

/**
 * The retry budget is DECLARED in one place and ENFORCED in another, so this
 * test is the thread between them.
 *
 * `QUEUE_DEFINITIONS['billing-events']` is where docs/ARCHITECTURE.md §9's
 * retry policy for billing is written down, and `MAX_DELIVERY_ATTEMPTS` in
 * `@brandspace/billing` is the number the reconciler actually counts to before
 * it dead-letters an event. They are deliberately not the same constant:
 * `@brandspace/billing` does not depend on `@brandspace/jobs` and should not
 * acquire the dependency for one integer.
 *
 * TWO NUMBERS WITH NO TEST BETWEEN THEM IS THE SHAPE OF THE DEFECT THIS WHOLE
 * CHANGE CAME FROM — a queue definition that declared a retry policy nothing
 * implemented. So the binding is asserted rather than assumed.
 */
describe('the billing retry budget matches the policy that declares it', () => {
  it('the reconciler counts to the number the billing-events queue declares', () => {
    expect(MAX_DELIVERY_ATTEMPTS).toBe(QUEUE_DEFINITIONS['billing-events'].maxAttempts);
  });

  it('the declared policy is a backoff, which is what makes a retry budget safe', () => {
    // A fixed-interval retry against a provider that is already struggling is
    // how a transient failure becomes an outage. §5 says backoff, and the
    // transport that honours it is the provider's own redelivery (D-222).
    expect(QUEUE_DEFINITIONS['billing-events'].backoff).toBe('exponential');
  });

  it('the budget is greater than one, or "retry" would be a word without a behaviour', () => {
    expect(MAX_DELIVERY_ATTEMPTS).toBeGreaterThan(1);
  });
});
