-- Brand Brain operational policy becomes a TENANT-READABLE projection.
--
-- WHY. The customer dashboard must state the accepted file types, the upload
-- ceiling and the D-78 retention window, and must enforce the chunking and
-- staleness rules an owner configured. Until now it carried its own copy of
-- those numbers with a comment saying they "mirror" the `brand-brain`
-- configuration schema. Two copies of a setting are two settings: an owner who
-- shortened the retention window in Platform Admin changed nothing a customer
-- could see, and the chat notice went on promising ninety days. CLAUDE.md §2.2.
--
-- The fix is the mechanism this table already exists for. `configuration_version`
-- stays platform-owned with every privilege revoked from the tenant role; the
-- Configuration Service PROJECTS a customer-relevant domain here on activation,
-- and the tenant role may read it and may not write it.
--
-- WHAT IS PROJECTED. The `brand-brain` domain carries only operational policy:
-- accepted media types, size and count ceilings, retry and chunking parameters,
-- the review interval, the candidate confidence floor and the chat retention
-- and context ceilings. No provider, no model, no routing rule, no price, no
-- credential — those live in `ai.*`, `plans` and `integrations.*`, none of which
-- this CHECK admits.

-- The CHECK also gains 'credits', which `CUSTOMER_VISIBLE_DOMAINS` has listed
-- since Phase 3 while the constraint did not. Activating a `credits` version
-- would have failed on this constraint — a latent defect this migration closes
-- rather than leaves for whoever activates one first.
ALTER TABLE "entitlement_catalogue_snapshot"
  DROP CONSTRAINT "entitlement_catalogue_snapshot_allowed_domains";

ALTER TABLE "entitlement_catalogue_snapshot"
  ADD CONSTRAINT "entitlement_catalogue_snapshot_allowed_domains"
  CHECK ("domain" IN ('entitlements', 'plans', 'feature-flags', 'credits', 'brand-brain'));
