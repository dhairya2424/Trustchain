/**
 * Row-level security, proven against a real PostgreSQL engine.
 *
 * PGlite is Postgres compiled to WASM, so CREATE ROLE, SET ROLE and RLS behave exactly as
 * they do in production. That matters: RLS asserted only in a migration file is a claim,
 * and the interesting failure mode is a policy that looks right and permits too much.
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const MIGRATION = path.join(__dirname, "..", "..", "migrations", "0001_init.sql");

const ALICE = `0x${"a1".repeat(32)}`; // secrets-scan:allow
const BOB = `0x${"b2".repeat(32)}`; // secrets-scan:allow

let db: PGlite;

/** Runs as app_anon with `did` as the session identity, exactly as the API does. */
async function asUser<T>(did: string, work: () => Promise<T>): Promise<T> {
  await db.exec("BEGIN");
  try {
    await db.exec("SET LOCAL ROLE app_anon");
    await db.query("SELECT set_config('app.did_hash', $1, true)", [did]);
    const result = await work();
    await db.exec("COMMIT");
    return result;
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}

async function asService<T>(work: () => Promise<T>): Promise<T> {
  await db.exec("BEGIN");
  try {
    await db.exec("SET LOCAL ROLE app_service");
    const result = await work();
    await db.exec("COMMIT");
    return result;
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(readFileSync(MIGRATION, "utf8"));
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec("RESET ROLE");
  await db.exec("TRUNCATE audit_log, credentials, assets, profiles CASCADE");

  // Parameterized even in fixtures: the SQL audit applies to test code too, and an
  // exception here is how the habit erodes.
  for (const [did, address, name] of [
    [ALICE, "0xaaa", "Alice"],
    [BOB, "0xbbb", "Bob"],
  ]) {
    await db.query(
      "INSERT INTO profiles (did_hash, address, display_name, is_public) VALUES ($1, $2, $3, false)",
      [did, address, name],
    );
  }

  for (const [tokenId, did, uri] of [
    [1, ALICE, "ipfs://alice"],
    [2, BOB, "ipfs://bob"],
  ]) {
    await db.query(
      "INSERT INTO assets (token_id, owner_did, token_uri, is_public) VALUES ($1, $2, $3, false)",
      [tokenId, did, uri],
    );
  }

  for (const [hash, did] of [
    ["0xc1", ALICE],
    ["0xc2", BOB],
  ]) {
    await db.query(
      "INSERT INTO credentials (credential_hash, did_hash, schema_id, issuer) VALUES ($1, $2, $3, $4)",
      [hash, did, "0xs1", "0xissuer"],
    );
  }

  for (const [entryId, did, ref, block] of [
    [1, ALICE, "0xr1", 100],
    [2, BOB, "0xr2", 101],
  ]) {
    await db.query(
      "INSERT INTO audit_log (entry_id, did_hash, action_code, ref_hash, caller, block_number, occurred_at) VALUES ($1, $2, 8, $3, $4, $5, now())",
      [entryId, did, ref, "0xcontract", block],
    );
  }
});

describe("RLS — one user cannot read another's rows", () => {
  it("PROFILES: Alice sees only her own row via app_anon", async () => {
    const rows = await asUser(
      ALICE,
      async () => (await db.query("SELECT did_hash FROM profiles")).rows,
    );

    expect(rows).toHaveLength(1);
    expect((rows[0] as { did_hash: string }).did_hash).toBe(ALICE);
  });

  it("PROFILES: Bob's row is invisible to Alice even when addressed directly", async () => {
    const rows = await asUser(
      ALICE,
      async () => (await db.query("SELECT did_hash FROM profiles WHERE did_hash = $1", [BOB])).rows,
    );

    // Not an error — RLS filters rather than rejecting, so the row simply is not there.
    expect(rows).toHaveLength(0);
  });

  it("ASSETS: Alice cannot see Bob's private asset", async () => {
    const rows = await asUser(
      ALICE,
      async () => (await db.query("SELECT token_id FROM assets")).rows,
    );

    expect(rows.map((r) => (r as { token_id: number }).token_id)).toEqual([1]);
  });

  it("CREDENTIALS: never visible across identities, public or not", async () => {
    const rows = await asUser(
      BOB,
      async () => (await db.query("SELECT credential_hash FROM credentials")).rows,
    );

    expect(rows.map((r) => (r as { credential_hash: string }).credential_hash)).toEqual(["0xc2"]);
  });

  it("AUDIT: Alice sees only entries scoped to her identity", async () => {
    const rows = await asUser(
      ALICE,
      async () => (await db.query("SELECT entry_id FROM audit_log")).rows,
    );

    expect(rows.map((r) => Number((r as { entry_id: string }).entry_id))).toEqual([1]);
  });

  it("public rows ARE shared, so the policy is filtering rather than blanket-denying", async () => {
    await db.exec("RESET ROLE");
    await db.query("UPDATE profiles SET is_public = true WHERE did_hash = $1", [BOB]);

    const rows = await asUser(
      ALICE,
      async () => (await db.query("SELECT did_hash FROM profiles")).rows,
    );

    expect(rows).toHaveLength(2);
  });

  it("an unset session identity sees nothing private", async () => {
    await db.exec("BEGIN");
    await db.exec("SET LOCAL ROLE app_anon");
    const rows = (await db.query("SELECT did_hash FROM profiles")).rows;
    await db.exec("ROLLBACK");

    expect(rows).toHaveLength(0);
  });
});

describe("RLS — app_anon cannot write", () => {
  it("cannot UPDATE another user's row", async () => {
    await expect(
      asUser(ALICE, async () =>
        db.query("UPDATE profiles SET display_name = 'pwned' WHERE did_hash = $1", [BOB]),
      ),
    ).rejects.toThrow(/permission denied/i);

    await db.exec("RESET ROLE");
    const bob = await db.query("SELECT display_name FROM profiles WHERE did_hash = $1", [BOB]);
    expect((bob.rows[0] as { display_name: string }).display_name).toBe("Bob");
  });

  it("cannot UPDATE even its OWN row — app_anon is read-only", async () => {
    await expect(
      asUser(ALICE, async () =>
        db.query("UPDATE profiles SET display_name = 'x' WHERE did_hash = $1", [ALICE]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("cannot INSERT or DELETE", async () => {
    await expect(
      asUser(ALICE, async () =>
        db.query("INSERT INTO profiles (did_hash, address) VALUES ($1, $2)", ["0xnew", "0xnew"]),
      ),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      asUser(ALICE, async () => db.query("DELETE FROM profiles WHERE did_hash = $1", [ALICE])),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("column privileges — encrypted fields are unreachable", () => {
  it("app_anon cannot select the encrypted columns at all", async () => {
    await expect(
      asUser(ALICE, async () => db.query("SELECT kyc_ref_encrypted FROM profiles")),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      asUser(ALICE, async () => db.query("SELECT email_encrypted FROM profiles")),
    ).rejects.toThrow(/permission denied/i);
  });

  it("SELECT * is refused too, so the omission cannot be worked around", async () => {
    await expect(asUser(ALICE, async () => db.query("SELECT * FROM profiles"))).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("app_service can read them, so the restriction is on the role and not the data", async () => {
    const rows = await asService(
      async () => (await db.query("SELECT kyc_ref_encrypted FROM profiles")).rows,
    );

    expect(rows).toHaveLength(2);
  });
});

describe("app_service retains full access", () => {
  it("sees every row regardless of ownership", async () => {
    const rows = await asService(
      async () => (await db.query("SELECT did_hash FROM profiles")).rows,
    );

    expect(rows).toHaveLength(2);
  });

  it("can write", async () => {
    await asService(async () =>
      db.query("UPDATE profiles SET display_name = $1 WHERE did_hash = $2", ["Alice B", ALICE]),
    );

    await db.exec("RESET ROLE");
    const row = await db.query("SELECT display_name FROM profiles WHERE did_hash = $1", [ALICE]);
    expect((row.rows[0] as { display_name: string }).display_name).toBe("Alice B");
  });
});

describe("negative control — the policy is what does the work", () => {
  /**
   * Failing -> passing, demonstrated in one test.
   *
   * Without this, "Alice sees one row" could be true for an unrelated reason — a typo in
   * the fixture, a filter left in the query. Turning RLS off and watching the
   * cross-user read succeed proves the policy is load-bearing, then turning it back on
   * proves it is what stops it.
   */
  it("disabling RLS exposes Bob's row to Alice; re-enabling hides it again", async () => {
    await db.exec("RESET ROLE");
    await db.exec("ALTER TABLE profiles DISABLE ROW LEVEL SECURITY");

    const withoutRls = await asUser(
      ALICE,
      async () => (await db.query("SELECT did_hash FROM profiles")).rows,
    );
    expect(withoutRls, "RLS off: the read should leak both rows").toHaveLength(2);

    await db.exec("RESET ROLE");
    await db.exec("ALTER TABLE profiles ENABLE ROW LEVEL SECURITY");

    const withRls = await asUser(
      ALICE,
      async () => (await db.query("SELECT did_hash FROM profiles")).rows,
    );
    expect(withRls, "RLS on: only Alice's own row").toHaveLength(1);
  });
});

describe("least privilege", () => {
  it("neither application role is a superuser or can create roles", async () => {
    const { rows } = await db.query(
      "SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname IN ('app_service','app_anon') ORDER BY rolname",
    );

    expect(rows).toHaveLength(2);
    for (const role of rows as Record<string, boolean>[]) {
      expect(role.rolsuper, `${role.rolname} must not be superuser`).toBe(false);
      expect(role.rolcreaterole).toBe(false);
      expect(role.rolcreatedb).toBe(false);
      // BYPASSRLS would silently defeat every policy above.
      expect(role.rolbypassrls, `${role.rolname} must not bypass RLS`).toBe(false);
      // NOLOGIN: these are assumed with SET ROLE, never connected to directly.
      expect(role.rolcanlogin).toBe(false);
    }
  });

  it("every sensitive table has RLS enabled", async () => {
    const { rows } = await db.query(
      "SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );

    expect(rows).toHaveLength(4);
    for (const table of rows as { tablename: string; rowsecurity: boolean }[]) {
      expect(table.rowsecurity, `${table.tablename} is missing RLS`).toBe(true);
    }
  });
});
