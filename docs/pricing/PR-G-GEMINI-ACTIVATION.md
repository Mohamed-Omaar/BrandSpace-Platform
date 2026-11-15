# PR G — Google Gemini as a second image provider (D-611)

> **بالعربية:** يضيف هذا التغيير Google Gemini مزوّدًا ثانيًا للصور خلف بوابة الذكاء الاصطناعي، دون تغيير
> التوجيه: كل المهام تبقى على gpt-image-2. ويضيف صفحة مقارنة للمالك وحده تشغّل الطلب نفسه على نموذجين
> جنبًا إلى جنب (الوقت والتكلفة والصورة). المفتاح يُدخل في مركز التحكم ويُخزَّن مشفّرًا، ولا يُكتب في
> المحادثة أبدًا.

**Routing does not change.** Every task stays on the model its route names (gpt-image-2). Gemini is
used only by the comparison bench until the owner points a route at one of its models.

## What Google's pages say (read 2026-11-15)

Read through search of Google's own pages; this environment's network cannot open `ai.google.dev`
directly, so confirm the figures on the live pages before you activate.

### Models

| Name                           | Model id (REST)                                                 | Status                             |
| ------------------------------ | --------------------------------------------------------------- | ---------------------------------- |
| Nano Banana 2.1                | `gemini-nano-banana-2.1`                                        | GA (Google Cloud docs: 6 Oct 2026) |
| Nano Banana Pro (the high one) | `gemini-3-pro-image-preview` (some pages: `gemini-3-pro-image`) | check the model list               |

The bench's **Test the connection** lists the models your key can see; use the exact id it shows.

### Prices (paid tier, standard; Gemini Developer API pricing page)

| Model           | Image output     | 1K image | 2K image | 4K image |
| --------------- | ---------------- | -------- | -------- | -------- |
| Nano Banana 2.1 | $30 / 1M tokens  | ~$0.034  | ~$0.050  | ~$0.113  |
| Nano Banana Pro | $120 / 1M tokens | ~$0.134  | ~$0.134  | ~$0.24   |

Batch is half price (not used here). **Thinking tokens are billed on top** for the Pro model: a
developer report shows ~800 extra tokens on a 1K Pro image (about $0.13 → $0.23). The adapter
records Google's own token counts (image + thinking) on every call, and the bench shows them.

For comparison, gpt-image-2 is priced per image by quality and size (your active `ai.models`).

### Data terms (Gemini API Additional Terms of Service; Data logging and sharing)

- **Paid Services** — the API through a Google Cloud project **with an active billing account**:
  Google does **not** use prompts or responses to improve its products. It logs them **for a
  limited period, only to detect and prevent violations** of its Prohibited Use Policy.
- **Unpaid use** (no billing account): Google **may** use prompts and responses to improve its
  products, and human reviewers may read them. **So the key must come from a project with billing
  on.**
- Grounding with Google Search stores prompts for 30 days (not used here).
- Opting into data sharing or the "Contributor" tier moves data under the unpaid terms: leave it off.
- EEA, Switzerland and UK: the paid-service terms apply to all use.
- Every image carries Google's invisible SynthID watermark.

Sources: [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) ·
[Image generation](https://ai.google.dev/gemini-api/docs/image-generation) ·
[Nano Banana 2.1 (Google Cloud)](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/nano-banana-2-1) ·
[Additional Terms of Service](https://ai.google.dev/gemini-api/terms) ·
[Data logging and sharing](https://ai.google.dev/gemini-api/docs/logs-policy) ·
[Zero data retention](https://ai.google.dev/gemini-api/docs/zdr)

## Owner steps (staging)

The key is entered in the Control Center, which stores it encrypted (Secret Service). It is never
a Railway variable and never pasted in chat.

1. In Google AI Studio, create an API key in a Google Cloud project **with billing turned on**.
2. Control Center → AI & integrations → **Integrations** → AI → **Google Gemini** → paste the key
   in **API key** → Save. Leave the API address as it is.
3. Press **Test the connection**. It lists models and generates nothing.
4. Activate it, and answer the privacy review (D-13) from Google's terms above: **no training on our
   data — yes** (paid tier only), **retention — limited** (logged for a limited time, for abuse
   detection only). With billing off, neither is true: do not activate.
5. Configuration → `ai.models` → new draft: add the two rows below (change only the ids if Test
   shows different ones) → Validate & preview → Activate.
6. Control Center in **Advanced** mode → AI & integrations → **Image comparison** (Platform Owner
   only; in Simple mode open `/en/console/ai-compare`): write a brief, choose a format and
   quality, pick gpt-image-2 and a Gemini model, **Run both**. Each run is audited with the models,
   time and cost (never the brief or the images).

### `ai.models` rows to add

Priced per image at the **2K** rate, because the Studio's formats (1080×1350, 1080×1920) map to 2K.
`custom` sizing passes the Studio's own size to the adapter, which sends Google the closest aspect
ratio and 1K / 2K / 4K by the longer edge.

```json
[
  {
    "key": "gemini-nano-banana-2.1",
    "providerKey": "gemini",
    "displayName": "Nano Banana 2.1",
    "modality": "image",
    "qualityTier": "balanced",
    "status": "beta",
    "disableSwitch": false,
    "inputCostPerUnitMicroMinor": 0,
    "outputCostPerUnitMicroMinor": 5040000,
    "costUnit": "image",
    "costCurrency": "USD",
    "imageSizing": {
      "mode": "custom",
      "multipleOf": 1,
      "minPixels": 262144,
      "maxPixels": 16777216,
      "maxEdge": 4096,
      "maxAspectRatio": 2.34
    },
    "pricingEffectiveFrom": "2026-11-15"
  },
  {
    "key": "gemini-3-pro-image-preview",
    "providerKey": "gemini",
    "displayName": "Nano Banana Pro",
    "modality": "image",
    "qualityTier": "premium",
    "status": "beta",
    "disableSwitch": false,
    "inputCostPerUnitMicroMinor": 0,
    "outputCostPerUnitMicroMinor": 13400000,
    "costUnit": "image",
    "costCurrency": "USD",
    "imageSizing": {
      "mode": "custom",
      "multipleOf": 1,
      "minPixels": 262144,
      "maxPixels": 16777216,
      "maxEdge": 4096,
      "maxAspectRatio": 2.34
    },
    "pricingEffectiveFrom": "2026-11-15"
  }
]
```

`ai.providers` needs a `gemini` record (the Integrations Hub writes it when you save and activate
the provider): `"key": "gemini", "adapter": "gemini"`, its key's secret reference, base URL
`https://generativelanguage.googleapis.com/v1beta`.

Money is in micro-minor units: 1 USD = 100,000,000. $0.0504 = 5,040,000; $0.134 = 13,400,000. The
Pro figure does not include thinking: the bench shows what each call really used, so adjust the
rate after a few runs if thinking pushes it up.
