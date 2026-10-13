# Email deliverability for brandspace.cc (PR F (d), Q10)

**Sending domain:** `brandspace.cc`. **From:** `noreply@brandspace.cc`, display name **Brandspace**
(`integrations.email` in [`integrations-email.json`](./integrations-email.json)).

Resend sends from a **`send` subdomain** of the domain you add, so the root domain's own mail (if
any) is untouched, and the sending reputation stays on `send.brandspace.cc`. Every record below is
added at the DNS provider that is authoritative for `brandspace.cc` (check with
`dig NS brandspace.cc +short`; if DNS is split across providers, edit the one that answers).

## 1. Add the domain in Resend

1. Resend → **Domains** → **Add domain** → `brandspace.cc`.
2. **Region:** choose once; every MX record must point to the same region, and it cannot be changed
   later without re-adding the domain. The choices Resend offers are `us-east-1`, `eu-west-1`,
   `sa-east-1` and `ap-northeast-1`. **Recommended: `eu-west-1`** (Ireland): it is closest to the
   staging region (Amsterdam) and the expected customers. This is the owner's decision; the record
   values below use `<region>`.
3. Resend then shows the records with their exact values. Copy the **DKIM** value from that page:
   it is generated per domain and cannot be written here in advance.

## 2. The records

| Purpose                        | Type | Name (host)         | Value                                                 | Priority |
| ------------------------------ | ---- | ------------------- | ----------------------------------------------------- | -------- |
| SPF (bounce path)              | TXT  | `send`              | `v=spf1 include:amazonses.com ~all`                   | —        |
| Feedback (bounces, complaints) | MX   | `send`              | `feedback-smtp.<region>.amazonses.com`                | `10`     |
| DKIM (signature)               | TXT  | `resend._domainkey` | the `p=…` value copied from Resend's domain page      | —        |
| DMARC (policy)                 | TXT  | `_dmarc`            | `v=DMARC1; p=none; rua=mailto:<DMARC report address>` | —        |

Notes:

- **Name** is the host part only. Some providers want the full name (`send.brandspace.cc`); a few
  append the domain automatically, so `send.brandspace.cc` would become
  `send.brandspace.cc.brandspace.cc`. If the provider appends, enter only `send`.
- If the provider appends the domain to **values**, end the MX value with a dot:
  `feedback-smtp.<region>.amazonses.com.`
- **DMARC starts at `p=none`**: it only reports. After two to four weeks of clean reports (every
  message from Resend passes SPF or DKIM alignment, nothing unknown sends as `brandspace.cc`), move
  to `p=quarantine`, and later `p=reject`. The `rua` address receives daily aggregate reports;
  use a mailbox you read (a placeholder until the owner names one).
- If `brandspace.cc` already has an SPF record on the **root**, leave it: Resend's SPF lives on
  `send`, so the two never conflict.

## 3. Reading each record's state in Resend

Resend → **Domains** → `brandspace.cc` shows each record with its own status:

- **Pending / Not started** — Resend has not seen the record yet. DNS can take minutes to hours;
  press **Verify** again later.
- **Verified** — the record is published with the expected value.
- **Failed** — Resend looked for 72 hours and the value never matched. Compare the published value
  (`dig TXT resend._domainkey.brandspace.cc +short`, `dig TXT send.brandspace.cc +short`,
  `dig MX send.brandspace.cc +short`) with the value on the page character by character, fix it,
  and press **Verify**.

The domain is ready when **DKIM, SPF and MX are all Verified**. Only then put the Resend API key in
the Control Center (see [`README.md`](./README.md) §3) and activate `integrations.email`.

## 4. Test

1. From the Control Center readiness page, send the test message (or sign up a test account on
   production) to:
   - a **Gmail** address: open the message → ⋮ → **Show original**. Expect `SPF: PASS`,
     `DKIM: PASS` (signed by `brandspace.cc`) and `DMARC: PASS`; the message is in the Inbox, not
     Spam, and the sender reads "Brandspace <noreply@brandspace.cc>".
   - a **company mailbox** (Microsoft 365 or Google Workspace): open the message headers; expect
     `Authentication-Results: … spf=pass … dkim=pass … dmarc=pass`.
2. If DMARC fails while SPF and DKIM pass, the From domain does not match the signing domain:
   check that `integrations.email.fromEmail` is `noreply@brandspace.cc` exactly.
