import { hash, verify } from '@node-rs/argon2';

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
  if (plaintext.length < 12) {
    throw new Error('Password must be at least 12 characters (docs/SECURITY.md §3).');
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
