import { describe, expect, it } from "vitest";
import { buildPoolConfig, InsecureConnectionError, withUserSession } from "./connection";

const REMOTE = "postgresql://app:pw@db.internal.example:5432/trustchain"; // secrets-scan:allow
const LOCAL = "postgresql://app:pw@localhost:5432/trustchain"; // secrets-scan:allow

describe("TLS enforcement", () => {
  it("requires verified TLS in production", () => {
    const config = buildPoolConfig({ connectionString: REMOTE, nodeEnv: "production" });

    expect(config.ssl).toEqual({ rejectUnauthorized: true });
    expect(config.connectionString).toContain("sslmode=verify-full");
  });

  it("REFUSES to build a plaintext production connection", () => {
    expect(() =>
      buildPoolConfig({
        connectionString: `${REMOTE}?sslmode=disable`,
        nodeEnv: "production",
      }),
    ).toThrowError(InsecureConnectionError);
  });

  it("still requires TLS for a remote host outside production", () => {
    const config = buildPoolConfig({ connectionString: REMOTE, nodeEnv: "development" });

    expect(config.ssl).not.toBe(false);
  });

  it("allows plaintext only for a local development database", () => {
    expect(buildPoolConfig({ connectionString: LOCAL, nodeEnv: "development" }).ssl).toBe(false);

    // The same local URL in production is still forced onto TLS.
    expect(buildPoolConfig({ connectionString: LOCAL, nodeEnv: "production" }).ssl).not.toBe(false);
  });

  it("pins a CA when one is supplied", () => {
    const config = buildPoolConfig({
      connectionString: REMOTE,
      nodeEnv: "production",
      caCertificate: "-----BEGIN CERTIFICATE-----\nMII...\n-----END CERTIFICATE-----",
    });

    expect(config.ssl).toMatchObject({ rejectUnauthorized: true });
    expect((config.ssl as { ca?: string }).ca).toContain("BEGIN CERTIFICATE");
  });

  it("rejects a malformed connection string instead of guessing", () => {
    expect(() => buildPoolConfig({ connectionString: "not-a-url", nodeEnv: "production" })).toThrow(
      InsecureConnectionError,
    );
  });

  it("bounds statement and idle-transaction time so one query cannot drain the pool", () => {
    const config = buildPoolConfig({ connectionString: REMOTE, nodeEnv: "production" });

    expect(config.statement_timeout).toBeGreaterThan(0);
    expect(config.idle_in_transaction_session_timeout).toBeGreaterThan(0);
  });
});

describe("withUserSession", () => {
  function recordingClient(fail = false) {
    const statements: string[] = [];
    return {
      statements,
      client: {
        async query(text: string) {
          statements.push(text);
          if (fail && text.startsWith("SELECT 1")) throw new Error("boom");
          return { rows: [] };
        },
      },
    };
  }

  it("scopes the identity to the transaction with SET LOCAL, never SET", async () => {
    const { client, statements } = recordingClient();

    await withUserSession(client, "0xdid", async (c) => c.query("SELECT 1"));

    expect(statements[0]).toBe("BEGIN");
    expect(statements[1]).toBe("SET LOCAL ROLE app_anon");
    // set_config with is_local=true is the parameterized equivalent of SET LOCAL.
    expect(statements[2]).toContain("set_config('app.did_hash', $1, true)");
    expect(statements).toContain("COMMIT");

    // A plain SET would outlive the transaction and leak this identity to whichever
    // request picks up the pooled connection next.
    expect(statements.some((s) => /^SET (?!LOCAL)/.test(s))).toBe(false);
  });

  it("rolls back when the work throws, so no session state survives", async () => {
    const { client, statements } = recordingClient(true);

    await expect(
      withUserSession(client, "0xdid", async (c) => c.query("SELECT 1")),
    ).rejects.toThrow("boom");

    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });

  it("passes the identity as a parameter rather than interpolating it", async () => {
    const values: unknown[][] = [];
    const client = {
      async query(_text: string, params?: unknown[]) {
        if (params) values.push(params);
        return { rows: [] };
      },
    };

    await withUserSession(client, "0x'; SET ROLE postgres; --", async () => undefined);

    expect(values[0]).toEqual(["0x'; SET ROLE postgres; --"]);
  });
});
