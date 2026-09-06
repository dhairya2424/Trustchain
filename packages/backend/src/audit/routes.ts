import { Router } from "express";
import { auditQuery, type AuditQuery } from "@trustchain/shared";

import type { Logger } from "../http/logger";
import type { CallerResolver } from "../http/authorize";
import { requirePermission, requireRole } from "../http/authorize";
import { asyncHandler } from "../http/middleware";
import type { PermissionReader } from "../auth/roleReader";
import { actionCode } from "./actions";
import { CursorCodec, CursorError, filterFingerprint } from "./cursor";
import { streamAuditCsv } from "./csv";
import type { AuditFilter, FallbackAuditSource, RawAuditEvent } from "./events";
import { toAuditEntryDto, type AuditPageDto } from "./serializers";

export interface AuditDependencies {
  events: Pick<FallbackAuditSource, "query">;
  cursors: CursorCodec;
  logger: Logger;
  resolveCaller: CallerResolver;
  permissions?: PermissionReader;
  /** Hard ceiling on a single CSV export. */
  maxExportRows?: number;
  /** Rows fetched per page while streaming an export. */
  exportPageSize?: number;
}

const DEFAULT_MAX_EXPORT_ROWS = 50_000;
const DEFAULT_EXPORT_PAGE_SIZE = 500;

/**
 * Builds the source filter, resolving `action` from a name to a code.
 *
 * An unrecognised action name is an error rather than an ignored filter. Silently
 * dropping it would answer a narrow question — "show me every revocation" — with the
 * entire log, and the caller would have no way to tell the difference between "no filter
 * applied" and "nothing matched".
 */
function toFilter(
  query: AuditQuery,
): { ok: true; filter: Omit<AuditFilter, "limit"> } | { ok: false; error: string } {
  let code = query.actionCode;

  if (query.action !== undefined) {
    const resolved = actionCode(query.action);
    if (resolved === null) {
      return { ok: false, error: `unknown action name: ${query.action}` };
    }
    if (code !== undefined && code !== resolved) {
      return { ok: false, error: "`action` and `actionCode` disagree" };
    }
    code = resolved;
  }

  return {
    ok: true,
    filter: {
      ...(query.actor ? { actor: query.actor } : {}),
      ...(query.didHash ? { didHash: query.didHash } : {}),
      ...(code !== undefined ? { actionCode: code } : {}),
      ...(query.from !== undefined ? { from: query.from } : {}),
      ...(query.to !== undefined ? { to: query.to } : {}),
    },
  };
}

export function createAuditRouter(deps: AuditDependencies): Router {
  const router = Router();
  const maxExportRows = deps.maxExportRows ?? DEFAULT_MAX_EXPORT_ROWS;
  const exportPageSize = deps.exportPageSize ?? DEFAULT_EXPORT_PAGE_SIZE;

  const authorizeOptions = {
    resolve: deps.resolveCaller,
    logger: deps.logger,
    ...(deps.permissions ? { permissions: deps.permissions } : {}),
  };

  /**
   * Gated on the on-chain PERM_VIEW_AUDIT rather than on a role name.
   *
   * Permissions are re-scopable by an ADMIN at runtime — that is the whole reason the
   * contracts separate roles from permissions. Gating on "is an AUDITOR" would freeze a
   * snapshot of the matrix into this process, so revoking audit access from AUDITOR
   * on-chain would leave the door open here until someone redeployed the API.
   */
  router.get(
    "/",
    requirePermission({ ...authorizeOptions, permission: "VIEW_AUDIT" }),
    asyncHandler(async (req, res) => {
      const parsed = auditQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({
          error: "invalid_request",
          requestId: req.requestId,
          issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
        });
        return;
      }

      const query = parsed.data;
      const built = toFilter(query);
      if (!built.ok) {
        res.status(400).json({
          error: "invalid_request",
          requestId: req.requestId,
          issues: [built.error],
        });
        return;
      }

      const filter = built.filter;
      const fingerprint = filterFingerprint(filter);

      let beforeEntryId: number | undefined;
      if (query.cursor) {
        try {
          beforeEntryId = deps.cursors.decode(query.cursor, fingerprint).entryId;
        } catch (error) {
          const code = error instanceof CursorError ? error.code : "malformed";
          deps.logger.log({
            level: "warn",
            msg: "audit.cursor_rejected",
            requestId: req.requestId,
            actor: req.caller?.address,
            reason: code,
          });
          res.status(400).json({ error: "invalid_cursor", reason: code, requestId: req.requestId });
          return;
        }
      }

      // One extra row decides whether a next page exists, without a second count query.
      const { events, source } = await deps.events.query({
        ...filter,
        ...(beforeEntryId !== undefined ? { beforeEntryId } : {}),
        limit: query.limit + 1,
      });

      const page = events.slice(0, query.limit);
      const last = page[page.length - 1];

      const body: AuditPageDto = {
        entries: page.map(toAuditEntryDto),
        nextCursor:
          events.length > query.limit && last
            ? deps.cursors.encode({ entryId: last.entryId, filterHash: fingerprint })
            : null,
        source,
      };

      res.json(body);
    }),
  );

  /**
   * CSV export. ADMIN only, and the export is itself recorded.
   *
   * Narrower than the read above on purpose: reading a page of the audit log in a UI and
   * walking off with the whole thing as a file are different acts. Bulk extraction is the
   * step that turns a public-but-inconvenient ledger into a portable dossier, so it is
   * restricted to the role that governs the platform.
   *
   * The export is logged as `security.audit_exported`, in the application log rather than
   * on-chain. That boundary is deliberate and worth being explicit about: the AuditTrail
   * contract accepts writes only from sibling system contracts, which is exactly what
   * stops anyone forging entries — the API is not, and must not become, a trusted caller.
   * So an off-chain action gets an off-chain record, shipped to the same aggregator as
   * every other security event.
   */
  router.get(
    "/export.csv",
    requireRole({ ...authorizeOptions, roles: ["ADMIN"] }),
    asyncHandler(async (req, res) => {
      const parsed = auditQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({
          error: "invalid_request",
          requestId: req.requestId,
          issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
        });
        return;
      }

      const built = toFilter(parsed.data);
      if (!built.ok) {
        res.status(400).json({
          error: "invalid_request",
          requestId: req.requestId,
          issues: [built.error],
        });
        return;
      }

      const filter = built.filter;

      deps.logger.log({
        level: "info",
        msg: "security.audit_exported",
        requestId: req.requestId,
        actor: req.caller?.address,
        filter,
        maxRows: maxExportRows,
      });

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="trustchain-audit-${new Date().toISOString().slice(0, 10)}.csv"`,
      );
      // The body is generated, so a proxy or browser must not keep a copy.
      res.setHeader("Cache-Control", "no-store");
      // The filename is ours, but the header is still one a sniffer could misread.
      res.setHeader("X-Content-Type-Options", "nosniff");

      let rows = 0;
      try {
        for await (const chunk of streamAuditCsv({
          maxRows: maxExportRows,
          fetchPage: async (beforeEntryId): Promise<RawAuditEvent[]> => {
            const { events } = await deps.events.query({
              ...filter,
              ...(beforeEntryId !== undefined ? { beforeEntryId } : {}),
              limit: exportPageSize,
            });
            return events;
          },
        })) {
          rows += 1;
          // Respect backpressure: without this a fast source outruns a slow client and
          // the unsent rows accumulate in this process's memory.
          if (!res.write(chunk)) {
            await new Promise<void>((resolve) => res.once("drain", resolve));
          }
        }
      } catch (error) {
        deps.logger.log({
          level: "error",
          msg: "audit.export_failed",
          requestId: req.requestId,
          actor: req.caller?.address,
          rowsWritten: rows,
          detail: error instanceof Error ? error.message : "unknown",
        });

        // Headers are already sent, so the status cannot be changed. Ending the stream
        // mid-file would look like a complete export; a trailing marker does not.
        res.write('"export failed before completion; this file is incomplete"\r\n');
      }

      res.end();
    }),
  );

  return router;
}
