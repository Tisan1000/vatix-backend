# API Module

## Purpose

Houses all HTTP-facing logic (controllers, routes, middleware).

## Scope

- Request/response handling
- Input validation
- Routing layer only

## Ownership

Backend/API team

## Notes

No business logic should live here; delegate to services.

## OpenAPI / route inventory

This is the authoritative inventory of the `vatix-backend` HTTP surface under `apps/api`.
It is the source of truth for method, path, authz requirement, request/response shape, and
stable error codes. Any new route MUST be added here in the same PR that introduces it.

Authz is **deny-by-default**: every entrypoint is authenticated and authorized before any
handler logic runs. New privileged surfaces are denied until an explicit policy is added.
See [`SECURITY.md`](../../SECURITY.md) for the security model and threat assumptions.

### Stable error codes

| Code | HTTP | Meaning |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | Missing/expired credentials |
| `FORBIDDEN` | 403 | Authenticated but wrong role |
| `VALIDATION_ERROR` | 400 | Malformed/invalid payload |
| `IDEMPOTENCY_CONFLICT` | 409 | Replayed key with different payload |
| `DEPENDENCY_UNAVAILABLE` | 503 | RPC/DB/Redis unavailable (writes fail closed) |
| `RATE_LIMITED` | 429 | Entrypoint rate limit exceeded |

Every response carries a correlation id (echoed from `x-correlation-id` or generated) for tracing.

### Route table

| Method | Path | Authz | Request | Response | Errors |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/health` | public | — | `{ status, version }` | `DEPENDENCY_UNAVAILABLE` |
| `GET` | `/orders` | session (any role) | query: `status?`, `cursor?`, `limit?` | `{ orders: Order[], nextCursor? }` | `UNAUTHENTICATED`, `VALIDATION_ERROR`, `RATE_LIMITED` |
| `GET` | `/orders/:id` | session (owner or admin) | path: `id` | `Order` | `UNAUTHENTICATED`, `FORBIDDEN`, `VALIDATION_ERROR` |
| `POST` | `/orders` | session + `trader` role | body: `OrderDraft`, header: `Idempotency-Key` | `Order` | `UNAUTHENTICATED`, `FORBIDDEN`, `VALIDATION_ERROR`, `IDEMPOTENCY_CONFLICT`, `DEPENDENCY_UNAVAILABLE`, `RATE_LIMITED` |
| `POST` | `/orders/:id/cancel` | session + `trader` role (owner or admin) | path: `id`, header: `Idempotency-Key` | `Order` | `UNAUTHENTICATED`, `FORBIDDEN`, `VALIDATION_ERROR`, `IDEMPOTENCY_CONFLICT`, `DEPENDENCY_UNAVAILABLE` |
| `POST` | `/orders/:id/amend` | session + `trader` role (owner or admin) | path: `id`, body: `OrderAmend`, header: `Idempotency-Key` | `Order` | `UNAUTHENTICATED`, `FORBIDDEN`, `VALIDATION_ERROR`, `IDEMPOTENCY_CONFLICT`, `DEPENDENCY_UNAVAILABLE` |
| `GET` | `/admin/orders` | session + `admin` role | query: `cursor?`, `limit?` | `{ orders: Order[], nextCursor? }` | `UNAUTHENTICATED`, `FORBIDDEN`, `RATE_LIMITED` |

Money-path endpoints (`POST /orders`, `POST /orders/:id/cancel`, `POST /orders/:id/amend`) are
fail-closed: when a dependency (RPC/DB/Redis) is unavailable they reject with
`DEPENDENCY_UNAVAILABLE` rather than partially applying. Reads may degrade.

## Orders API (`apps/api/routes/orders.ts`)

### Authz (deny-by-default)

Every orders entrypoint is authenticated and authorized before any handler logic runs.
Untrusted clients cannot bypass policy:

- All routes require a valid session/JWT; missing or expired credentials fail closed with `401 UNAUTHENTICATED`.
- Privileged surfaces (create/cancel/amend, admin actions) require the correct role; wrong role fails closed with `403 FORBIDDEN`.
- New privileged surfaces default to denied until an explicit policy is added.

### Validation & error codes

Requests and responses are typed and validated at the boundary. Stable error codes are listed
in the [route inventory](#stable-error-codes) above.

Every response carries a correlation id (echoed from `x-correlation-id` or generated) for tracing.

### Idempotency

Order write paths require an idempotency key. Concurrent/replayed requests with the same key
return the original result; a replay with a different payload returns `IDEMPOTENCY_CONFLICT`.

### Fail-closed writes

When a dependency (RPC/DB/Redis) is unavailable, writes are rejected with
`DEPENDENCY_UNAVAILABLE` rather than partially applied. Reads may degrade, but money-path
writes never proceed on an unverified dependency.

### Observability

Metrics and logs cover the money path (order create/cancel/amend, authz denials, idempotency
hits/conflicts, dependency failures). Logs never include secrets, tokens, or full credentials.

### Rollback / kill-switch

Money-path or mainnet-affecting changes land behind a feature flag with a documented kill-switch
and rollback steps in the PR description.

### Testnet vs mainnet

Addresses and network config are resolved per environment; testnet/mainnet drift is guarded and
never hard-coded in the orders path.
