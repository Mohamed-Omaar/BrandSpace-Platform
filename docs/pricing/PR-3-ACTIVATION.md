# PR 3 — activating the pricing set on staging (D-599)

Three documents, activated in this order, each in Control Center → **Configuration**:

| Step | Domain            | What you paste or change                                                    |
| ---- | ----------------- | --------------------------------------------------------------------------- |
| 1    | `ai.models`       | One field on `gpt-image-2` only — `docs/pricing/pr-3-ai-models-change.json` |
| 2    | `ai.credit-rules` | The whole document — `docs/pricing/pr-3-ai-credit-rules.json`               |
| 3    | `ai.routing`      | One rule added to a draft of the active routing — the snippet in step 3     |

**Why this order.** A route is refused unless the active prices cover it (#111), and the margin
warning reads the active models. Models first, then prices, then routes — never routes first.

Before you start, write down the **version number of the ACTIVE version** of each of the three
domains (the Versions table, Status "ACTIVE"). Those are your rollback targets.

## Step 1 — `ai.models` (one field)

1. Configuration → `ai.models` → Change reason: `PR 3: per-quality image cost on gpt-image-2` → **Create draft**.
   The draft starts as a copy of the active catalogue.
2. In the draft, find the model whose `"key"` is `"gpt-image-2"`. Add this field inside it
   (or replace its `null` value if the field is already there):
   ```json
   "imageCostByQualityMicroMinor": { "low": 600000, "medium": 5300000, "high": 21100000 }
   ```
   Change nothing else. Do not paste a whole catalogue over it.
3. **Save draft** → **Validate & preview**. Expect: no errors. Warnings are allowed.
4. **Activate**.

## Step 2 — `ai.credit-rules` (whole document)

1. Configuration → `ai.credit-rules` → Change reason: `PR 3: credit $0.058, images by quality, brand.extract` → **Create draft**.
2. Replace the whole draft with the contents of `docs/pricing/pr-3-ai-credit-rules.json`.
3. **Save draft** → **Validate & preview**. Expect:
   - no errors;
   - **exactly one D-15 warning**, on `copilot.chat on gpt-5.4-mini` ("earns 61.5% gross margin
     at its worst case, below the 65% target"). Accepted by the owner; repriced in Job 2.
4. **Activate**.

## Step 3 — `ai.routing` (add ONE rule to the active routing; nothing else)

**Do not paste a whole routing document.** The active routing carries the deadlines set after the
timeout fix (text tasks 60 s, `strategy.generate` and `plan.monthly` 120 s, `image.generate` 180 s);
the draft keeps them because it starts as a copy of the active version, and you only add one rule.

1. Configuration → `ai.routing` → Change reason:
   `PR 3: route brand.extract (mini → nano, 4,000 tokens)` → **Create draft**.
2. In the draft, find the line `"rules": [` near the top. Put the cursor at the END of that line,
   press Enter, and paste this snippet exactly — **it ends with a comma**, which separates it from
   the rule that was first in the list:

<!-- pr-3-brand-extract-rule -->

```json
    {
      "taskKey": "brand.extract",
      "primaryModelKey": "gpt-5.4-mini",
      "fallbackModelKeys": ["gpt-5.4-nano"],
      "timeoutMs": 180000,
      "parameters": {
        "maxOutputTokens": 4000,
        "attemptTimeoutMs": 120000
      }
    },
```

The result looks like this (the first existing rule follows the snippet unchanged):

```text
{
  "rules": [
    {
      "taskKey": "brand.extract",
      ...
    },
    {
      "taskKey": "caption.generate",   ← whatever rule was first before; untouched
      ...
```

Do not change any other line. If a `brand.extract` rule is already in the draft, stop and tell
the developer — never add a second one.

3. **Save draft**. If it refuses with a JSON error, the comma is missing or doubled: compare with
   the snippet above.
4. **Validate & preview** must show exactly:
   - **Validation:** 0 errors. One warning only, the accepted D-15 margin warning on the
     `copilot.chat` / `gpt-5.4-mini` credit row ("earns 61.5% gross margin at its worst case, below
     the 65% target").
   - **Impact:** exactly ONE line — `routing rule "brand.extract" will be added`. No line saying
     `routing rule "…" changes: …` and none saying `will be REMOVED`.

   **If the impact shows any other line, do not activate**: discard the draft and start again at 1.
   If validation shows the error "Duplicates rule 0: same task, scope and target at the same
   priority", the snippet was pasted twice (or a `brand.extract` rule was already there): it cannot
   be activated — discard the draft and start again at 1.

5. **Activate**.

What the rule does: `brand.extract` reads a file of up to ~52,000 tokens and writes up to 4,000, on
mini with nano as fallback. One attempt may take 120 s (without `attemptTimeoutMs` a text attempt is
cut at the provider's own limit, D-597); the whole request, retry included, ends at 180 s.

## How to check (staging, a customer workspace with credits)

1. **Images by quality.** Creative Studio → choose Low → the price beside Generate shows **1 credit**;
   Medium **6**; High **24**. Generate one Low image: the wallet drops by 1 credit.
2. **No quality chosen.** Generate from the post drawer or the Copilot (no quality picker): it runs
   and costs **6 credits** (medium), never "AI isn't available".
3. **Files read by `brand.extract`.** In the Copilot, add a PDF or DOCX about the brand → the card
   offers its facts. The source's reading shows `brand.extract`, not keyword, and the wallet drops by
   **3 credits** once. Adding the same file again does not charge again.
4. **Everything else unchanged.** Write a caption with AI: 2 credits. Ask the Copilot a question:
   1 credit.
5. **Deadlines kept.** Generate a High story image: it may take up to ~2 minutes and must not fail
   at 30 s. A strategy proposal must not fail at 30 s either.
6. Control Center → AI usage: the image requests record a provider cost by quality (a Low square is
   about $0.007, not $0.211).

## Rollback

Undo in the **reverse** order: routing, then credit rules, then models. In each domain's Versions
table, the version you wrote down is now "SUPERSEDED": enter a Rollback reason → **Roll back**.

- Rolling back **`ai.routing` alone** switches `brand.extract` off (files go back to keyword
  reading), restores the exact earlier version with its deadlines, and leaves the new prices in place.
- Rolling back **`ai.credit-rules`** while the new routing is active is refused if a route would be
  left unpriced — roll back routing first.
- Rolling back **`ai.models`** only returns images to being recorded at one rate ($0.211 each);
  it changes no customer price.

Nothing in this change touches the database schema, so no data needs to be restored.
