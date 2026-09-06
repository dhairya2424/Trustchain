import { compile, sql, type SqlQuery } from "../db/sql";

export interface Profile {
  didHash: string;
  displayName: string | null;
  bio: string | null;
  avatarUri: string | null;
  /** On-chain fact, mirrored for display only. Never writable through the API. */
  role: string | null;
  updatedAt: string;
}

export type ProfileUpdate = Partial<Pick<Profile, "displayName" | "bio" | "avatarUri">>;

export interface ProfileRepository {
  find(didHash: string): Promise<Profile | null>;
  update(didHash: string, patch: ProfileUpdate): Promise<Profile | null>;
}

/** Minimal shape of a pg Pool. Typed here so tests need no database. */
export interface Queryable {
  query(config: SqlQuery): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Columns a PATCH may ever touch. The database layer enforces it a second time. */
const UPDATABLE_COLUMNS = {
  displayName: "display_name",
  bio: "bio",
  avatarUri: "avatar_uri",
} as const;

export class PostgresProfileRepository implements ProfileRepository {
  constructor(private readonly db: Queryable) {}

  async find(didHash: string): Promise<Profile | null> {
    const query = compile(
      sql`SELECT did_hash, display_name, bio, avatar_uri, role, updated_at
          FROM profiles
          WHERE did_hash = ${didHash}`,
    );

    const { rows } = await this.db.query(query);
    return rows[0] ? toProfile(rows[0]) : null;
  }

  async update(didHash: string, patch: ProfileUpdate): Promise<Profile | null> {
    const entries = Object.entries(patch).filter(([key]) => key in UPDATABLE_COLUMNS);
    if (entries.length === 0) return this.find(didHash);

    // Built as fragments so every value is a placeholder. Column names come from the
    // constant map above, never from the request, so no identifier is caller-controlled.
    let assignments = sql`updated_at = now()`;
    for (const [field, value] of entries) {
      const column = UPDATABLE_COLUMNS[field as keyof typeof UPDATABLE_COLUMNS];
      assignments = sql`${assignments}, ${rawColumn(column)} = ${value}`;
    }

    const query = compile(
      sql`UPDATE profiles
          SET ${assignments}
          WHERE did_hash = ${didHash}
          RETURNING did_hash, display_name, bio, avatar_uri, role, updated_at`,
    );

    const { rows } = await this.db.query(query);
    return rows[0] ? toProfile(rows[0]) : null;
  }
}

/**
 * Wraps a column name from the constant map above.
 *
 * Separate from db/sql.ts `identifier` because there is no user input involved at all
 * here — the name is a compile-time constant, so an allowlist check would be theatre.
 */
function rawColumn(column: string) {
  return sql([`"${column}"`] as unknown as TemplateStringsArray);
}

function toProfile(row: Record<string, unknown>): Profile {
  return {
    didHash: String(row.did_hash),
    displayName: (row.display_name as string | null) ?? null,
    bio: (row.bio as string | null) ?? null,
    avatarUri: (row.avatar_uri as string | null) ?? null,
    role: (row.role as string | null) ?? null,
    updatedAt:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

/** In-memory implementation so route behaviour can be tested without Postgres. */
export class MemoryProfileRepository implements ProfileRepository {
  private readonly rows = new Map<string, Profile>();

  seed(profile: Profile): void {
    this.rows.set(profile.didHash, { ...profile });
  }

  async find(didHash: string): Promise<Profile | null> {
    return this.rows.get(didHash) ?? null;
  }

  async update(didHash: string, patch: ProfileUpdate): Promise<Profile | null> {
    const existing = this.rows.get(didHash);
    if (!existing) return null;

    // Mirrors the SQL layer: only the three known fields are ever written.
    const next: Profile = {
      ...existing,
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.bio !== undefined ? { bio: patch.bio } : {}),
      ...(patch.avatarUri !== undefined ? { avatarUri: patch.avatarUri } : {}),
      updatedAt: new Date().toISOString(),
    };

    this.rows.set(didHash, next);
    return { ...next };
  }
}
