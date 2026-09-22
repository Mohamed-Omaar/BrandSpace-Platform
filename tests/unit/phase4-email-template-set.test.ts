import { describe, expect, it } from 'vitest';
import { EMAIL_TEMPLATE_KEYS } from '@brandspace/auth';
import { deliverySchema } from '../../apps/api/src/routes/internal-email';

/**
 * ONE CLOSED SET, DECLARED ONCE — Phase 4 §7 (a rule enforced on one path and
 * not the other).
 *
 * THE DEFECT, AND HOW IT WAS FOUND. `auth.password_reset.unknown` is the Phase 4
 * template that makes a reset request answer identically for a registered and an
 * unregistered address. It was declared in `@brandspace/auth`, given both
 * languages, rendered correctly, and sent by the dashboard — and the API's
 * internal delivery route REFUSED it, because that route carried its own
 * hand-written `z.enum` of six keys and the new one was a seventh. Wherever mail
 * is delegated to the API rather than written to the outbox, every reset request
 * for an address with no account therefore failed. It was caught by the E2E
 * suite, not by any unit test, because nothing had ever compared the two lists.
 *
 * WHY A RUNTIME LIST. The route needs the set at runtime to refuse anything
 * outside it — that closed set is what stops a holder of the service token
 * composing a message the product would never send — and a TypeScript union is
 * gone by then. So the union is now DERIVED from `EMAIL_TEMPLATE_KEYS` and the
 * route's schema is BUILT from the same array.
 *
 * WHAT THIS ASSERTS IS THE WIRING, NOT THE ARRAY. Comparing the array to itself
 * would prove nothing. It drives every declared key through the route's ACTUAL
 * request schema, which is the thing that rejected the template in production
 * code — so restoring the hand-written enum fails this test on exactly the key
 * that was missing.
 */

describe('every template the product declares is deliverable through the API', () => {
  it('accepts each declared key', () => {
    const refused = EMAIL_TEMPLATE_KEYS.filter(
      (templateKey) =>
        !deliverySchema.safeParse({ to: 'someone@example.test', templateKey, locale: 'EN' })
          .success,
    );
    expect(refused).toEqual([]);
  });

  it('still refuses a key the product does not declare', () => {
    // The closed set is the point of the schema; deriving it must not open it.
    const result = deliverySchema.safeParse({
      to: 'someone@example.test',
      templateKey: 'auth.anything_the_caller_likes',
      locale: 'EN',
    });
    expect(result.success).toBe(false);
  });

  it('carries the pair that makes a reset request uniform', () => {
    // Named explicitly: this pair is a security property (D-253), not an
    // incidental pair of strings, and a future tidy-up must trip over it.
    expect(EMAIL_TEMPLATE_KEYS).toContain('auth.password_reset');
    expect(EMAIL_TEMPLATE_KEYS).toContain('auth.password_reset.unknown');
  });
});
