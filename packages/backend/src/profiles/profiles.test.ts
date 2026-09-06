import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Request } from "express";

import { createServer } from "../server";
import { MemoryLogger } from "../http/logger";
import { MemoryProfileRepository, PostgresProfileRepository, type Queryable } from "./repository";

const ALICE_DID = `0x${"a1".repeat(32)}`; // secrets-scan:allow
const ALICE_ADDRESS = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

function harness() {
  const profiles = new MemoryProfileRepository();
  profiles.seed({
    didHash: ALICE_DID,
    displayName: "Alice",
    bio: null,
    avatarUri: null,
    role: "USER",
    updatedAt: new Date().toISOString(),
  });

  const logger = new MemoryLogger();
  const app = createServer({
    logger,
    profiles: {
      profiles,
      logger,
      resolveCaller: (_req: Request) => ({ didHash: ALICE_DID, address: ALICE_ADDRESS }),
    },
  });

  return { app, profiles, logger };
}

describe("PATCH /profiles/me — validation", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it("applies a valid update", async () => {
    const res = await request(h.app)
      .patch("/profiles/me")
      .send({ displayName: "Alice Cooper", bio: "Auditor" });

    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe("Alice Cooper");
    expect(res.body.bio).toBe("Auditor");
  });

  it("rejects an unknown field outright — the schema is strict", async () => {
    const res = await request(h.app)
      .patch("/profiles/me")
      .send({ displayName: "Alice", nickname: "al" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(JSON.stringify(res.body.issues)).toContain("nickname");
  });

  it("rejects a malformed avatar URI", async () => {
    const res = await request(h.app)
      .patch("/profiles/me")
      .send({ avatarUri: "https://evil.example/mutable.png" });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.issues)).toContain("avatarUri");
  });

  it("returns a request id and echoes it in the header", async () => {
    const res = await request(h.app).patch("/profiles/me").send({ nickname: "nope" });

    expect(res.status).toBe(400);
    expect(res.body.requestId).toBeTruthy();
    expect(res.headers["x-request-id"]).toBe(res.body.requestId);
  });

  it("logs a validation failure with the request id but never the values", async () => {
    await request(h.app).patch("/profiles/me").send({ displayName: "", secretField: "hunter2" });

    const record = h.logger.find("request.validation_failed");
    expect(record).toBeTruthy();
    expect(record?.requestId).toBeTruthy();
    expect(record?.path).toBe("/profiles/me");

    // Paths and codes are logged; the offending values are not.
    expect(JSON.stringify(record)).not.toContain("hunter2");
  });

  it("honours an inbound request id, but only a well-formed one", async () => {
    const good = await request(h.app)
      .patch("/profiles/me")
      .set("x-request-id", "trace-abc-123456")
      .send({ displayName: "Alice" });
    expect(good.headers["x-request-id"]).toBe("trace-abc-123456");

    // A header carrying newlines could forge log entries, so it is replaced.
    const bad = await request(h.app)
      .patch("/profiles/me")
      .set("x-request-id", "bad id with spaces")
      .send({ displayName: "Alice" });
    expect(bad.headers["x-request-id"]).not.toBe("bad id with spaces");
  });
});

describe("PATCH /profiles/me — mass assignment", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it("REJECTS an attempt to set role, and never writes it", async () => {
    const res = await request(h.app)
      .patch("/profiles/me")
      .send({ displayName: "Alice", role: "ADMIN" });

    // The strict schema stops it at the edge.
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.issues)).toContain("role");

    const stored = await h.profiles.find(ALICE_DID);
    expect(stored?.role).toBe("USER");
    expect(stored?.displayName).toBe("Alice");
  });

  it("logs an escalation attempt as a security event when the allowlist filters it", async () => {
    // Exercises the second layer directly: a body that reached the handler carrying
    // fields the schema would have rejected, as it would after a careless schema edit.
    const { applyAllowlist, logRejectedFields } = await import("../http/allowlist");
    const { profileMutableFields } = await import("@trustchain/shared");

    const { data, rejected } = applyAllowlist<{ displayName?: string }>(
      { displayName: "Alice", role: "ADMIN", permissions: ["*"] },
      profileMutableFields,
    );

    expect(data).toEqual({ displayName: "Alice" });
    expect(rejected).toEqual(["role", "permissions"]);

    logRejectedFields(h.logger, rejected, {
      requestId: "req-1",
      actor: ALICE_ADDRESS,
      method: "PATCH",
      path: "/profiles/me",
    });

    const event = h.logger.find("security.mass_assignment_blocked");
    expect(event?.level).toBe("warn");
    expect(event?.escalationAttempt).toBe(true);
    expect(event?.escalationFields).toEqual(["role", "permissions"]);
    expect(event?.actor).toBe(ALICE_ADDRESS);
  });

  it("treats a harmless stray field as informational, not as an attack", async () => {
    const { applyAllowlist, logRejectedFields } = await import("../http/allowlist");
    const { profileMutableFields } = await import("@trustchain/shared");

    const { rejected } = applyAllowlist<{ displayName?: string }>(
      { displayName: "Alice", updatedAt: "2026-01-01" },
      profileMutableFields,
    );

    logRejectedFields(h.logger, rejected, { method: "PATCH", path: "/profiles/me" });

    const event = h.logger.find("security.mass_assignment_blocked");
    expect(event?.level).toBe("info");
    expect(event?.escalationAttempt).toBe(false);
  });

  it("logs nothing when every field was permitted", async () => {
    const { logRejectedFields } = await import("../http/allowlist");

    logRejectedFields(h.logger, [], { method: "PATCH", path: "/profiles/me" });

    expect(h.logger.records).toHaveLength(0);
  });
});

describe("PostgresProfileRepository issues parameterized SQL", () => {
  function recordingDb() {
    const queries: { text: string; values: unknown[] }[] = [];
    const db: Queryable = {
      async query(config) {
        queries.push({ text: config.text, values: [...config.values] });
        return { rows: [{ did_hash: ALICE_DID, role: "USER", updated_at: new Date() }] };
      },
    };
    return { db, queries };
  }

  it("parameterizes the lookup", async () => {
    const { db, queries } = recordingDb();
    await new PostgresProfileRepository(db).find(ALICE_DID);

    expect(queries[0]?.text).toContain("WHERE did_hash = $1");
    expect(queries[0]?.values).toEqual([ALICE_DID]);
  });

  it("parameterizes every updated value and never inlines it", async () => {
    const { db, queries } = recordingDb();

    await new PostgresProfileRepository(db).update(ALICE_DID, {
      displayName: "'; DROP TABLE profiles; --",
      bio: "hello",
    });

    const query = queries[0];
    expect(query?.text).toContain('"display_name" = $1');
    expect(query?.text).toContain('"bio" = $2');
    expect(query?.text).toContain("WHERE did_hash = $3");

    // The injection payload travels as a value; the statement text is untouched by it.
    expect(query?.text).not.toContain("DROP");
    expect(query?.values?.[0]).toBe("'; DROP TABLE profiles; --");
  });

  it("never emits a column outside the updatable set", async () => {
    const { db, queries } = recordingDb();

    await new PostgresProfileRepository(db).update(ALICE_DID, {
      displayName: "Alice",
      // Forced past the type system, as a compromised caller would.
      ...({ role: "ADMIN" } as object),
    });

    // `role` legitimately appears in RETURNING, so assert on the SET clause only —
    // that is where a write would happen.
    const text = queries[0]?.text ?? "";
    const setClause = text.slice(text.indexOf("SET"), text.indexOf("WHERE"));

    expect(setClause).toContain("display_name");
    expect(setClause).not.toContain("role");
    expect(queries[0]?.values).not.toContain("ADMIN");
  });
});

/**
 * The store-clean half of P2.5's output safety, end to end through the wired server.
 *
 * These assert on what reaches the repository, not on what comes back in the response —
 * the response is sanitised too, so asserting there would pass even if nothing had been
 * cleaned on the way in.
 */
describe("PATCH /profiles/me — input sanitisation", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it("stores a display name with its markup removed", async () => {
    await request(h.app)
      .patch("/profiles/me")
      .send({ displayName: "<script>alert(1)</script>Alice" });

    const stored = await h.profiles.find(ALICE_DID);
    expect(stored?.displayName).toBe("Alice");
  });

  it("stores a bio with an img onerror payload neutralised", async () => {
    await request(h.app)
      .patch("/profiles/me")
      .send({ bio: '<img src=x onerror="steal(document.cookie)">auditor' });

    const stored = await h.profiles.find(ALICE_DID);
    expect(stored?.bio).toBe("auditor");
    expect(stored?.bio).not.toContain("onerror");
  });

  it("removes a right-to-left override from a display name", async () => {
    // Stored one way, rendered another. An audit trail cannot tolerate that.
    await request(h.app)
      .patch("/profiles/me")
      .send({ displayName: `Alice${String.fromCodePoint(0x202e)}nimda` });

    const stored = await h.profiles.find(ALICE_DID);
    expect(stored?.displayName).toBe("Alicenimda");
  });

  it("logs the sanitisation with the field path but never the payload", async () => {
    await request(h.app)
      .patch("/profiles/me")
      .send({ displayName: "<script>unique_marker_value</script>Alice" });

    const record = h.logger.find("security.input_sanitized");
    expect(record).toBeDefined();
    expect(record?.fields).toEqual(["displayName"]);
    expect(JSON.stringify(h.logger.records)).not.toContain("unique_marker_value");
  });

  it("leaves an ordinary update byte-identical and logs nothing", async () => {
    await request(h.app).patch("/profiles/me").send({ displayName: "Alice Cooper" });

    const stored = await h.profiles.find(ALICE_DID);
    expect(stored?.displayName).toBe("Alice Cooper");
    expect(h.logger.find("security.input_sanitized")).toBeUndefined();
  });

  it("validates before sanitising, so a rejected body is judged on what was really sent", async () => {
    // Four hundred characters of markup would collapse to well under any length cap.
    // Sanitising first would let it slip past the rule the schema author meant to enforce.
    const res = await request(h.app)
      .patch("/profiles/me")
      .send({ displayName: `<b>${"x".repeat(400)}</b>` });

    expect(res.status).toBe(400);
  });
});
