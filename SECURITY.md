# Security Policy

## Reporting a Vulnerability

Please do not report security vulnerabilities through public GitHub issues.
Instead, report them responsibly by contacting security@vatix.io.

## Privileged Surfaces & Authz Policy

- **Deny-by-default**: Every external entrypoint requires an authenticated
  principal unless explicitly marked as a probe. Unauthenticated requests
  to data or money-path routes fail closed with `401 UNAUTHORIZED`.
- **Route inventory**: The authoritative OpenAPI/route inventory for the
  `vatix-backend` API surface (method, path, authz requirement, request/
  response shape, and stable error codes) lives in
  [`apps/api/README.md`](apps/api/README.md). Every route is listed there;
  routes absent from the inventory are denied by default and must not be
  exposed. See [`apps/api/README.md`](apps/api/README.md).
- **Provider allowlist**: Price feeds are deny-by-default when configured —
  `ORACLE_PRICE_PROVIDER_ALLOWLIST` admits only named providers, enforced at
  construction and before every fetch (`PRICE_PROVIDER_NOT_ALLOWED`, 403).
  See [`docs/price-provider-allowlist.md`](docs/price-provider-allowlist.md).
- **Oracle credentials**: Oracle signing keys and provider API credentials are
  loaded only from the environment (or a mounted secret store) and are never
  committed, logged, or returned by any endpoint. Configuration is validated
  fail-closed at startup: a missing, malformed, or placeholder credential
  aborts boot with `ORACLE_CREDENTIAL_INVALID` rather than starting in a
  degraded state. Credentials are redacted in structured logs and error
  payloads, and privileged credential surfaces are deny-by-default. See
  [`apps/oracle/oracle-config.ts`](apps/oracle/oracle-config.ts).
- **Poison quarantine**: Submission-queue items that keep failing are
  quarantined after a bounded number of attempts and can never be replayed
  back into the money path (`SUBMISSION_QUEUE_POISON`, non-retryable); queue
  capacity is bounded (`SUBMISSION_QUEUE_FULL`). See
  [`docs/submission-queue-poison-handling.md`](docs/submission-queue-poison-handling.md).
- **Write-path input guards**: Indexer batch writes are capped before any
  database work (`BATCH_WRITE_TOO_LARGE` / `BATCH_WRITE_INVALID_INPUT`) and
  gap back-fill is single-flight, bounded, and kill-switchable
  (`INDEXER_GAP_BACKFILL_ENABLED`). See
  [`docs/indexer-batch-writer-limits.md`](docs/indexer-batch-writer-limits.md)
  and [`docs/indexer-gap-backfill.md`](docs/indexer-gap-backfill.md).
- **Rate limiting**: Every external route is governed by an explicit policy in
  `RATE_LIMIT_POLICIES` (see `RATE_LIMIT_POLICY.md`). Routes without a policy
  are denied by default.
- **Probe safety**: Probe endpoints (`/health`, `/ready`) never return
  connection strings, credentials, hostnames, or internal addresses.
- **Fail-closed dependencies**: If a critical dependency (database, Redis,
  RPC) is unreachable, probes return `503 DEPENDENCY_UNAVAILABLE` and money
  paths reject writes immediately rather than serving stale or degraded state.
- **Feature flags**: Money-path or mainnet-affecting changes must be gated
  behind a feature flag or kill-switch so they can be turned off without a
  redeploy.
- **Secret hygiene**: No secrets, passwords, or connection strings may be
  checked into the repository or emitted in structured logs.

## Implementation Summary (archive/sync)

The authoritative description of the archive/sync implementation — its
invariants, entrypoints, error codes, and observability — lives in
[`IMPLEMENTATION_SUMMARY.md`](IMPLEMENTATION_SUMMARY.md). That document is the
source of truth for how the indexer archives and syncs chain state; this
section records the security invariants that summary must uphold.

### Invariants

- **Server/contract is the source of truth**: Balances, swaps, and admin
  state are authoritative on the server/contract. The indexer archive and
  sync paths are derived views only and must never be treated as the
  authority for money-path decisions.
- **Deny-by-default authz**: Every archive/sync entrypoint requires an
  authenticated principal with the correct role; unauthenticated or
  wrong-role requests fail closed (`401 UNAUTHORIZED` / `403 FORBIDDEN`).
- **Fail-closed writes**: If a critical dependency (database, Redis, RPC) is
  unreachable, archive/sync writes are rejected immediately rather than
  partially applied or served from stale state.
- **Idempotency**: Concurrent or replayed archive/sync requests are
  idempotent — replays must not double-apply state, and duplicate work is
  deduplicated by a stable correlation id.

### Observability

- Archive/sync money paths emit metrics and structured logs with a stable
  correlation id so operators can trace a request end to end.
- Logs and metrics never include secrets, credentials, connection strings,
  or raw provider payloads; identifiers are redacted or hashed.

### Feature flags & rollback

- Archive/sync changes that affect the money path or mainnet are gated behind
  a feature flag or kill-switch (e.g. `INDEXER_GAP_BACKFILL_ENABLED`) so they
  can be disabled without a redeploy.
- Every such change documents its rollback strategy in the PR description;
  disabling the flag restores the prior, known-good behavior.

### Related docs

- [`IMPLEMENTATION_SUMMARY.md`](IMPLEMENTATION_SUMMARY.md) — archive/sync
  implementation summary (source of truth).
- [`RATE_LIMIT_POLICY.md`](RATE_LIMIT_POLICY.md) — per-route rate-limit
  policies.
- [`apps/indexer/README.md`](apps/indexer/README.md) — indexer overview and
  runbook entrypoints.
- [`apps/indexer/src/INDEXER_CONFIG_VALIDATION_HARDENING.md`](apps/indexer/src/INDEXER_CONFIG_VALIDATION_HARDENING.md)
  — indexer config validation hardening.
