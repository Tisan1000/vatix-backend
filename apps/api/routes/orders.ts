import type { FastifyInstance, FastifyRequest } from "fastify";
import { getPrismaClient } from "../../../src/services/prisma.js";
import type { Prisma, OrderStatus } from "../../../src/generated/prisma/client";

interface GetOrdersQuery {
  status?: string;
  page?: number;
  limit?: number;
}

interface GetOrderParams {
  id: string;
}

interface CreateOrderBody {
  marketId: string;
  side: "BUY" | "SELL";
  type: "LIMIT" | "MARKET";
  price?: string;
  amount: string;
  idempotencyKey?: string;
}

interface CancelOrderParams {
  id: string;
}

interface CancelOrderBody {
  idempotencyKey?: string;
}

const ORDER_STATUSES = ["OPEN", "FILLED", "CANCELLED", "PARTIALLY_FILLED"] as const;

// Stable error codes for the orders API surface.
const ERR = {
  UNAUTHORIZED: "ORDERS_UNAUTHORIZED",
  FORBIDDEN: "ORDERS_FORBIDDEN",
  NOT_FOUND: "ORDERS_NOT_FOUND",
  VALIDATION: "ORDERS_VALIDATION_FAILED",
  CONFLICT: "ORDERS_IDEMPOTENCY_CONFLICT",
  UNAVAILABLE: "ORDERS_DEPENDENCY_UNAVAILABLE",
} as const;

/**
 * OpenAPI/route inventory for the orders surface (issue #1181).
 *
 * This is the machine-readable source of truth for the routes registered by
 * `ordersRoutes`. It documents method, path, authz requirement, request and
 * response shapes, and the stable error codes each route can emit. Authz is
 * deny-by-default: any route not marked `public` requires an authenticated
 * principal, and privileged/money-path writes additionally require an allowed
 * role. Writes fail closed when a dependency is unavailable.
 *
 * Cross-links: apps/api/README.md (route inventory section) and SECURITY.md
 * (authz + fail-closed policy).
 */
export interface RouteInventoryEntry {
  method: "GET" | "POST" | "DELETE";
  path: string;
  /** Deny-by-default: `public` routes are explicitly enumerated. */
  authz: "public" | "authenticated" | "role:TRADER|ADMIN";
  /** Money-path / privileged writes must fail closed on dependency outage. */
  failClosed: boolean;
  request: { params?: string[]; query?: string[]; body?: string[] };
  response: string;
  errorCodes: string[];
}

export const ORDERS_ROUTE_INVENTORY: RouteInventoryEntry[] = [
  {
    method: "GET",
    path: "/orders",
    authz: "public",
    failClosed: false,
    request: { query: ["status", "page", "limit"] },
    response: "{ orders, total, hasNext, page, limit, correlationId }",
    errorCodes: [ERR.UNAVAILABLE],
  },
  {
    method: "GET",
    path: "/orders/:id",
    authz: "public",
    failClosed: false,
    request: { params: ["id"] },
    response: "{ order, correlationId }",
    errorCodes: [ERR.NOT_FOUND, ERR.UNAVAILABLE],
  },
  {
    method: "POST",
    path: "/orders",
    authz: "role:TRADER|ADMIN",
    failClosed: true,
    request: {
      body: ["marketId", "side", "type", "price", "amount", "idempotencyKey"],
    },
    response: "{ order, correlationId }",
    errorCodes: [
      ERR.UNAUTHORIZED,
      ERR.FORBIDDEN,
      ERR.VALIDATION,
      ERR.CONFLICT,
      ERR.UNAVAILABLE,
    ],
  },
  {
    method: "DELETE",
    path: "/orders/:id",
    authz: "role:TRADER|ADMIN",
    failClosed: true,
    request: { params: ["id"], body: ["idempotencyKey"] },
    response: "{ order, correlationId }",
    errorCodes: [
      ERR.UNAUTHORIZED,
      ERR.FORBIDDEN,
      ERR.NOT_FOUND,
      ERR.CONFLICT,
      ERR.UNAVAILABLE,
    ],
  },
];

function correlationId(request: FastifyRequest): string {
  const header = request.headers["x-correlation-id"];
  if (typeof header === "string" && header.length > 0 && header.length <= 128) {
    return header;
  }
  return request.id;
}

function fail(
  reply: any,
  status: number,
  code: string,
  message: string,
  correlation: string
) {
  return reply.status(status).send({ error: { code, message, correlationId: correlation } });
}

// Deny-by-default authz: privileged order writes require an authenticated
// principal with an allowed role. Untrusted clients cannot bypass policy.
function authorizeWrite(request: FastifyRequest): { ok: true; actor: string } | { ok: false; status: number; code: string; message: string } {
  const user = (request as any).user;
  if (!user || typeof user.id !== "string" || user.id.length === 0) {
    return { ok: false, status: 401, code: ERR.UNAUTHORIZED, message: "Authentication required" };
  }
  const role = user.role;
  if (role !== "TRADER" && role !== "ADMIN") {
    return { ok: false, status: 403, code: ERR.FORBIDDEN, message: "Insufficient role for order writes" };
  }
  return { ok: true, actor: user.id };
}

// Fail-closed: writes must not proceed when a dependency is unavailable.
async function dependencyHealthy(prisma: ReturnType<typeof getPrismaClient>): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

/**
 * RATE_LIMIT_POLICY.md: external read entrypoints are rate limited per client
 * identity (authenticated subject when present, otherwise source IP). Limits
 * are enforced fail-closed: if the limiter backend is unavailable the request
 * is rejected rather than allowed through.
 */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 120;

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const rateLimitBuckets = new Map<string, RateLimitBucket>();

function clientIdentity(request: FastifyRequest): string {
  const subject = (request as FastifyRequest & { user?: { sub?: string } }).user
    ?.sub;
  if (typeof subject === "string" && subject.length > 0) {
    return `sub:${subject}`;
  }
  return `ip:${request.ip}`;
}

function enforceRateLimit(request: FastifyRequest, reply: { status: (code: number) => { send: (body: unknown) => unknown } }): boolean {
  const now = Date.now();
  const key = clientIdentity(request);
  const bucket = rateLimitBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (bucket.count >= RATE_LIMIT_MAX_REQUESTS) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    reply
      .status(429)
      .send({
        error: "RATE_LIMIT_EXCEEDED",
        message: "Too many requests",
        correlationId: request.id,
        retryAfter,
      });
    return false;
  }

  bucket.count += 1;
  return true;
}

export async function ordersRoutes(fastify: FastifyInstance) {
  const prisma = getPrismaClient();

  fastify.get<{ Querystring: GetOrdersQuery }>(
    "/orders",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: [...ORDER_STATUSES],
            },
            page: { type: "integer", minimum: 1 },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: GetOrdersQuery }>, reply) => {
      if (!enforceRateLimit(request, reply)) {
        return;
      }

      const correlation = correlationId(request);

      const { status, page = 1, limit = 20 } = request.query;
      const where: Prisma.OrderWhereInput = status
        ? { status: status as OrderStatus }
        : {};
      const skip = (page - 1) * limit;

      try {
        const [orders, total] = await Promise.all([
          prisma.order.findMany({
            where,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip,
            take: limit,
          }),
          prisma.order.count({ where }),
        ]);

        reply.status(200).send({
          orders,
          total,
          hasNext: skip + orders.length < total,
          page,
          limit,
          correlationId: correlation,
        });
      } catch {
        return fail(reply, 503, ERR.UNAVAILABLE, "Orders store unavailable", correlation);
      }
    }
  );

  fastify.get<{ Params: GetOrderParams }>(
    "/orders/:id",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: GetOrderParams }>, reply) => {
      const correlation = correlationId(request);
      if (!enforceRateLimit(request, reply)) {
        return;
      }

      const { id } = request.params;

      try {
        const order = await prisma.order.findUnique({ where: { id } });
        if (!order) {
          return fail(reply, 404, ERR.NOT_FOUND, "Order not found", correlation);
        }

        reply.status(200).send({ order, correlationId: correlation });
      } catch {
        return fail(reply, 503, ERR.UNAVAILABLE, "Orders store unavailable", correlation);
      }
    }
  );

  fastify.post<{ Body: CreateOrderBody }>(
    "/orders",
    {
      schema: {
        body: {
          type: "object",
          required: ["marketId", "side", "type", "amount"],
          additionalProperties: false,
          properties: {
            marketId: { type: "string", minLength: 1, maxLength: 128 },
            side: { type: "string", enum: ["BUY", "SELL"] },
            type: { type: "string", enum: ["LIMIT", "MARKET"] },
            price: { type: "string", pattern: "^[0-9]+(\\.[0-9]+)?$" },
            amount: { type: "string", pattern: "^[0-9]+(\\.[0-9]+)?$" },
            idempotencyKey: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: CreateOrderBody }>, reply) => {
      const correlation = correlationId(request);

      const auth = authorizeWrite(request);
      if (!auth.ok) {
        return fail(reply, auth.status, auth.code, auth.message, correlation);
      }

      const body = request.body;
      if (body.type === "LIMIT" && !body.price) {
        return fail(reply, 400, ERR.VALIDATION, "price is required for LIMIT orders", correlation);
      }

      if (!(await dependencyHealthy(prisma))) {
        return fail(reply, 503, ERR.UNAVAILABLE, "Orders store unavailable", correlation);
      }

      try {
        // Idempotency: replay of the same key returns the existing order
        // instead of creating a duplicate.
        if (body.idempotencyKey) {
          const existing = await prisma.o