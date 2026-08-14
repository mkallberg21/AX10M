# AX10M Protocol (AXP) v0.1

AXP is a small, versioned message vocabulary that lets **processors, merchants-of-record,
billing platforms, and merchants speak "payment uplift" the same way**. It is what turns
AX10M from a product into infrastructure: a common contract for normalizing declines,
negotiating retry sequences, and reporting auditable incremental lift.

The types are defined in `@ax10m/protocol` (dependency-light, side-effect-free). Every
message is a typed, versioned `AxpEnvelope`:

```ts
interface AxpEnvelope<K, P> { axp: K; version: string; id: string; issuedAt: string; payload: P }
```

> **Status.** v0.1 is a **draft** contract shipped as typed schemas + validators, exercised
> by the AX10M engine/API packages. It is not yet an inter-company ratified standard — the
> value today is one internal vocabulary every layer already produces/consumes; publishing it
> for external counterparties is the roadmap.

## Messages

### AXP-01 — Decline-code normalization
Maps a processor's native decline dialect into the one canonical taxonomy
(`@ax10m/canonical` `DeclineCode`) plus its classification. The canonical taxonomy is the
global cross-processor decline map; each adapter's decline-map is one AXP-01 producer.
Payload: `{ processor, rawCode, canonicalCode, family, retriable, recommendedAction }`.

### AXP-02 — Retry-sequence negotiation
Proposes an ARSE-planned retry schedule for a case and receives an ack. Lets a processor
or MoR trim/reschedule steps it won't honor before execution.
Proposal: `{ caseId, merchantId, network?, steps[] }` → Ack: `{ caseId, accepted, acceptedSteps?, reason? }`.

### AXP-03 — Uplift event reporting
The billing-grade artifact: a **holdout-verified lower-bound** incremental recovered amount
for a period, the 12% fee derived from it, the attribution ledger head it was computed from,
and a detached signature for CFO-verifiable audit.
Payload: `{ merchantId, period, incrementalRecoveredMinor, currency, confidence, feeMinor, ledgerHead, signature? }`.

### AXP-04 — Processor routing handshake
Advertises a processor's integration mode + capability matrix + supported protocol versions,
so the router knows whether it can drive, co-drive, or only observe.

### AXP-05 — MoR integration handshake
Declares who owns the token and the dunning loop, whether AX10M is measurement-only, and the
comms channels AX10M may act on. This is how AX10M integrates with Paddle-style MoRs honestly.

### AXP-06 — Merchant onboarding handshake
Binds a merchant to a processor connection (the per-merchant webhook `connectionId`) and a
mode (`shadow` = measure only, Phase 0; `active` = drive recovery, Phase 1).

## Versioning
`AXP_VERSION` is semver. Counterparties advertise `supportedVersions` in AXP-04; envelopes carry
the version they were produced under. Payload fields are added backward-compatibly; a breaking
change bumps the major and is negotiated via the handshakes.
