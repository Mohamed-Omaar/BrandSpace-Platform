-- Optional storage for a model's output on the request row.
--
-- docs/AI-GATEWAY.md §11 does not persist prompts or responses by default, and
-- this column honours that: it is nullable and stays null unless an operator
-- turns `parameters.persistOutput` on for a routing rule.
--
-- It exists because §7.4's second guarantee — "a duplicate inbound request with
-- the same idempotency key returns the original result without touching the
-- wallet" — cannot be met for a client that lost the response unless the result
-- was kept somewhere. A caller that persists its own artifact leaves it off.

ALTER TABLE "ai_request" ADD COLUMN "outputPayload" JSONB;
