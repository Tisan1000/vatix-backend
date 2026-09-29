# Vatix Indexer

The indexer is the read-side archive/sync service for Vatix-Protocol. It ingests
on-chain and backend events, persists them into the archive store, and exposes
queryable state for downstream consumers (API, dashboards, analytics).

This document is the implementation summary for the indexer's archive/sync
path. It is the source of truth for how the indexer behaves and how it is
operated. See also:

- [`../../IMPLEMENTATION_SUMMARY.md`](../../IMPLEMENTATION_SUMMARY.md) — monorepo implementation summary.
- [`../../SECURITY.md`](../../SECURITY.md) — security policy and disclosure process.
- [`../../README.md`](../../README.md) — monorepo overview.
- [`../../RATE_LIMIT_POLICY.md`](../../RATE_LIMIT_POLICY.md) — rate-limit policy for external entrypoints.
- [`./src/INDEXER_CONFIG_VALIDATION_HARDENING.md`](./src/INDEXER_CONFIG_VALIDATION_HARDENING.md) — config validation hardening.

## Invariants

These invariants hold for every archive/sync operation. Any change that would
violate one of them is out of scope and must be rejected in review.

1. **Server/contract is the source of truth.** Balances, swaps, and admin state
   are authoritative on the server/contract. The indexer only mirrors that
   state; it never invents, mutates, or reconciles balances on its own.
2. **Deny-by-default authz.** Every privileged surface (admin reindex, config
   reload, backfill triggers) denies by default. Untrusted clients cannot
   bypass policy; access requires an explicit, authenticated role.
3. **Fail-closed writes on dependency outage.** If the RPC, DB, or Redis is
   unavailable, write paths fail closed. The indexer does not advance its
   checkpoint or emit partial archive writes on a degraded dependency.
4. **Idempotency for concurrent/replayed requests.** Archive/sync operations are
   idempotent. Concurrent or replayed requests (same block range, same event
   id, same correlation id) converge to the same stored state and do not
double-apply.

## Archive/sync behavior

- **Ingest.** Events are read from the configured source (RPC/backend) and
  validated against the config schema before any write.
- **Checkpointing.** The indexer advances its checkpoint only after a write is
  durably committed. On failure, the checkpoint is left unchanged so the range
  is retried.
- **Replay.** Replayed ranges are deduplicated by event id and block range;
  re-applying a committed range is a no-op.
- **Errors.** Entrypoints return stable error codes and include a correlation id
  in logs and responses so operators can trace a request end to end.

## Observability

Metrics and logs are ops-safe: they never contain secrets, private keys, or
full request bodies.

- **Metrics (money paths).** Counters and histograms for ingested events,
  checkpoint lag, write failures, and dependency errors. Money-path metrics are
  required for any change that touches balances, swaps, or settlement.
- **Logs.** Structured logs with correlation ids, stable error codes, and
  dependency status. No secrets, tokens, or credentials are logged.

## Feature flags and rollback

Any money-path or mainnet-affecting change to archive/sync must be landed behind
a feature flag or kill-switch.

- **Flag.** The change is disabled by default and enabled explicitly per
  environment.
- **Kill-switch.** Operators can disable the new path without a redeploy,
  falling back to the previous behavior.
- **Rollback.** The PR description must document the rollback procedure and the
  flag/kill-switch used. Irreversible mainnet changes require a readiness
  checklist before landing.

## Edge cases and failure modes

- Concurrent/replayed requests — handled by idempotency (see Invariants).
- Dependency outage (RPC/DB/Redis) — writes fail closed; checkpoint unchanged.
- Auth expiry / wrong role — request is denied; no state change.
- Adversarial input and griefing — input is validated and rate-limited per
  [`../../RATE_LIMIT_POLICY.md`](../../RATE_LIMIT_POLICY.md).
- Testnet vs mainnet / address drift — configuration is validated per network;
  see [`./src/INDEXER_CONFIG_VALIDATION_HARDENING.md`](./src/INDEXER_CONFIG_VALIDATION_HARDENING.md).

## Contributing (Stellar Wave)

- Read the invariants above before changing archive/sync behavior.
- Keep changes surgical and scoped to the issue.
- Add unit tests for invariants and auth negatives, and integration/e2e
  coverage on the critical path.
- Update this document and cross-links when behavior changes.
