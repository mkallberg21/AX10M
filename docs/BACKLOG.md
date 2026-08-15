# AX10M — Backlog

Out-of-scope-but-worth-doing items, captured here instead of derailing the current
phase (per the build-plan rule "no scope creep"). Not prioritized; the phased plan
drives sequencing.

## Deferred from the phased plan / prior sessions
- **Local Temporal harness.** A docker-compose Temporal dev server + a worker entrypoint
  that registers the recovery activities + a smoke test running `recoverySequenceWorkflow`
  against a fake adapter (no processor creds needed), to give the Temporal binding real
  runtime coverage. Explicitly requested but deferred: it does not answer the core
  question (does the engine beat the baseline), which is Phase 1's job.
- **Multi-method resolution at execution time.** ARSE plans credential rotation
  (`RetryStep.methodRef`), but `executeRecovery` still charges the case's primary method.
  Wire the alternate-credential selection through the charge path.

## Hygiene / correctness
- **`@ax10m/canonical` has no tests**, which breaks `pnpm -r test`. Add a trivial test
  (e.g. `isRetriable`/`familyOf` coverage) or set `passWithNoTests` so the recursive
  runner doesn't halt.
- **Stale factual claims in `README.md` and `docs/STRATEGY.md`.** Both predate this
  session's work: README's coverage table (Stripe listed as skeleton), the "~113 unit
  tests" figure, the monorepo layout (missing `scheduler`, `protocol`), and STRATEGY §5
  ("the Stripe adapter is the skeleton") are now false. The **honest-status blocks stay**
  (the engine is still unproven vs the incumbent); only the stale implementation facts
  need refreshing. Partially addressed in Phase 0; finish as docs settle.

## Holdout economics (from STRATEGY §2, roadmap)
- `holdoutLossCredit` in the billing worksheet — credit the control arm's forgone
  recovery against the fee during the certification window.
- "Estimated holdout cost" line on the Uplift Statement.
- Certification-window → thin-audit-holdout taper as an enforced policy.

## Depth (later)
- Cross-merchant issuer/BIN model beyond the per-BIN Beta-shrunk prior.
- Retention-value (LTV) billing mode alongside recovered-dollars.
- Licensed BIN→region database to replace the illustrative seed table.
