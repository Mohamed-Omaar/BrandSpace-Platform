-- Phase 9 — customer MFA enrolment.
--
-- WHY THE CUSTOMER CANNOT USE THE PLATFORM SECRET SERVICE. `secret_record` holds
-- BrandSpace's own provider credentials, it is platform-owned, and creating a row
-- in it requires a platform actor with verified MFA. A customer enrolling their
-- own authenticator has no platform actor and must not cause one to be
-- impersonated — so their TOTP seed is sealed with a SEPARATE key domain
-- (CUSTOMER_MFA_VAULT_KEK) and the envelope is kept on the identity row.
--
-- THE SEED IS NEVER STORED. `mfaSecretMaterial` is the AEAD envelope: ciphertext,
-- iv, auth tag, wrapped data key and the authenticated context that binds it to
-- this one user. Holding the database without the KEK yields nothing, and the
-- plaintext exists only in the QR code shown once at enrolment.
ALTER TABLE "user" ADD COLUMN "mfaSecretMaterial" JSONB;
ALTER TABLE "user" ADD COLUMN "mfaEnrolledAt" TIMESTAMPTZ(6);

-- Enrolled means both facts, or neither. A user flagged as MFA-enabled with no
-- material would be locked out of their own account by a check that can never
-- pass; one with material and no flag would have a secret nothing consults.
ALTER TABLE "user"
  ADD CONSTRAINT "user_mfa_enrolment_coherent" CHECK (
    "mfaEnabled" = false
    OR "mfaSecretRef" IS NOT NULL
    OR "mfaSecretMaterial" IS NOT NULL
  );

-- ---------------------------------------------------------------------------
-- MFA on the CUSTOMER SESSION.
--
-- A SESSION THAT HAS NOT PASSED MFA GRANTS NOTHING. The platform realm already
-- works this way; the customer realm needs the same column so that a correct
-- password on an MFA-enrolled account produces a session which resolves to null
-- until the second factor is presented. Without it the only way to enforce MFA
-- would be to withhold the session entirely, which loses the state the second
-- step needs.
ALTER TABLE "customer_session" ADD COLUMN "mfaVerifiedAt" TIMESTAMPTZ(6);

-- ---------------------------------------------------------------------------
-- THE ONBOARDING DOMAIN JOINS THE CUSTOMER-VISIBLE PROJECTION.
--
-- The signup and first-run screens STATE the rules as they ask: whether signup
-- is open, the password floor, how long a verification link lasts, which legal
-- documents must be accepted and at which version. Restating any of that in a
-- component would make it a second setting that the owner cannot actually
-- change. The CHECK is the database's copy of `CUSTOMER_VISIBLE_DOMAINS`, kept
-- in step so a projection nobody reviewed cannot appear.
ALTER TABLE "entitlement_catalogue_snapshot"
  DROP CONSTRAINT "entitlement_catalogue_snapshot_allowed_domains";

ALTER TABLE "entitlement_catalogue_snapshot"
  ADD CONSTRAINT "entitlement_catalogue_snapshot_allowed_domains"
  CHECK ("domain" IN (
    'entitlements', 'plans', 'feature-flags', 'credits',
    'brand-brain', 'assets', 'content', 'publishing',
    'analytics', 'copilot', 'automations', 'commerce',
    'onboarding'
  ));
