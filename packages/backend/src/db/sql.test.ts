import { describe, expect, it } from "vitest";
import { compile, identifier, sql } from "./sql";

describe("sql tagged template", () => {
  it("turns interpolated values into placeholders, never text", () => {
    const didHash = "0xabc";
    const query = compile(sql`SELECT * FROM users WHERE did_hash = ${didHash}`);

    expect(query.text).toBe("SELECT * FROM users WHERE did_hash = $1");
    expect(query.values).toEqual(["0xabc"]);
  });

  it("numbers placeholders in order across many values", () => {
    const query = compile(
      sql`INSERT INTO users (did_hash, address, name) VALUES (${"0xa"}, ${"0xb"}, ${"n"})`,
    );

    expect(query.text).toContain("VALUES ($1, $2, $3)");
    expect(query.values).toEqual(["0xa", "0xb", "n"]);
  });

  it("keeps a classic injection payload as a value, not as SQL", () => {
    const hostile = "'; DROP TABLE users; --";
    const query = compile(sql`SELECT * FROM users WHERE display_name = ${hostile}`);

    // The payload never reaches the statement text.
    expect(query.text).toBe("SELECT * FROM users WHERE display_name = $1");
    expect(query.text).not.toContain("DROP");
    expect(query.values).toEqual([hostile]);
  });

  it("composes nested fragments while keeping placeholder numbering correct", () => {
    const where = sql`WHERE did_hash = ${"0xdid"} AND action_code = ${9}`;
    const query = compile(sql`SELECT * FROM audit ${where} LIMIT ${25}`);

    expect(query.text).toBe(
      "SELECT * FROM audit WHERE did_hash = $1 AND action_code = $2 LIMIT $3",
    );
    expect(query.values).toEqual(["0xdid", 9, 25]);
  });

  it("passes null and undefined through as values rather than literals", () => {
    const query = compile(sql`UPDATE users SET bio = ${null} WHERE id = ${undefined}`);

    expect(query.text).toBe("UPDATE users SET bio = $1 WHERE id = $2");
    expect(query.values).toEqual([null, undefined]);
  });
});

describe("identifier allowlist", () => {
  const SORTABLE = ["created_at", "display_name"] as const;

  it("inlines an allowlisted identifier, quoted", () => {
    const query = compile(sql`SELECT * FROM users ORDER BY ${identifier("created_at", SORTABLE)}`);

    expect(query.text).toBe('SELECT * FROM users ORDER BY "created_at"');
    expect(query.values).toEqual([]);
  });

  it("refuses a column that is not on the allowlist", () => {
    expect(() => identifier("password_hash", SORTABLE)).toThrow(/not in the allowlist/);
  });

  it("refuses an injection attempt dressed as a sort column", () => {
    expect(() => identifier("created_at; DROP TABLE users", SORTABLE)).toThrow(
      /not in the allowlist/,
    );
  });
});
