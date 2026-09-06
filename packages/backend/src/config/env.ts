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
  CORS_ORIGIN: z.string().url(),

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

  PINATA_JWT: z.string().min(1),
  PINATA_GATEWAY: z.string().url(),

  TURNSTILE_SECRET_KEY: z.string().min(1),

  DEFENDER_API_KEY: z.string().optional(),
  DEFENDER_API_SECRET: z.string().optional(),
});

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
