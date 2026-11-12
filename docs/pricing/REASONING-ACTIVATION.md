# Activation: no temperature for gpt-6.1-sol (D-606)

**What it fixes.** On staging, `strategy.generate` and `plan.monthly` route to `gpt-6.1-sol` with
`gpt-5.4-mini` as fallback. The active routing (v2, read by the owner on 2026-11-12, recorded in
`staging-active-ai-routing-v2.json`) sets `"temperature": 1` and `"maxOutputTokens": 6000` on both, so
each request carries a temperature. gpt-6.1-sol reasons at `medium` by default, and OpenAI
refuses a temperature when a model reasons. The gateway records that refusal as `INVALID_REQUEST`, which
is never retried and never sent to the fallback, so the request fails and nothing is charged.

**The code alone changes nothing on staging.** Whether a model reasons is declared in the catalogue,
never inferred from its name. Until gpt-6.1-sol is declared, the gateway still sends it a temperature.
Once it is declared, no temperature is sent to it even though the route sets one explicitly; the
fallback gpt-5.4-mini, which does not reason, still gets the route's temperature of 1.

## The one change (Control Center → AI models, `ai.models`)

On the `gpt-6.1-sol` record, add one field (`reasoning-ai-models-change.json`):

```json
"defaultReasoningEffort": "medium"
```

<!-- reasoning-model-gpt-6.1-sol -->

Validate, then activate. Nothing else changes: no price, no route, no other model. `ai.routing` needs no
change; a route may later name its own `reasoningEffort`.

## Check after activation

Generate a strategy and a monthly plan on staging. Each should succeed on gpt-6.1-sol. In the request
log, the row for each shows the model `gpt-6.1-sol` and no failure.
