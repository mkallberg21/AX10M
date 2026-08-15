# Contributing to AX10M

## Prerequisites
- Node ≥ 20 (tested on 24.x)
- pnpm ≥ 9, invoked via **`corepack pnpm`** (on Windows, `corepack enable` often can't
  write shims into Program Files — calling through corepack avoids that).

## Verification suite

Run these before reporting any work complete. All must pass.

```bash
# 1. Install the whole workspace
corepack pnpm install

# 2. Build every package + app in dependency order (tsc -b also typechecks)
corepack pnpm -r build

# 3. Typecheck (explicit --noEmit pass)
corepack pnpm -r run typecheck

# 4. Tests — run the explicit filter list. Do NOT use `pnpm -r test`:
#    @ax10m/canonical has no test files, so vitest exits 1 and halts the recursive run.
corepack pnpm --filter @ax10m/attribution --filter @ax10m/guardrail \
  --filter @ax10m/onboarding --filter @ax10m/poal --filter @ax10m/recovery-engine \
  --filter @ax10m/scheduler --filter @ax10m/protocol --filter @ax10m/api test
```

A single package: `corepack pnpm --filter @ax10m/<name> test` (or `build`, `typecheck`).

Dev servers: `corepack pnpm --filter @ax10m/api dev` (:4000) ·
`corepack pnpm --filter @ax10m/dashboard dev` (:3000).

## Ground rules (see the README "Design invariants" — do not break them)
- **Never store or transmit a PAN.** Tokens / mandates only (SAQ-A).
- **Exactly-once charging** via deterministic idempotency keys.
- **Guardrail before execution** — the policy proposes, the guardrail disposes.
- **Bill the lower bound**; a projection is never a bill (`holdoutVerified: false` until live).
- **No real secrets in the repo, ever.** `.env.example` holds placeholders only; secret-scan
  before every push.

## Working style
- Match the surrounding code: injectable `fetch` transports, fake-transport unit tests,
  canonical decline mapping, comment density of the existing adapters.
- Commit in logical units with clear messages; never force-push shared history.
- If a result is negative or inconclusive, **report it plainly** — that is a success, not a
  failure to hide.
- Out-of-scope ideas go in [`docs/BACKLOG.md`](docs/BACKLOG.md), not into the current change.
