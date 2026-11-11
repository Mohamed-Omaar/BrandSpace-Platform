# PR A — activating the smart Copilot's model and price on staging (D-604)

The tool loop works on staging's current configuration as soon as PR A is deployed: `copilot.chat`
keeps its route (gpt-5.4-mini → gpt-5.4-nano) and its price. These three edits switch it to the
STRONGER model with vision and set ONE price per message. Each is an edit to a draft of the ACTIVE
version — **never paste a whole document**.

Order: `ai.models`, then `ai.credit-rules`, then `ai.routing` (a route is refused unless the active
prices cover it; the margin check reads the active models). Before you start, write down the
version number of the ACTIVE version of each of the three domains: those are your rollback targets.

**Why gpt-5.4 and not gpt-6.1-sol.** OpenAI's own guidance: "GPT-6.1 Sol and GPT-6.1 Terra support
Chat Completions, but tool calling requires Responses" — this platform's adapter uses Chat
Completions, so Sol cannot run the tool loop. gpt-5.4 answers without reasoning by default (fast),
calls tools in Chat Completions and reads images. Prices from OpenAI's pricing page (2026-11-09):
gpt-5.4 $2.50 / $15.00 per million input / output tokens, $0.25 cached input.

## Step 1 — `ai.models`: add gpt-5.4, and let mini read images and call tools

1. Configuration → `ai.models` → Change reason: `PR A: gpt-5.4 for the Copilot; vision and tools on mini` → **Create draft**.
2. Find the line `"models": [`. Put the cursor at the END of that line, press Enter and paste this
   snippet exactly — **it ends with a comma**:

<!-- pr-a-model-gpt-5.4 -->

```json
    {
      "key": "gpt-5.4",
      "providerKey": "openai",
      "displayName": "GPT-5.4",
      "modality": "text",
      "qualityTier": "premium",
      "status": "beta",
      "inputCostPerUnitMicroMinor": 250000,
      "outputCostPerUnitMicroMinor": 1500000,
      "supportsVision": true,
      "supportsToolUse": true,
      "supportsStreaming": true
    },
```

3. In the model whose `"key"` is `"gpt-5.4-mini"`, add these three fields (after its `"key"` line;
   each line ends with a comma):

<!-- pr-a-mini-fields -->

```json
      "supportsVision": true,
      "supportsToolUse": true,
      "supportsStreaming": true,
```

4. **Save draft** → **Validate & preview** must show: 0 errors; impact exactly two lines —
   `model "gpt-5.4" will be added` and `model "gpt-5.4-mini" changes: supportsVision, supportsToolUse, supportsStreaming`.
   Any other line: discard and start again. Then **Activate**.

## Step 2 — `ai.credit-rules`: one price per message, 4 credits

1. Configuration → `ai.credit-rules` → Change reason: `PR A: Copilot 4 credits per message` → **Create draft**.
2. Find the line `"costs": [`, put the cursor at the END of it, press Enter and paste (ends with a comma):

<!-- pr-a-credit-gpt-5.4 -->

```json
    {
      "taskKey": "copilot.chat",
      "modelKey": "gpt-5.4",
      "baseMilliCredits": 4000,
      "perUnitMilliCredits": 0,
      "unit": "request",
      "marginInputTokens": 63000
    },
```

3. In the two existing rows whose `"taskKey"` is `"copilot.chat"` (models `gpt-5.4-mini` and
   `gpt-5.4-nano`): change `"baseMilliCredits": 1000` to `"baseMilliCredits": 4000`, and change
   `"marginInputTokens": 25000` to `"marginInputTokens": 63000`.
4. **Save draft** → **Validate & preview** must show: 0 errors; exactly ONE margin warning, on
   `copilot.chat on gpt-5.4` ("earns 26.9% gross margin at its worst case" — the current route still
   allows 800 output tokens; it reads about 24% after step 3); impact lines only for
   `credit cost "copilot.chat"`. Then **Activate**.

**What 4 credits ($0.232) earns** — one message is up to 4 model calls (`copilot.agent.maxRounds`),
charged once. Costs from OpenAI's prices, with the prompt cache on rounds 2–4:

| Message on gpt-5.4                        | Cost     | Margin |
| ----------------------------------------- | -------- | ------ |
| A simple question (1 call)                | ≈ $0.044 | 81%    |
| With tools (3 calls)                      | ≈ $0.072 | 69%    |
| Worst case (4 calls, long context, cache) | ≈ $0.176 | 24%    |

The margin check models no cache, so it states the worst case as 63,000 input tokens plus the 1,200
output tokens of one call — the same $0.176 — and warns at 24%. On gpt-5.4-mini (the fallback) the
same message earns 77% or more.

## Step 3 — `ai.routing`: the Copilot on gpt-5.4, longer replies

1. Configuration → `ai.routing` → Change reason: `PR A: Copilot on gpt-5.4, 1,200 tokens per call` → **Create draft**.
2. Find the rule whose `"taskKey"` is `"copilot.chat"` and make it read exactly:

<!-- pr-a-route-copilot -->

```json
    {
      "taskKey": "copilot.chat",
      "primaryModelKey": "gpt-5.4",
      "fallbackModelKeys": ["gpt-5.4-mini"],
      "timeoutMs": 120000,
      "parameters": {
        "maxOutputTokens": 1200,
        "attemptTimeoutMs": 90000
      }
    },
```

3. **Save draft** → **Validate & preview** must show: 0 errors; the same single margin warning, now
   about 24% (1,200 output tokens per call);
   impact exactly one line — `routing rule "copilot.chat" changes: primaryModelKey, fallbackModelKeys, timeoutMs, parameters`.
   Then **Activate**.

## How to check (staging)

1. Open the Copilot and ask: "What is on our calendar this week?" — "Checked the calendar" appears,
   then the answer word by word. The price beside Send says 4 credits; the wallet drops by 4 once.
2. Ask: "Write an Instagram post about our offer, with a picture." — "Read the Brand Kit", "Created a
   post draft", "Started an image"; an **Open draft** link; the image is attached within about a minute.
3. Ask something long and press **Stop** while it writes — "Stopped. Nothing was charged."; the wallet
   is unchanged.
4. Attach a photo (the paper-clip) and ask "What do you see?" — it describes the photo.
5. Ask "Schedule that draft for Friday 10:00" — a confirmation card appears; nothing is scheduled
   until you confirm.

## Rollback

Reverse order: routing, then credit rules, then models — **Roll back** on the versions you wrote
down. Rolling back routing alone returns the Copilot to gpt-5.4-mini at the price still active.
