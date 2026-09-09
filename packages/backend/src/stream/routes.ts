import { Router, type Request, type Response } from "express";

import type { Logger } from "../http/logger";
import { requireSession, type Caller, type CallerResolver } from "../http/authorize";
import type { PermissionReader } from "../auth/roleReader";
import type { IndexerSupervisor } from "../indexer/supervisor";
import type { IndexedEvent, TrackedTransaction } from "../indexer/store";
import { actionName } from "../audit/actions";

/**
 * Server-sent events: the chain, pushed rather than polled.
 *
 * The dashboard previously refetched the audit trail every thirty seconds. That is the
 * wrong shape twice over — it is too slow for someone watching their own transaction
 * confirm, and too expensive for everyone who is not, because every open tab pays the cost
 * whether or not anything happened. The indexer already knows the moment a confirmed event
 * appears; this hands that moment to the browsers that care.
 *
 * SSE rather than WebSockets deliberately. The traffic is one-directional — the server has
 * news, the client has nothing to say — and SSE is plain HTTP: it survives proxies, needs
 * no upgrade handshake, works over HTTP/2, and reconnects on its own with no client code.
 * A WebSocket would add a second protocol to secure, proxy and terminate TLS for, in
 * exchange for a channel back that nothing here would use.
 *
 * ## What a subscriber is allowed to see
 *
 * Two streams share one connection, and they have different rules:
 *
 *   `transaction`  the caller's own relayed transactions. Requires a session and nothing
 *                  more — it is their own activity, and it is filtered to their address.
 *   `audit`        new entries in the shared trail. Requires VIEW_AUDIT, checked once at
 *                  subscribe time, because the alternative is re-checking a permission on
 *                  every broadcast to every listener.
 *
 * A caller without VIEW_AUDIT still gets a working connection carrying their own
 * transactions. Refusing the whole stream would mean an ordinary user could not watch their
 * own mint confirm, which is the case this exists for.
 */

export interface StreamDependencies {
  supervisor: IndexerSupervisor;
  resolveCaller: CallerResolver;
  permissions: PermissionReader;
  logger: Logger;
  /** Milliseconds between keep-alive comments. */
  heartbeatMs?: number;
}

/** SSE frame. The event name lets the client dispatch without inspecting the payload. */
function send(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function createStreamRouter(deps: StreamDependencies): Router {
  const router = Router();
  const heartbeatMs = deps.heartbeatMs ?? 25_000;

  router.get(
    "/",
    requireSession({ resolve: deps.resolveCaller, logger: deps.logger }),
    async (req: Request, res: Response) => {
      const caller = req.caller as Caller;

      const mayReadAudit = await deps.permissions
        .hasPermission(caller.address as `0x${string}`, "VIEW_AUDIT")
        .catch(() => false);

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        // Nginx buffers proxied responses by default, which holds each frame until the
        // buffer fills — turning a live stream into a batch delivered minutes late.
        "x-accel-buffering": "no",
      });
      res.flushHeaders?.();

      send(res, "ready", {
        actor: caller.address,
        audit: mayReadAudit,
        indexer: deps.supervisor.status(),
      });

      const unsubscribeEvents = deps.supervisor.onEvents((events: readonly IndexedEvent[]) => {
        if (!mayReadAudit) return;
        for (const event of events) {
          send(res, "audit", {
            entryId: event.entryId,
            action: actionName(event.actionCode),
            actionCode: event.actionCode,
            actor: event.actor,
            executor: event.executor,
            didHash: event.didHash,
            transactionHash: event.transactionHash,
            blockNumber: event.blockNumber,
            occurredAt: new Date(event.timestamp * 1000).toISOString(),
            network: event.network,
          });
        }
      });

      const unsubscribeTransactions = deps.supervisor.onTransaction(
        (transaction: TrackedTransaction) => {
          // Their own only. A transaction hash is public, but who submitted what is not
          // something to broadcast to every connected session.
          if (transaction.actor?.toLowerCase() !== caller.address.toLowerCase()) return;
          send(res, "transaction", transaction);
        },
      );

      // Without traffic an idle connection is closed by proxies and load balancers long
      // before anything interesting happens. A comment frame is ignored by EventSource and
      // costs two bytes.
      const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), heartbeatMs);

      const close = () => {
        clearInterval(heartbeat);
        unsubscribeEvents();
        unsubscribeTransactions();
      };

      req.on("close", close);
      res.on("error", close);
    },
  );

  return router;
}
