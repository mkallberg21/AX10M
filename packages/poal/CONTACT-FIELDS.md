# Dunning contact-field validation

Where each adapter sources the customer **email / phone** it attaches to `invoice.failed`
(for the dunning email/SMS channels), and the **validation status** of each field against the
processor's official API/webhook documentation.

Validated against public docs on **2026-08-15**. Phone values run through `toE164()`
(`packages/poal/src/customer.ts`), which normalizes `+`/`00`-prefixed numbers and **drops
national-only numbers** that aren't safely dialable. "Validated against docs" means the field
name/path was confirmed in the official reference — **not** a live authenticated sandbox call
(those need per-processor credentials the operator holds).

| Processor | Source | Email field | Phone field | Status |
|---|---|---|---|---|
| **Stripe** | webhook | `invoice.customer_email`; charge `billing_details.email` / `receipt_email` | `invoice.customer_phone`; charge `billing_details.phone` | ✅ Confirmed |
| **Adyen** | webhook | `additionalData.shopperEmail` | `additionalData.shopperTelephone` | ✅ Confirmed — **config-gated**: only present when "Include Shopper Details" is enabled in Customer Area (treated as optional) |
| **Checkout.com** | webhook | `customer.email` | `customer.phone.{country_code,number}` (assembled) | ✅ Confirmed — present only when supplied on the payment (optional) |
| **Braintree** | webhook XML | `<customer><email>` | `<customer><international-phone>` (`country-code`+`national-number`) → E.164; flat `<phone>` fallback | ⚠️ Adjusted — flat `phone` is **deprecated**, now prefer `international-phone`. Webhook XML element names still `CONFIRM` against a live payload |
| **PayPal** | webhook | `payer.email_address` | — (payer phone is `national_number` only) | ⚠️ Adjusted — payer phone has **no country code** per the Orders payer schema, so it can't be E.164 → **email-only** |
| **Recurly** | webhook XML | `<account><email>` | — | ✅ Confirmed — the push-notification account block carries **no phone** (email-only is correct) |
| **Maxio/Chargify** | webhook | `customer.email` | `customer.phone` | ✅ Confirmed |
| **Chargebee** | webhook | `content.customer.email` | `content.customer.phone` | ✅ Confirmed field names; `content.customer` **presence** on `payment_failed` unverified → null-guarded (degrades to no-contact) |
| **WooCommerce** | webhook | `billing.email` | `billing.phone` | ✅ Confirmed |
| **Shopify** | API (GraphQL) | `subscriptionContract.customer.defaultEmailAddress.emailAddress` | `…defaultPhoneNumber.phoneNumber` | ⚠️ Adjusted — flat `Customer.email`/`phone` are **deprecated**, migrated to the `default*` accessors |
| **GoCardless** | API (`GET /customers/:id`) | `email` | — | ✅ Confirmed — the Customer resource has **no phone field** (email-only is correct) |
| **Zuora** | API (`GET /v1/accounts/:id`) | `billToContact.workEmail` ?? `personalEmail` | `billToContact.workPhone` ?? `mobilePhone` ?? `homePhone` | ✅ Confirmed |
| **Worldpay** | — | — | — | ❌ Not possible — see below |

## Corrections made during validation

- **Worldpay** — **removed** the contact enrichment. The retrieval API is
  `GET /paymentQueries/payments/{id}` (not `GET /payments/{id}`), and its response contains **no
  shopper contact**: `shopperEmailAddress` is a *write-only* auth-request input that Access
  Worldpay never echoes back. Recovering contact would require persisting it at authorization
  time, which this recovery overlay doesn't do. Worldpay therefore attaches **no contact**.
- **Shopify** — migrated the GraphQL query from the deprecated `Customer.email`/`phone` to
  `defaultEmailAddress { emailAddress }` / `defaultPhoneNumber { phoneNumber }`.
- **PayPal** — the payer phone carries only `national_number` (no country code), so it can't be
  assembled into E.164 and is dropped; PayPal is **email-only** in practice.
- **Braintree** — prefer the structured `international-phone` (→ E.164) over the deprecated flat
  `phone`.

## Remaining `CONFIRM` items (need a live sandbox / real payload, not just docs)

- **Braintree**: the exact **webhook XML** element names (`<customer>`, `<international-phone>`)
  — verified against the transaction *object* reference; a captured webhook payload would confirm
  the XML representation.
- **Chargebee**: whether `content.customer` is **always** present on `payment_failed` (vs. only
  `content.invoice`/`content.subscription` with a `customer_id` to resolve).
- **Adyen / Checkout.com**: contact fields are **optional/config-gated**; a live event confirms
  they're populated for the account in question.

Everything above is **fail-safe**: a missing/renamed field or a failed API lookup yields no
contact, never a dropped recovery event.

## Live-sandbox harness (closing the remaining `CONFIRM`s)

Docs can't settle the last items (real webhook XML, optional-field population, whether a lookup
returns contact for a given account). The harness `scripts/validate-contact-fields.mjs` does —
against your own sandbox. It builds the **real adapter** from your sandbox credentials, replays a
webhook **you captured**, and reports the contact that resolved (values **masked**, no PII in the
output). For the API-lookup adapters (shopify / gocardless / zuora) the replay also triggers the
live enrichment GET, so it validates that path too. It's read-only — it verifies signatures and
does enrichment GETs; it never charges and commits nothing.

```bash
corepack pnpm --filter @ax10m/poal build   # once
# per processor <P> (stripe, gocardless, zuora, …), point at YOUR sandbox creds + a captured webhook:
AX10M_VAL_STRIPE_CONFIG_FILE=./stripe.creds.json \
AX10M_VAL_STRIPE_BODY_FILE=./stripe.webhook.json \
AX10M_VAL_STRIPE_HEADERS_FILE=./stripe.headers.json \
node packages/poal/scripts/validate-contact-fields.mjs   # --help for the full env contract
```

`<P>_CONFIG` is the `buildAdapter` credentials bag (keys/secrets + the sandbox `baseUrl`);
`<P>_BODY` is the captured raw webhook; `<P>_HEADERS` is its headers JSON (including the signature
header, so verification passes). All values come from the environment — nothing is committed, and
no credential is ever printed. The harness's parsing/report logic is unit-tested in CI
(`validate-contact.test.ts`); the credentialed run is the operator's step.
