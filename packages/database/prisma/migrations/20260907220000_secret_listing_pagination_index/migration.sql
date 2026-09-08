-- ===========================================================================
-- F-53 — support the Control Center's paginated secret listing.
--
-- The listing filters by environment and orders by `[category, name, id]`. With
-- only `(environment, status)` and `(category)` available, PostgreSQL sorts the
-- entire matching set to return twenty-five rows — the work pagination exists
-- to avoid, merely moved from the application into the planner.
--
-- `id` is part of the index because it is part of the ORDER BY: it is the
-- tie-breaker that makes the order total, and without a total order offset
-- pagination is not well defined — two records agreeing on category and name
-- could swap between the count and the fetch, putting one row on two pages and
-- another on none.
--
-- Index only. No column, constraint, policy or privilege changes.
-- ===========================================================================

CREATE INDEX "secret_record_environment_category_name_id_idx"
  ON "secret_record" ("environment", "category", "name", "id");
