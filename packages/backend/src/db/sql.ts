/**
 * Parameterized SQL by construction.
 *
 *   sql`SELECT * FROM users WHERE did_hash = ${didHash}`
 *   -> { text: "SELECT * FROM users WHERE did_hash = $1", values: [didHash] }
 *
 * Interpolated values become placeholders, never text. This is stronger than a rule
 * saying "always parameterize": there is no syntax here that puts a caller-supplied value
 * into the statement, so the unsafe version cannot be written by accident.
 *
 * Identifiers occasionally must be interpolated — a sort column, say. {@link identifier}
 * exists for that and validates against an explicit allowlist, because a placeholder
 * cannot stand in for a column name.
 */
export interface SqlQuery {
  text: string;
  values: unknown[];
}

const FRAGMENT = Symbol("sql.fragment");

interface SqlFragment {
  [FRAGMENT]: true;
  strings: readonly string[];
  values: unknown[];
}

function isFragment(value: unknown): value is SqlFragment {
  return typeof value === "object" && value !== null && FRAGMENT in value;
}

/** An identifier vetted against an allowlist. Never built from raw input. */
export class SqlIdentifier {
  constructor(readonly value: string) {}
}

/**
 * Validates an identifier against an allowlist and marks it safe to inline.
 *
 * @throws when the name is not in `allowed` — the caller must decide the permitted set
 *         up front rather than sanitising whatever arrives.
 */
export function identifier(name: string, allowed: readonly string[]): SqlIdentifier {
  if (!allowed.includes(name)) {
    throw new Error(`identifier "${name}" is not in the allowlist [${allowed.join(", ")}]`);
  }
  // Belt and braces: even an allowlisted name must look like an identifier.
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(`identifier "${name}" is not a plain SQL identifier`);
  }
  return new SqlIdentifier(name);
}

export function sql(strings: TemplateStringsArray, ...values: unknown[]): SqlFragment {
  return { [FRAGMENT]: true, strings, values };
}

/** Flattens a fragment (and any nested fragments) into a parameterized query. */
export function compile(fragment: SqlFragment): SqlQuery {
  const parts: string[] = [];
  const values: unknown[] = [];

  const walk = (node: SqlFragment): void => {
    node.strings.forEach((chunk, index) => {
      parts.push(chunk);

      if (index >= node.values.length) return;
      const value = node.values[index];

      if (isFragment(value)) {
        walk(value);
        return;
      }

      if (value instanceof SqlIdentifier) {
        // Safe: already checked against an allowlist and shape-validated.
        parts.push(`"${value.value}"`);
        return;
      }

      values.push(value);
      parts.push(`$${values.length}`);
    });
  };

  walk(fragment);

  return { text: parts.join("").replace(/\s+/g, " ").trim(), values };
}

export type { SqlFragment };
