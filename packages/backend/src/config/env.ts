import { config as loadDotenv } from "dotenv";
import { z } from "zod";

/**
 * Server-side environment contract.
 *
 * Every variable the backend will ever read is declared here. Parsing happens
 * once, at boot, and a malformed or missing value aborts the process rather
 * than surfacing as an undefined deep inside a request handler.
 */

const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte address");

const base64Key32 = z
  .string()
  .refine(
    (value) => Buffer.from(value, "base64").length === 32,
    "must decode to exactly 32 bytes of base64",
  );

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().max(65535).default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  // One or more browser origins, comma separated. Every entry is validated as a URL so a
  // typo fails at boot rather than at the first cross-origin request, when it would look
  // like a frontend bug.
  CORS_ORIGIN: z.string().refine(
    (value) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .every((entry) => URL.canParse(entry)),
    "must be a comma-separated list of absolute origins, e.g. https://app.example.com",
  ),

  DATABASE_URL: z.string().url().startsWith("postgres"),
  REDIS_URL: z.string().url().startsWith("redis"),

  JWT_PRIVATE_KEY: z.string().min(1),
  JWT_PUBLIC_KEY: z.string().min(1),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  SESSION_COOKIE_NAME: z.string().min(1).default("trustchain_session"),
  SESSION_COOKIE_DOMAIN: z.string().min(1),

  SIWE_DOMAIN: z.string().min(1),
  SIWE_ORIGIN: z.string().url(),
  SIWE_NONCE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(604_800), // 7 days

  // Login hardening. Defaults are the numbers the build plan fixes.
  AUTH_RATE_LIMIT_POINTS: z.coerce.number().int().positive().default(5),
  AUTH_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  AUTH_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(10),
  AUTH_BLOCK_BASE_SECONDS: z.coerce.number().int().positive().default(60),
  AUTH_BLOCK_MAX_SECONDS: z.coerce.number().int().positive().default(86_400),

  TURNSTILE_VERIFY_URL: z
    .string()
    .url()
    .default("https://challenges.cloudflare.com/turnstile/v0/siteverify"),

  FIELD_ENCRYPTION_KEY: base64Key32,

  CHAIN_RPC_URL: z.string().url(),
  CHAIN_ID: z.coerce.number().int().positive(),

  ROLE_ACCESS_CONTROL_ADDRESS: evmAddress,
  DID_REGISTRY_ADDRESS: evmAddress,
  ASSET_REGISTRY_ADDRESS: evmAddress,
  CREDENTIAL_REGISTRY_ADDRESS: evmAddress,
  AUDIT_TRAIL_ADDRESS: evmAddress,

  /**
   * Credential signing keys, separate from the session keys above.
   *
   * A session token is short-lived and only this API verifies it. A verifiable credential
   * is long-lived and is verified by third parties, who need the public half. Sharing one
   * keypair would hand every credential verifier the means to validate session tokens and
   * would chain a multi-year rotation schedule to a seven-day one.
   */
  CREDENTIAL_PRIVATE_KEY: z.string().min(1),
  CREDENTIAL_PUBLIC_KEY: z.string().min(1),
  CREDENTIAL_ISSUER_ID: z.string().min(1).default("trustchain"),

  /** Indexed audit events. The chain is the fallback when this is unavailable. */
  SUBGRAPH_URL: z.string().url(),
  /** Block AuditTrail was deployed in; the getLogs fallback never scans below it. */
  AUDIT_TRAIL_DEPLOYMENT_BLOCK: z.coerce.number().int().nonnegative().default(0),
  AUDIT_MAX_EXPORT_ROWS: z.coerce.number().int().positive().max(1_000_000).default(50_000),

  PINATA_JWT: z.string().min(1),
  PINATA_GATEWAY: z.string().url(),

  TURNSTILE_SECRET_KEY: z.string().min(1),

  /**
   * Self-hosted OpenZeppelin Relayer.
   *
   * The signing key lives in that service, configured by its own `config.json`, and never
   * in this process. These three variables are all the application knows about signing:
   * where the service is, which relayer to use, and the credential that authorises
   * requesting a transaction. Swapping the local keystore for AWS KMS changes none of
   * them.
   *
   * Optional as a set: when absent, the write routes are simply not mounted, rather than
   * mounted and failing at the last step.
   */
  RELAYER_URL: z.string().url().optional(),
  RELAYER_API_KEY: z.string().min(1).optional(),
  RELAYER_SPEED: z.enum(["safeLow", "average", "fast", "fastest"]).default("average"),

  /**
   * Where the deploy script writes its records.
   *
   * The selector reads contract addresses from these rather than from environment
   * variables, so there is one source of truth per network and no chance of an address
   * being copied into the wrong variable — a mistake that fails silently, by sending
   * transactions to an address where nothing lives.
   */
  DEPLOYMENTS_DIR: z.string().min(1).default("../contracts/deployments"),

  /**
   * How long a network selection is trusted before re-probing.
   *
   * Short enough that funding the Amoy signer takes effect on its own, long enough that a
   * burst of requests does not probe the chain once per request.
   */
  NETWORK_PROBE_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(60),

  /**
   * Polygon Amoy endpoint.
   *
   * Kept as its own variable because that is how the deployment scripts and the relayer
   * service refer to it, and duplicating an RPC URL that carries an API key into a second
   * variable is how one copy gets rotated and the other does not. When set, it takes
   * precedence over CHAIN_RPC_URL for chain id 80002.
   */
  POLYGON_AMOY_RPC_URL: z.string().url().optional(),

  /**
   * Local filesystem stand-in for IPFS pinning.
   *
   * Deliberately independent of the relayer: pinning and signing are unrelated concerns,
   * and a deployment may reasonably use real Pinata with a local chain, or the reverse.
   */
  DEV_IPFS_DIR: z.string().min(1).default(".local-ipfs"),
});

/** Chain id for Polygon Amoy, the only network this build targets. */
export const POLYGON_AMOY_CHAIN_ID = 80002;

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid environment:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

/**
 * Validate a raw environment bag.
 *
 * Error messages carry variable names and the reason only — never the offending
 * value, so a crash log can be pasted into a ticket without leaking a secret.
 */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new EnvValidationError(issues);
  }

  return result.data;
}

let cached: Env | undefined;

/** Load `.env`, validate, and memoise. Throws on the first invalid variable. */
export function loadEnv(): Env {
  if (!cached) {
    loadDotenv();
    cached = parseEnv(process.env);
  }
  return cached;
}

/** Test seam — drops the memoised value so a fresh environment can be parsed. */
export function resetEnvCache(): void {
  cached = undefined;
}

/**
 * The RPC endpoint to use for the configured chain.
 *
 * On Amoy the dedicated variable wins when present, so the endpoint that carries an API
 * key is configured in exactly one place.
 */
export function rpcUrlFor(env: Env): string {
  if (env.CHAIN_ID === POLYGON_AMOY_CHAIN_ID && env.POLYGON_AMOY_RPC_URL) {
    return env.POLYGON_AMOY_RPC_URL;
  }
  return env.CHAIN_RPC_URL;
}
