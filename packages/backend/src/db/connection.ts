export interface ConnectionOptions {
  connectionString: string;
  nodeEnv: string;
  /** PEM of the server CA, when the deployment pins one. */
  caCertificate?: string;
}

export interface PoolConfig {
  connectionString: string;
  ssl: false | { rejectUnauthorized: boolean; ca?: string };
  application_name: string;
  max: number;
  statement_timeout: number;
  idle_in_transaction_session_timeout: number;
}

export class InsecureConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsecureConnectionError";
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres", "db"]);

function hostOf(connectionString: string): string {
  try {
    return new URL(connectionString).hostname;
  } catch {
    return "";
  }
}

/**
 * Builds a pg pool config, refusing to produce an unencrypted one outside development.
 *
 * TLS is enforced here rather than left to the connection string, because
 * `?sslmode=require` is one careless copy-paste away from being dropped and nothing
 * would complain — the connection would simply work, in plaintext, forever. Making the
 * insecure case throw means the mistake surfaces at boot rather than in a packet capture.
 *
 * `sslmode=require` in libpq encrypts but does not verify the certificate, which stops
 * passive sniffing and not an active man in the middle. Production therefore verifies.
 */
export function buildPoolConfig(options: ConnectionOptions): PoolConfig {
  const { connectionString, nodeEnv, caCertificate } = options;

  const url = (() => {
    try {
      return new URL(connectionString);
    } catch {
      throw new InsecureConnectionError("DATABASE_URL is not a valid connection string");
    }
  })();

  const sslMode = url.searchParams.get("sslmode");
  const host = hostOf(connectionString);
  const isLocal = LOCAL_HOSTS.has(host);
  const isProduction = nodeEnv === "production";

  if (isProduction) {
    if (sslMode === "disable") {
      throw new InsecureConnectionError(
        "DATABASE_URL sets sslmode=disable in production; refusing to connect in plaintext",
      );
    }
    if (isLocal === false && sslMode === null) {
      // Not fatal — we are about to force TLS on anyway — but the mismatch is worth
      // making explicit rather than silently overriding.
      url.searchParams.set("sslmode", "verify-full");
    }
  }

  const ssl =
    !isProduction && isLocal
      ? (false as const)
      : { rejectUnauthorized: true, ...(caCertificate ? { ca: caCertificate } : {}) };

  return {
    connectionString: url.toString(),
    ssl,
    application_name: "trustchain-api",
    max: 10,
    // A query that hangs holds a connection and a transaction; bound both so one bad
    // statement cannot exhaust the pool.
    statement_timeout: 10_000,
    idle_in_transaction_session_timeout: 30_000,
  };
}

export interface SessionRunner {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * Runs work as `app_anon` scoped to one identity.
 *
 * SET LOCAL, never SET: the setting is bound to the transaction, so it cannot leak to
 * whichever request picks up this pooled connection next — which would hand one user
 * another user's row visibility.
 */
export async function withUserSession<T>(
  client: SessionRunner,
  didHash: string,
  work: (client: SessionRunner) => Promise<T>,
): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL ROLE app_anon");
    await client.query("SELECT set_config('app.did_hash', $1, true)", [didHash]);

    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
