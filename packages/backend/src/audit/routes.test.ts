import { describe, expect, it, vi } from "vitest";
import request from "supertest";

import { createServer } from "../server";
import { MemoryLogger } from "../http/logger";
import type { Caller } from "../http/authorize";
import { ROLE_IDS } from "../auth/roles";
import { CursorCodec } from "./cursor";
import type { AuditFilter, RawAuditEvent } from "./events";
import type { AuditDependencies } from "./routes";

const KEY = Buffer.alloc(32, 5).toString("base64");
const DID = `0x${"1".repeat(64)}`;
const ACTOR = "0x2222222222222222222222222222222222222222";

const ADMIN: Caller = { address: ACTOR, didHash: DID, roles: [ROLE_IDS.ADMIN] };
const AUDITOR: Caller = { address: ACTOR, didHash: DID, roles: [ROLE_IDS.AUDITOR] };

function event(overrides: Partial<RawAuditEvent> = {}): RawAuditEvent {
  return {
    entryId: 5,
    didHash: DID,
    actionCode: 11,
    refHash: `0x${"2".repeat(64)}`,
    via: "0x1111111111111111111111111111111111111111",
    actor: ACTOR,
    blockNumber: 100,
    logIndex: 0,
    transactionHash: `0x${"3".repeat(64)}`,
    timestamp: 1_760_000_000,
    ...overrides,
  };
}

interface Harness {
  caller?: Caller | null;
  permitted?: boolean;
  events?: RawAuditEvent[];
  query?: (f: AuditFilter) => Promise<{ events: RawAuditEvent[]; source: "subgraph" | "chain" }>;
  maxExportRows?: number;
  exportPageSize?: number;
}

function build(options: Harness = {}) {
  const logger = new MemoryLogger();
  const seen: AuditFilter[] = [];

  const audit: AuditDependencies = {
    events: {
      query: async (filter: AuditFilter) => {
        seen.push(filter);
        if (options.query) return options.query(filter);
        return { events: options.events ?? [], source: "subgraph" as const };
      },
    },
    cursors: new CursorCodec(KEY),
    logger,
    resolveCaller: () => (options.caller === undefined ? ADMIN : options.caller),
    permissions: { hasPermission: async () => options.permitted !== false },
    ...(options.maxExportRows !== undefined ? { maxExportRows: options.maxExportRows } : {}),
    ...(options.exportPageSize !== undefined ? { exportPageSize: options.exportPageSize } : {}),
  };

  return { app: createServer({ audit, logger }), logger, seen };
}

describe("GET /audit — authorization", () => {
  it("refuses an unauthenticated caller", async () => {
    const { app } = build({ caller: null });

    expect((await request(app).get("/audit")).status).toBe(401);
  });

  /**
   * Gated on the on-chain PERM_VIEW_AUDIT rather than a role name, because an ADMIN can
   * re-scope which permissions a role carries at runtime. A role-name gate would freeze a
   * snapshot of that matrix into this process.
   */
  it("refuses a caller the chain does not grant VIEW_AUDIT", async () => {
    const { app } = build({ permitted: false });

    expect((await request(app).get("/audit")).status).toBe(403);
  });

  it("admits a caller the chain grants VIEW_AUDIT", async () => {
    const { app } = build({ events: [event()] });

    expect((await request(app).get("/audit")).status).toBe(200);
  });
});

describe("GET /audit — results", () => {
  it("returns entries with readable action names and ISO timestamps", async () => {
    const { app } = build({ events: [event()] });

    const res = await request(app).get("/audit");

    expect(res.body.entries[0].action).toBe("CREDENTIAL_ISSUED");
    expect(res.body.entries[0].occurredAt).toBe(new Date(1_760_000_000 * 1000).toISOString());
  });

  it("distinguishes the initiating actor from the contract that wrote the entry", async () => {
    const { app } = build({ events: [event()] });

    const res = await request(app).get("/audit");

    expect(res.body.entries[0].actor).toBe(ACTOR);
    expect(res.body.entries[0].via).toBe("0x1111111111111111111111111111111111111111");
  });

  it("reports which source answered, so a degraded read is visible", async () => {
    const { app } = build({
      query: async () => ({ events: [event()], source: "chain" as const }),
    });

    expect((await request(app).get("/audit")).body.source).toBe("chain");
  });

  it("passes every filter through to the source", async () => {
    const { app, seen } = build();

    await request(app).get(
      `/audit?actor=${ACTOR}&didHash=${DID}&actionCode=11&from=100&to=200&limit=5`,
    );

    expect(seen[0]).toMatchObject({
      actor: ACTOR.toLowerCase(),
      didHash: DID,
      actionCode: 11,
      from: 100,
      to: 200,
    });
  });

  it("accepts an action name in place of a numeric code", async () => {
    const { app, seen } = build();

    const res = await request(app).get("/audit?action=CREDENTIAL_REVOKED");

    expect(res.status).toBe(200);
    expect(seen[0]?.actionCode).toBe(12);
  });

  /**
   * Silently ignoring an unrecognised name would answer "show me every revocation" with
   * the entire log, and the caller could not tell that from "nothing matched".
   */
  it("rejects an unknown action name rather than ignoring the filter", async () => {
    const { app, seen } = build();

    const res = await request(app).get("/audit?action=NOT_A_REAL_ACTION");

    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it("rejects an action name that contradicts an explicit action code", async () => {
    const { app } = build();

    const res = await request(app).get("/audit?action=CREDENTIAL_ISSUED&actionCode=12");

    expect(res.status).toBe(400);
  });

  it("rejects a time range that ends before it starts", async () => {
    const { app } = build();

    const res = await request(app).get("/audit?from=200&to=100");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("rejects a page size beyond the maximum rather than honouring it", async () => {
    const { app } = build();

    expect((await request(app).get("/audit?limit=5000")).status).toBe(400);
  });

  it("rejects an unknown query parameter, so a typo is not silently ignored", async () => {
    const { app } = build();

    expect((await request(app).get("/audit?acter=0xabc")).status).toBe(400);
  });
});

describe("GET /audit — pagination", () => {
  const page = (n: number) => Array.from({ length: n }, (_, i) => event({ entryId: 100 - i }));

  it("returns no cursor when the results fit on one page", async () => {
    const { app } = build({ events: page(3) });

    const res = await request(app).get("/audit?limit=25");

    expect(res.body.nextCursor).toBeNull();
  });

  it("returns a cursor when there is another page", async () => {
    // The route asks for limit+1 to detect a further page without a second query.
    const { app } = build({ events: page(6) });

    const res = await request(app).get("/audit?limit=5");

    expect(res.body.entries).toHaveLength(5);
    expect(res.body.nextCursor).toBeTruthy();
  });

  it("continues from the cursor, excluding the entry it points at", async () => {
    const { app, seen } = build({ events: page(6) });

    const first = await request(app).get("/audit?limit=5");
    await request(app).get(`/audit?limit=5&cursor=${encodeURIComponent(first.body.nextCursor)}`);

    // Entry 96 is the last one returned on page one, so page two starts strictly below it.
    expect(seen[1]?.beforeEntryId).toBe(96);
  });

  it("rejects a tampered cursor", async () => {
    const { app } = build({ events: page(6) });

    const first = await request(app).get("/audit?limit=5");
    const tampered = `AAAA.${(first.body.nextCursor as string).split(".")[1]}`;

    const res = await request(app).get(`/audit?limit=5&cursor=${encodeURIComponent(tampered)}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_cursor");
  });

  /**
   * Changing filters mid-scan would otherwise return a page belonging to neither query,
   * which an auditor could reasonably read as a complete history.
   */
  it("rejects a cursor reused with different filters", async () => {
    const { app } = build({ events: page(6) });

    const first = await request(app).get(`/audit?limit=5&actor=${ACTOR}`);
    const res = await request(app).get(
      `/audit?limit=5&actor=0x3333333333333333333333333333333333333333&cursor=${encodeURIComponent(first.body.nextCursor)}`,
    );

    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("filter_changed");
  });

  it("accepts a cursor reused with the same filters but a different page size", async () => {
    const { app } = build({ events: page(6) });

    const first = await request(app).get(`/audit?limit=5&actor=${ACTOR}`);
    const res = await request(app).get(
      `/audit?limit=2&actor=${ACTOR}&cursor=${encodeURIComponent(first.body.nextCursor)}`,
    );

    expect(res.status).toBe(200);
  });
});

describe("GET /audit/export.csv", () => {
  it("refuses a caller who is not an ADMIN, even one who may read the audit log", async () => {
    // Reading a page in a UI and walking off with the whole ledger as a file are
    // different acts; bulk extraction is restricted to the governing role.
    const { app } = build({ caller: AUDITOR, permitted: true });

    expect((await request(app).get("/audit/export.csv")).status).toBe(403);
  });

  it("refuses an unauthenticated caller", async () => {
    const { app } = build({ caller: null });

    expect((await request(app).get("/audit/export.csv")).status).toBe(401);
  });

  it("streams a CSV with a header row for an ADMIN", async () => {
    let call = 0;
    const { app } = build({
      caller: ADMIN,
      query: async () => ({ events: call++ === 0 ? [event()] : [], source: "subgraph" as const }),
    });

    const res = await request(app).get("/audit/export.csv");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.text).toContain("entryId");
    expect(res.text).toContain("CREDENTIAL_ISSUED");
  });

  it("sets a download filename and forbids caching", async () => {
    const { app } = build({
      caller: ADMIN,
      query: async () => ({ events: [], source: "subgraph" }),
    });

    const res = await request(app).get("/audit/export.csv");

    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  /** The export is an off-chain action, so it gets an off-chain record. */
  it("records the export itself, with the actor and the filters used", async () => {
    const { app, logger } = build({
      caller: ADMIN,
      query: async () => ({ events: [], source: "subgraph" as const }),
    });

    await request(app).get(`/audit/export.csv?actor=${ACTOR}`);

    const record = logger.find("security.audit_exported");
    expect(record).toBeDefined();
    expect(record?.actor).toBe(ACTOR);
    expect(record?.filter).toMatchObject({ actor: ACTOR.toLowerCase() });
  });

  it("neutralises a formula-injection payload that reached the chain", async () => {
    let call = 0;
    const { app } = build({
      caller: ADMIN,
      query: async () => ({
        events: call++ === 0 ? [event({ via: "=cmd|'/c calc'!A1" })] : [],
        source: "subgraph" as const,
      }),
    });

    const res = await request(app).get("/audit/export.csv");

    expect(res.text).toContain(`"'=cmd|'/c calc'!A1"`);
    expect(res.text).not.toContain(`"=cmd`);
  });

  it("says in the file when the export was truncated", async () => {
    const { app } = build({
      caller: ADMIN,
      maxExportRows: 2,
      exportPageSize: 3,
      query: async () => ({
        events: [event({ entryId: 3 }), event({ entryId: 2 }), event({ entryId: 1 })],
        source: "subgraph" as const,
      }),
    });

    const res = await request(app).get("/audit/export.csv");

    expect(res.text).toContain("export truncated at 2 rows");
  });

  it("marks the file incomplete when the source fails mid-stream", async () => {
    let call = 0;
    const { app, logger } = build({
      caller: ADMIN,
      query: async () => {
        if (call++ === 0) return { events: [event()], source: "subgraph" as const };
        throw new Error("indexer died");
      },
    });

    const res = await request(app).get("/audit/export.csv");

    // Headers are already sent, so the status cannot change — the file must say so itself.
    expect(res.text).toContain("incomplete");
    expect(logger.find("audit.export_failed")).toBeDefined();
  });

  it("rejects an invalid filter before writing any rows", async () => {
    const query = vi.fn(async () => ({ events: [], source: "subgraph" as const }));
    const { app } = build({ caller: ADMIN, query });

    const res = await request(app).get("/audit/export.csv?from=200&to=100");

    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});
