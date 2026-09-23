/**
 * The absolute floor a customer password may be held to.
 *
 * ONE NUMBER, TWO CONSUMERS, AND THEY MUST NOT DRIFT. The configuration schema
 * uses it as the lowest value an operator may enter, and `hashPassword` uses it
 * as the last-resort guard before a hash is computed. Written in two places,
 * they would eventually disagree — and the way that failure presents is a
 * password the sign-up form accepts and the domain refuses, which reads to the
 * customer as the site being broken.
 *
 * IT LIVES IN `shared` BECAUSE BOTH SIDES CAN REACH IT. `packages/auth` must
 * not import `packages/config` to ask a question about its own domain, and
 * `packages/config` must not import `packages/auth`.
 *
 * WHY EIGHT (P6-03a). It was twelve, which is a good number for a password and
 * a poor one for a floor: it rejected a great many passphrases people would
 * actually remember, and the observable effect of a floor set too high is not
 * stronger passwords but more reuse of one the person already has memorised
 * somewhere else. NIST SP 800-63B puts the minimum at eight and spends its
 * remaining advice on what actually resists guessing — length over composition,
 * no forced rotation, no symbol classes, and screening against breach corpora.
 *
 * THIS IS A FLOOR, NOT THE POLICY. The policy in force is
 * `onboarding.signup.minPasswordLength`, which an operator sets from Platform
 * Admin and may put anywhere from here to 128 (CLAUDE.md §2.2 — the NUMBER is
 * configuration, only the bound is code). Nothing reads this constant to decide
 * what to require of a customer; it decides what configuration may ask for.
 *
 * NOTHING HERE APPLIES TO PLATFORM ADMIN. Platform accounts carry mandatory
 * MFA (D-27) and their own rules, and this change does not touch them.
 */
export const ABSOLUTE_MIN_PASSWORD_LENGTH = 8;

/**
 * The longest password that may be required — and accepted.
 *
 * A ceiling exists because Argon2id hashes whatever it is given, and an
 * unbounded input is a cheap way to make a login request expensive. It is high
 * enough that no memorable passphrase reaches it.
 */
export const ABSOLUTE_MAX_PASSWORD_LENGTH = 128;
