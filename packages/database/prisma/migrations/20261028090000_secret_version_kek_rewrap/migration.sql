-- D-574 — THE KEK RE-WRAP MAY REPLACE A VERSION'S WRAPPED DATA KEY, AND NOTHING ELSE.
--
-- The secret's material (ciphertext, IV, auth tag, encryption context) and the
-- version's identity (id, secretRecordId, version) stay immutable: rotating a
-- secret still creates a new version, and nothing can move a version to another
-- secret or renumber it. Rotating the KEK that wraps each version's data key
-- changes only "wrappedDataKey", "keyProvider" and "keyId", and only inside a
-- transaction that has set app.kek_rewrap = 'on' with set_config(..., true)
-- (packages/secrets/src/rewrap.ts, docs/SECRET-ROTATION.md).
--
-- Still mutable, because existing flows change them: "status", "activatedAt",
-- "retiredAt" (rotate and revoke, packages/secrets/src/service.ts).
--
-- Forward-only: the trigger is unchanged; only its function is replaced.
CREATE OR REPLACE FUNCTION app.reject_secret_material_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."secretRecordId" IS DISTINCT FROM OLD."secretRecordId"
     OR NEW."version" IS DISTINCT FROM OLD."version"
     OR NEW."ciphertext" IS DISTINCT FROM OLD."ciphertext"
     OR NEW."iv" IS DISTINCT FROM OLD."iv"
     OR NEW."authTag" IS DISTINCT FROM OLD."authTag"
     OR NEW."encryptionContext" IS DISTINCT FROM OLD."encryptionContext" THEN
    RAISE EXCEPTION
      'secret_version material is immutable; rotate by creating a new version'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW."wrappedDataKey" IS DISTINCT FROM OLD."wrappedDataKey"
      OR NEW."keyProvider" IS DISTINCT FROM OLD."keyProvider"
      OR NEW."keyId" IS DISTINCT FROM OLD."keyId")
     AND coalesce(current_setting('app.kek_rewrap', true), '') <> 'on' THEN
    RAISE EXCEPTION
      'secret_version wrapped data key changes only through the KEK re-wrap'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
