# BrandSpace — Billing and AI Credits

> **الملخص التنفيذي بالعربية**
>
> هذا المستند يحدد نموذج **الاشتراكات والفوترة ورصيد الذكاء الاصطناعي**.
>
> **مبدأ أول:** لا نربط المعمارية بمزود دفع واحد. هناك **طبقة تجريد** (Payment Provider Abstraction) تسمح بتغيير مزود الدفع
> أو دعم أكثر من مزود (لأسواق مختلفة) دون إعادة كتابة النظام.
>
> **مبدأ ثانٍ:** كل شيء مالي **قابل للتهيئة من مركز التحكم**: الخطط، الأسعار، العملات، مدة التجربة، الحدود، أسعار الرصيد،
> سياسة التجاوز، وقواعد الترقية والتخفيض.
>
> **مبدأ ثالث:** الرصيد يُدار عبر **دفتر حركات ثابت** لا يُعدَّل ولا يُحذف. الرصيد الحالي يُحسب من الدفتر ويمكن إعادة بنائه بالكامل.
> **لا خصم عند فشل الطلب، ولا خصم مزدوج عند إعادة المحاولة، ولا رصيد سالب أبدًا.**
>
> **مبدأ رابع:** أحداث مزود الدفع (Webhooks) تُعالَج بشكل **غير مكرر** (Idempotent) اعتمادًا على معرّف الحدث،
> مع دعم كامل للفواتير، الضرائب، الكوبونات، الإضافات، الترقية والتخفيض والتناسب الزمني (Proration)، فشل الدفع، فترة السماح،
> الإيقاف، والاسترداد.

---

## Part I — Subscription Billing

## 1. Provider Abstraction

BrandSpace defines its own billing domain and treats payment providers as replaceable adapters. The domain
model (`Plan`, `Subscription`, `Invoice`, entitlements, credits) is **ours**; the provider handles payment
instruments, PCI scope, and money movement.

```ts
interface PaymentProviderAdapter {
  readonly key: string;

  // Customers & payment methods
  ensureCustomer(w: WorkspaceBillingProfile): Promise<ProviderCustomerRef>;
  createCheckoutSession(p: CheckoutParams): Promise<HostedSession>; // hosted → PCI scope stays out of our systems
  createBillingPortalSession(p: PortalParams): Promise<HostedSession>;

  // Subscriptions
  createSubscription(p: CreateSubscriptionParams): Promise<ProviderSubscription>;
  updateSubscription(p: UpdateSubscriptionParams): Promise<ProviderSubscription>; // plan change, seats, add-ons
  cancelSubscription(p: CancelParams): Promise<ProviderSubscription>;
  resumeSubscription(p: ResumeParams): Promise<ProviderSubscription>;

  // One-off & credits
  createOneTimeCharge(p: ChargeParams): Promise<ProviderCharge>; // credit packs, add-ons, overage

  // Invoices & refunds
  getInvoice(id: string): Promise<ProviderInvoice>;
  refund(p: RefundParams): Promise<ProviderRefund>;

  // Webhooks
  verifyWebhook(raw: Buffer, headers: Headers, secret: string): boolean;
  parseWebhook(raw: Buffer): NormalizedBillingEvent[];

  // Capabilities the provider supports (drives UI and validation)
  capabilities(): ProviderCapabilities;
}
```

### 1.1 Design rules

- **Hosted checkout and hosted portal by default** — card data never touches BrandSpace systems, keeping PCI
  scope minimal.
- Provider objects are referenced by ID (`providerKey`, `providerSubscriptionId`, `providerCustomerId`,
  `providerInvoiceId`), never mirrored as the source of truth for entitlements.
- **Entitlements are resolved from our own `Subscription` + `Plan`**, so a provider outage never removes a
  paying customer's access.
- Multiple providers can be active simultaneously (e.g. a global provider plus a regional one for MENA local
  payment methods); the provider is selected per workspace by configuration rules (country, currency).
- `capabilities()` tells the platform what the provider supports (proration, trials without card, tax
  calculation, multi-currency, local methods). The UI and validation adapt rather than assuming.

---

## 2. Products and Pricing

All defined in Platform Admin (`docs/ADMIN-CONTROL-CENTER.md` §4), never in code.

| Item                   | Detail                                                                                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Subscription plans** | Monthly and annual, per currency; annual typically discounted                                                                                                                            |
| **Seats**              | Included seat count + priced additional seats                                                                                                                                            |
| **Add-ons**            | Extra brands, extra social accounts, extra storage, extra AI credits, priority support                                                                                                   |
| **Credit packs**       | One-time purchases, non-expiring or long-expiry                                                                                                                                          |
| **Overage**            | Optional per-plan, priced per credit, capped                                                                                                                                             |
| **Trials**             | Configurable length, card-required or not, trial credits, one trial per workspace (abuse-checked). **Approved: 14 days, no card, 200 credits (D-09)**                                    |
| **Coupons**            | Percentage or fixed, duration (once / repeating / forever), restricted by plan, country, date, and redemption count                                                                      |
| **Taxes**              | Inclusive or exclusive per region; VAT number capture and validation for business customers; provider tax engine where available                                                         |
| **Currencies**         | Configurable list with per-currency price tables. No runtime FX conversion for display prices — each currency has its own explicitly set price. **Approved at launch: SAR + USD (D-08)** |

---

## 3. Subscription Lifecycle

```mermaid
stateDiagram-v2
  [*] --> Trialing: sign-up or admin-provisioned
  Trialing --> Active: payment succeeds
  Trialing --> Expired: trial ends without payment
  Active --> PastDue: payment fails
  PastDue --> Active: retry or manual payment succeeds
  PastDue --> Suspended: grace period elapsed
  Suspended --> Active: payment recovered or admin reactivation
  Active --> PendingDowngrade: downgrade scheduled at period end
  PendingDowngrade --> Active: applied at period end
  Active --> Cancelled: customer cancels
  Cancelled --> Expired: period end
  Expired --> [*]: retention window then deletion
```

### 3.1 Trials

- Length, credits, and card requirement are configuration.
- Trial end triggers reminders at 7 / 3 / 1 days (bilingual templates).
- At expiry without payment: workspace moves to `suspended` — **data is retained**, publishing and AI stop,
  and export remains available.
- Extensions are an audited admin action with a per-role cap.

### 3.2 Upgrades

- Take effect **immediately**.
- Charged with proration for the remainder of the period (when the provider supports it; otherwise a
  one-time charge is created).
- Entitlements apply at once; the credit difference is granted immediately, pro-rated by remaining period
  (policy configurable: full grant vs. pro-rated grant).

### 3.3 Downgrades

- Take effect at **period end** by default, avoiding refund complexity and abrupt capability loss.
- A **pre-downgrade impact check** runs at request time and again before application: seats over limit,
  brands over limit, connected accounts over limit, storage over limit.
- The customer must resolve overages, or choose which resources to deactivate. Nothing is deleted
  automatically — excess resources become read-only/archived and are restored on re-upgrade.
- Unused credits: rollover per plan policy; excess above the new plan's cap is **retained until its own
  expiry** under the approved policy (D-12), not forfeited at period end. The policy is shown before
  confirming.

### 3.4 Cancellation

- Cancel-at-period-end by default; access continues until then.
- Immediate cancellation with proration is an admin action.
- On expiry: workspace `cancelled` → export available for the retention window → deletion per policy.

### 3.5 Payment failure and dunning

Configurable retry schedule (e.g. day 1, 3, 5, 7) with bilingual emails at each step.

```
Payment fails → past_due (full access, banner + email)
  → retries per schedule
  → grace period ends → suspended (AI + publishing stop; data retained; export available)
  → after N days suspended → cancelled
```

Grace period length, retry schedule, and what is disabled at each stage are all configuration.
Recovery at any stage restores access immediately.

### 3.6 Refunds

Full or partial, from Platform Admin with a reason and step-up auth. Issued through the provider,
mirrored to a credit note against the invoice, and audited. Refunding a period may optionally revoke the
credits granted for it (configurable, default: no revocation for goodwill refunds, revocation for fraud).

---

## 4. Invoicing

- Every charge produces an `Invoice` with a sequential number, line items, discounts, taxes, and totals.
- Immutable once issued; corrections are credit notes, never edits.
- PDF stored in object storage, downloadable by the customer from the Billing module and by staff from Admin.
- Bilingual invoice templates with the correct legal entity, tax identifiers, and address.
- Line items are explicit: subscription, seats, add-ons, credit packs, overage, discounts, tax.

---

## 5. Billing Webhooks

| Rule           | Detail                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| Verification   | Signature + timestamp on the raw body, before parsing                                                     |
| Idempotency    | `unique(providerKey, externalEventId)`; replays are no-ops                                                |
| Async          | Acknowledge fast, process on the `billing-events` queue                                                   |
| Ordering       | Events may arrive out of order; state transitions compare event timestamps/versions and ignore stale ones |
| Failure        | Failed processing retries with backoff, then dead-letters with an alert and an admin replay tool          |
| Reconciliation | A daily job compares provider subscription/invoice state against ours and reports drift                   |

Normalized events: `subscription.created` · `subscription.updated` · `subscription.cancelled` ·
`invoice.created` · `invoice.paid` · `invoice.payment_failed` · `charge.refunded` · `dispute.created` ·
`payment_method.updated` · `customer.updated`.

**A webhook never grants entitlements directly.** It updates our `Subscription`, and entitlements are then
resolved from our own model — so a spoofed or malformed event cannot escalate access.

---

## 6. Customer Billing Portal (in the dashboard)

Plan and usage summary · change plan (with impact preview) · add/remove seats · buy credit packs and add-ons ·
manage payment method (hosted) · billing address and tax ID · invoice history and downloads · cancel with
retention offer · **AI credit balance, burn rate, projected exhaustion date, and usage breakdown by member,
brand, and feature**.

Visible only to Workspace Owner (full) and Workspace Admin (read-only).

---

## 7. Platform Billing Reports

MRR/ARR with movement breakdown (new / expansion / contraction / churn) · trial-to-paid conversion ·
revenue by plan, country, and currency · failed-payment recovery rate · refunds and disputes ·
LTV and payback by cohort · **AI cost vs. credit revenue and gross margin** overall, per plan, and per
workspace · outstanding invoices and aging.

---

# Part II — AI Credits

> **APPROVED CREDIT POLICY (D-11, D-12), 2026-09-07.** For the MVP:
>
> - **Hard stop at zero on every plan.** No postpaid overage and no surprise invoice charges.
> - **Prepaid top-ups only** — credit packs are bought before they are used.
> - Purchased packs expire after **12 months**; promotional credits after **3 months**.
> - Monthly plan credits **roll over up to one monthly allowance**.
> - Consumption is **FIFO by nearest expiry**.
> - On downgrade **no customer resource is ever deleted**; resources over the new limit become read-only
>   and are restored on re-upgrade.
>
> Allowances and per-action credit costs (`docs/PRODUCT.md` §10A.5) are **provisional and configurable**.
> They must **not** be activated as final production economics until real provider costs are measured
> against the target gross margin (D-15).
>
> **D-15 approved 2026-09-13: the target gross margin on AI usage is 65%.** A credit price is derived from
> a measured provider cost, not marked up:
>
> ```
> customer price = provider cost / (1 - target gross margin)
> ```
>
> Marking a cost up by 65% yields a margin of ≈39.4%, not 65% — the two are not the same operation and the
> error compounds across every priced task. `requiredPriceMicroMinor()` in `@brandspace/ai-gateway`
> implements the division.
>
> The 65% is an internal commercial **target**, not a hard-coded markup. It lives in
> `ai.credit-rules.targetGrossMarginPercent`, versioned like every other configuration value, and defaults
> to `null`. It is distinct from `minimumGrossMarginPercent`, the floor that triggers a warning.
>
> **Final per-action credit prices remain uncalibrated** and published package prices are unchanged. They
> will be set from real provider benchmarks once D-13 (vendor selection) and D-17 (the Arabic quality gate)
> are cleared.
>
> **IMPLEMENTED IN PHASE 3 (2026-09-07).** `reserve → confirm → settle` with `release`, credit
> buckets consumed FIFO by nearest expiry, the expiry sweep, cycle reset with the rollover cap,
> trial and promotional grants, low-balance thresholds, the abandoned-reservation sweeper, and
> reconciliation by replay. All provider-independent: nothing calls an AI provider, prices a task
> or knows what a model costs. Phase 4 drives these primitives; it does not replace them.
>
> **STILL SPECIFICATION.** Everything in Part I above — the payment provider abstraction,
> checkout, the billing portal, webhooks, invoices, dunning, proration and refunds — is Phase 7.
> Phase 3 ships `WorkspaceSubscription`, which records the plan, the pinned price, the trial and
> the cycle, and touches no payment provider at all.

## 8. Why an Internal Credit Unit

| Problem with raw provider billing              | How credits solve it                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| Customers cannot predict token usage           | A credit is a stable, understandable unit shown before every AI action |
| Provider prices change                         | Only the internal cost mapping changes; customer pricing stays stable  |
| Different providers price differently          | One unit across text, image, video, voice, and embeddings              |
| Provider switching would change customer bills | Routing changes are invisible to customers                             |
| Margin is opaque                               | Cost and charge are recorded side by side on every request             |

**Definition:** 1 credit = a configuration-defined unit of AI work. The Admin credit-cost editor maps each
task and model to a credit cost and displays the implied margin at the current provider price.

**Customer-facing communication rule:** the UI always shows the credit cost of an action **before** it runs
(e.g. "Generate 5 captions — 5 credits"), plus the remaining balance.

---

## 9. Wallet and Ledger

- One `CreditWallet` per workspace.
- `CreditTransaction` is the **immutable, append-only** ledger. Every movement is a row.
- `currentBalance` is a materialized projection updated only inside the same transaction as the ledger row,
  and fully reconstructible by replaying the ledger.
- A nightly reconciliation job replays and compares; **any drift is a critical alert**.

### 9.1 Transaction types

| Type                  | Sign              | Trigger                                       |
| --------------------- | ----------------- | --------------------------------------------- |
| `plan_grant`          | +                 | Billing-cycle reset from the plan allowance   |
| `addon_purchase`      | +                 | Credit pack purchased                         |
| `promotional_grant`   | +                 | Campaign or goodwill grant (usually expiring) |
| `admin_adjustment`    | ±                 | Manual, reason-required, audited              |
| `reservation`         | − (to reserved)   | AI request reserves an estimate               |
| `reservation_release` | + (from reserved) | Request failed or over-estimated              |
| `usage_charge`        | −                 | Confirmed successful usage                    |
| `refund`              | +                 | Reversal of a usage charge                    |
| `expiry`              | −                 | Expiring grant swept                          |
| `reset`               | ±                 | Cycle reset per rollover policy               |

---

## 10. Concurrency and Integrity

### 10.1 Reservation flow

```sql
BEGIN;
  SELECT current_balance, reserved_balance
    FROM credit_wallet
   WHERE workspace_id = $1
     FOR UPDATE;                       -- serializes all wallet mutations

  -- available = current_balance - reserved_balance
  -- if available < estimate  → ROLLBACK, return insufficient_credits

  INSERT INTO credit_transaction (..., type='reservation', idempotency_key=$k, ...);
  UPDATE credit_wallet
     SET reserved_balance = reserved_balance + $estimate,
         version = version + 1
   WHERE id = $wallet;
COMMIT;
```

### 10.2 The four integrity guarantees

| Guarantee                  | Mechanism                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **No negative balance**    | `FOR UPDATE` row lock + `CHECK (current_balance >= 0)` + reserve-before-execute                                                              |
| **No race conditions**     | All wallet mutations serialize on the wallet row; parallel requests queue behind the lock                                                    |
| **No duplicate deduction** | `unique(CreditTransaction.idempotencyKey)` and `unique(AIRequest.idempotencyKey)`; retries reuse the existing reservation                    |
| **No charge for failure**  | Terminal non-success releases the reservation in full; the ledger records `credits = 0` with the provider cost preserved for margin analysis |

### 10.3 Leak prevention

A sweeper finds reservations older than their request's timeout and releases them, then alerts.
**Reservation leaks are a monitored metric that must stay at zero.**

---

## 11. Grants, Expiry, Resets

- **Monthly plan grant** on the subscription's billing-cycle boundary — not the calendar month — so a
  customer who subscribes on the 20th resets on the 20th.
- **Rollover policy** per plan: `none` (unused expire), `capped` (roll over up to N), or `full`.
- **Expiry:** each grant may carry `expiresAt`. A daily sweep writes `expiry` transactions.
  Customers are warned 7 days before a material expiry.
- **Consumption order: FIFO by expiry** — soonest-expiring credits are consumed first, and each usage
  charge records which grant bucket it drew from.
- **Promotional grants** are bulk-issuable from Admin to a cohort with an expiry and an affected-workspace
  preview before commit.

---

## 12. Limits, Warnings, Overage

| Control                             | Behavior                                                                                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Low-balance warning                 | Configurable thresholds (default 20% and 5%): in-app + email, rate-limited to avoid nagging                                                                                        |
| Hard limit (**MVP: on every plan**) | At zero available credits, AI actions are refused with a clear message and upgrade/top-up paths. Everything non-AI keeps working                                                   |
| Overage                             | **NOT IMPLEMENTED FOR THE MVP (D-11).** No postpaid overage, no surprise invoice charges. Prepaid top-ups only. The mechanism below is retained as a possible post-launch addition |
| Per-feature limits                  | Independent of the wallet (e.g. 200 images/month) — enforced as entitlement quotas                                                                                                 |
| Per-user limits                     | Optional, so one member cannot drain a shared wallet                                                                                                                               |
| Budget alerts                       | Workspace-level daily/monthly burn alerts to the Workspace Owner                                                                                                                   |

---

## 13. Reporting

**Customer-facing:** balance, reserved, granted this cycle, consumed this cycle, burn rate, projected
exhaustion date, breakdown by feature/task, by brand, by member, and a transaction history with export.

**Platform-facing:** per workspace and in aggregate — credits consumed, credits charged in money terms,
**actual provider cost**, **estimated gross margin**, cost per credit by task and model, most expensive
workspaces, and margin outliers.

```
grossMargin(workspace, period)
  = creditRevenueAttributed(period) − providerCost(period)

creditRevenueAttributed
  = (plan revenue allocated to credits per configuration)
  + credit pack revenue recognized
  + overage revenue
```

The allocation rule (how much of a subscription price is attributed to credits vs. platform features) is
configuration, set by the owner. It is an internal reporting construct — customers never see it.

---

## 14. Edge Cases and Their Resolutions

| Case                                             | Resolution                                                                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Request succeeds but settlement fails            | Reservation stands; a reconciliation job settles from the `AIRequest` record. The customer is never double-charged, and revenue is never lost |
| Provider double-bills us                         | Detected in reconciliation; the ledger reflects our recorded usage, and the discrepancy is reported for a provider dispute                    |
| Downgrade with a larger balance than the new cap | Per plan policy: retain or expire at period end. Always shown before confirming                                                               |
| Workspace suspended with a balance               | Balance is frozen, not forfeited. It is restored on reactivation                                                                              |
| Workspace deleted with a balance                 | Credits are non-refundable by policy (stated in Terms); unused paid credit packs may be refunded at the owner's discretion                    |
| Refund of a subscription period                  | Optionally revokes credits granted for that period, per configuration                                                                         |
| Concurrent requests exceeding the balance        | Serialized on the wallet lock; the first N succeed, the rest get `insufficient_credits`                                                       |
| Provider price rises                             | Owner adjusts credit costs; existing balances keep their face value, and the margin change is visible before activation                       |
| Clock/timezone edge at cycle reset               | Resets are driven by the subscription period boundary in UTC, with the workspace timezone used only for display                               |
| BYOK customer                                    | Reduced platform fee instead of full credit cost; provider cost recorded as zero to BrandSpace; ledger flags `byok`                           |

---

## 15. Testing

| Test                | Assertion                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------ |
| Ledger replay       | Replaying all transactions reproduces `currentBalance` exactly — **implemented, Phase 3**  |
| Failure path        | Failed AI request ⇒ balance unchanged, zero `usage_charge`                                 |
| Retry               | Same idempotency key twice ⇒ exactly one charge                                            |
| Concurrency         | 50 parallel requests on a wallet sized for 10 ⇒ exactly 10 charges, balance ≥ 0            |
| Reservation leak    | Abandoned reservations are released by the sweeper — **implemented, Phase 3**              |
| FIFO expiry         | Soonest-expiring credits are consumed first — **implemented, Phase 3**                     |
| Reset               | Cycle reset applies the correct rollover policy                                            |
| Overage             | With overage off, zero balance blocks; with overage on, it charges up to the cap and stops |
| Webhook idempotency | Duplicate provider events change nothing                                                   |
| Webhook spoofing    | Invalid signature ⇒ rejected, no state change                                              |
| Proration           | Upgrade mid-cycle produces the expected charge and credit grant                            |
| Downgrade guard     | Downgrade with resources over the new limit is blocked until resolved                      |
| Isolation           | Workspace A can never read or affect B's wallet, ledger, or invoices                       |
| Immutability        | Any attempt to update or delete a ledger row or issued invoice fails at the database level |

---

## Part III — What Phase 9 Implemented

> This part records what the code actually does, so a reader comparing the specification above with
> the repository is never guessing which parts are built. Everything here is implemented, tested
> against real PostgreSQL, and walked end to end in a browser.

### 16. Money is exact, and carries its own scale

`packages/shared/src/money.ts` is the only representation of an amount in the product.

- **Integer minor units, held as `bigint`.** No floating-point value is ever the canonical form of
  money, and no `number` reaches the database (§6 of the Phase 9 brief, D-207).
- **The SCALE travels with the amount.** `1000` is `10.00` SAR and `1.000` KWD, and three of the
  seven launch currencies are three-digit. Every monetary row therefore stores `currency` AND
  `currencyScale`, because a scale re-read from the live catalogue would silently re-denominate an
  invoice issued last year the moment an owner corrected a typo.
- **`Money` refuses to combine two amounts whose currency or scale differ.** Cross-currency
  arithmetic becomes a thrown error at the line that caused it rather than a wrong total three
  screens away.
- **Nothing converts.** There is no rate anywhere in `packages/billing`. A plan with no price in the
  customer's currency is UNAVAILABLE and reports which of the two reasons applies.

### 17. The commercial geography is configuration

The `commerce` domain carries currencies (each with its own `minorUnitDigits`), markets, tax
policies, credit packs, provider routing, dunning and the invoice's legal identity. The `onboarding`
domain carries the rules of joining. **Neither holds a default country, locale, timezone or
currency** (D-194) — onboarding asks for all four, and a field here would be exactly the assumption
that decision removed.

A market may NARROW which currencies a country is offered. It never picks one.

### 18. The provider contract (D-204)

```
PaymentProviderAdapter
  capabilities()                → declared, never assumed equal
  ensureCustomer()              → the trusted workspace ↔ provider-customer mapping
  createCheckoutSession()       → hosted. There is no non-hosted alternative.
  createBillingPortalSession()
  updateSubscription() / cancelSubscription() / resumeSubscription()
  refund()                      → idempotent on the caller's key
  verifyWebhook(raw, headers)   → over the RAW bytes, before parsing
  parseWebhook(raw)             → into OUR vocabulary
```

**No method accepts a payment instrument, and none can be added without changing this contract.**
That absence is the PCI argument: hosted checkout means no card number ever reaches BrandSpace, and
the only durable way to guarantee it is to have nowhere to put one.

The only adapter shipped is the DEVELOPMENT one. It is not a stub that returns success — it issues a
signed event that must be delivered, verified and reconciled, so the honest path is the only path
that works.

### 19. Checkout: the price is ours, the confirmation is the provider's

1. A request names a plan key and an interval, or a pack key. **It carries no amount, and there is no
   field it could carry one in.**
2. The price is resolved server-side from the activated catalogue, taxed by the market's configured
   policy, and written onto our own `checkout_session` row.
3. The provider is called and returns a URL. The row is `PENDING`.
4. The customer pays on the provider's page. **Nothing in BrandSpace marks anything paid.**
5. A signed event arrives, is verified over the raw body, recorded, resolved, ordered and compared
   against the amount we wrote down. Only then is anything paid (D-205).

`commerce.checkout.trustBrowserRedirect` is typed `z.literal(false)` so this cannot be configured
away. The landing page reports reconciled state, which for a moment after a genuine payment is
legitimately "confirming your payment".

### 20. Webhook authority (D-208)

| Outcome      | When                                         | Effect                                |
| ------------ | -------------------------------------------- | ------------------------------------- |
| _(refused)_  | signature does not verify                    | **nothing is written**                |
| `PROCESSED`  | verified, resolved, in order, amount matches | applied                               |
| `DUPLICATE`  | the provider's event id was already recorded | nothing; original outcome kept        |
| `STALE`      | older than the state it describes            | recorded, not applied                 |
| `UNRESOLVED` | no trusted mapping ties it to a workspace    | recorded, visible, applied to nothing |
| `FAILED`     | amount or currency does not match our row    | CRITICAL audit; not applied           |

The inbox is **platform-owned**: an event arrives before anyone knows whose it is, and one workspace
being able to count another's payment events would be a disclosure in itself.

### 21. Invoices and credit notes

- **Numbered at ISSUE, never at creation**, from a locked counter table rather than a sequence, so a
  discarded draft burns no number and a rolled-back issue returns its own (D-209).
- **Immutable once issued.** A correction is a credit note — a second document — and the invoice's
  `creditedMinor` rises under a CHECK that refuses more than the invoice total.
- **Line descriptions are written in BOTH languages at issue time**, so a PDF in either language is
  produced from the row rather than re-derived from a catalogue that has moved on.
- **Snapshots freeze the agreed terms and the printed parties**, so a price change or a moved office
  does not rewrite a document already issued.

### 22. Dunning

Measured from the FIRST failure, never from the last attempt, so a worker that runs late or twice can
neither extend nor shorten a customer's grace period. The escalation ends at SUSPENDED: **access is
withdrawn, the data is retained, and export stays available.** The audit event says so in as many
words so it cannot be misread later as a deletion. A provider's decline message never reaches our
rows — failure codes are a closed vocabulary, and anything unrecognised becomes `payment_failed`.

### 23. Credits stay prepaid (D-196)

The bridge from a settled purchase to the ledger is **one function wide**: "grant these credits,
once, inside the transaction I am already in". Billing cannot reserve, settle, expire or read the
wallet, and there is no method that could extend credit — which is the architectural form of "no
postpaid overage". A completed pack purchase **cannot exist without naming the one grant it
produced**, enforced by a CHECK constraint, so "paid once, granted once" is a database property
rather than a worker's good intentions.

---

# Part IV — Phase 10: the invoice as a document, and the accounting export

## 24. The document model

`InvoiceDocument` is the canonical, renderer-independent shape of an issued invoice: the parties as they
were printed, the lines as they were described, the amounts at the scale they were stored. The print
page, the PDF and the accounting export all read it, so the three cannot disagree about what a customer
was charged.

**Built from the row and its snapshots, never from the live catalogue.** A price change, a moved office
or a renamed plan does not alter a document that was already issued. Descriptions were written in BOTH
languages at issue time, so either locale renders without re-deriving anything.

**The scale comes from the row (D-207).** `1000` is `10.00` SAR and `1.000` KWD, and three of the seven
launch currencies are three-digit — so re-reading the scale from the live catalogue would silently
re-denominate an invoice issued last year the moment an owner corrected a typo.

## 25. Why the bilingual document is HTML and the PDF is English only

Setting Arabic in a PDF requires two things this repository cannot decide (D-216):

1. **A licensed Arabic-capable font to embed.** Every PDF containing Arabic carries a subset of a font,
   and which font a company may embed in documents it sends to customers is a licensing decision with a
   cost. It is the owner's.
2. **A shaping engine.** Arabic is cursive and contextual — a letter takes a different glyph depending
   on its neighbours — and bidirectional text is reordered before it is drawn. Hand-rolling that is how
   invoices end up with disconnected letters in the wrong order.

So Phase 10 ships:

- **`/[locale]/billing/invoices/[id]/document`** — a standalone, print-optimised route with no
  application chrome, at A4 proportions, with its own `@page` rules. It sets **both languages and both
  directions correctly**, because every browser already has a licensed font and a shaping engine. It is
  the same markup on screen and in the PDF a customer prints, so the two cannot drift.
- **`DeterministicPdfRenderer`** — a complete, dependency-free PDF 1.7 writer using Helvetica, one of
  the fourteen fonts every reader provides. It emits a real file with a real cross-reference table, and
  a test asserts the offsets actually point at objects.
- **An explicit refusal for Arabic.** `supportedLocales` is `['en']`, and an Arabic request returns 409
  with a sentence saying where to get the Arabic version. A PDF full of empty rectangles looks like a
  document until somebody opens it, which is worse than an honest refusal.

**What the owner must decide** to change this: which Arabic font may be embedded, and whether the
production engine is a headless browser or a shaping-capable PDF library.

## 26. The accounting export

`GET /api/billing/export?from=YYYY-MM-DD&to=YYYY-MM-DD&format=csv|json`, behind `billing.read`.

**Three row kinds** — `INVOICE`, `CREDIT_NOTE` and `PAYMENT` — built from the canonical billing record.
A credit note exports as a **negative**, because that is what it does to the ledger; exporting it as a
positive and expecting the reader to infer the sign from `kind` is how a period reconciles to twice
what was actually billed.

**Every amount twice.** `totalMinor` is the exact integer the platform stores; `total` is the same value
written at the currency's own scale. A spreadsheet reads the decimal and a ledger reads the integer, and
neither has to guess whether this currency has two decimal places or three.

**No jurisdiction's tax law is encoded as universal.** There is no VAT return here and no government
envelope. What an invoice was taxed AT, under WHICH policy, and with which party tax numbers, was
recorded when it was issued; the export carries those as explicit columns — `sellerTaxId`, `buyerTaxId`,
`taxPolicyKey`, `taxRatePercent` — that a market which does not use them leaves empty. Turning them into
a particular government's form is an integration against that government's API, and belongs with that
country's decision.

**Details that matter to the reader**, each for a specific reason:

- **Every CSV field is quoted**, not only the ones that look dangerous. A legal name containing a comma
  is ordinary, and a conditional rule is one missed case from an export that shifts every column right.
- **CRLF line endings**, which RFC 4180 specifies and several accounting packages require.
- **A UTF-8 BOM**, because several spreadsheet applications open a CSV without one in the system's
  legacy encoding — turning every Arabic legal name into mojibake, on a file whose purpose is to be
  opened in one of them.
- **The tax rate as a decimal string** rather than a float. `0.15000000000000002` in an accounting
  export is the kind of thing a filing agent rejects.
- **The period is required and bounded** to 400 days. An unbounded export of a commercial record is a
  query nobody bounded.
