import { hash, verify } from '@node-rs/argon2';
import { ABSOLUTE_MAX_PASSWORD_LENGTH, ABSOLUTE_MIN_PASSWORD_LENGTH } from '@brandspace/shared';

/**
 * Password hashing — Argon2id, per docs/SECURITY.md §3.
 *
 * Parameters follow OWASP's current guidance: 19 MiB memory, 2 iterations,
 * 1 degree of parallelism. Memory cost is what makes GPU cracking expensive, so
 * it is the parameter to raise first if hardware improves.
 */
const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  // 2 = Argon2id: resistant to both side-channel and GPU attacks.
  algorithm: 2 as const,
};

export async function hashPassword(plaintext: string): Promise<string> {
  /*
   * THE ABSOLUTE FLOOR, NOT THE POLICY (P6-03a).
   *
   * This used to be a hard-coded 12 — a second, invisible opinion about a
   * number that CLAUDE.md §2.2 puts in configuration, and the one opinion a
   * customer could not see. It outranked `onboarding.signup.minPasswordLength`
   * in practice: an operator lowering the configured minimum got a sign-up form
   * that accepted the password and a domain that refused to hash it, which
   * presents to the customer as the site being broken.
   *
   * What survives is the guard that must not be configurable away: the LOWEST
   * value configuration is allowed to express, shared with the schema that
   * enforces it so the two cannot drift. The policy in force is still resolved
   * from configuration at the boundary, where the customer can be told what it
   * is before they type.
   *
   * THE CEILING IS NEW AND IS NOT COSMETIC. Argon2id hashes whatever it is
   * given, so an unbounded input is a cheap way to make a sign-in expensive.
   */
  if (plaintext.length < ABSOLUTE_MIN_PASSWORD_LENGTH) {
    throw new Error(
      `Password must be at least ${ABSOLUTE_MIN_PASSWORD_LENGTH} characters (docs/SECURITY.md §3).`,
    );
  }
  if (plaintext.length > ABSOLUTE_MAX_PASSWORD_LENGTH) {
    throw new Error(
      `Password must be at most ${ABSOLUTE_MAX_PASSWORD_LENGTH} characters (docs/SECURITY.md §3).`,
    );
  }
  return hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Verify a password. Returns false rather than throwing on a malformed hash, so
 * a corrupted record is a failed login and not a 500 that reveals it exists.
 */
export async function verifyPassword(hashed: string, plaintext: string): Promise<boolean> {
  try {
    return await verify(hashed, plaintext);
  } catch {
    return false;
  }
}
