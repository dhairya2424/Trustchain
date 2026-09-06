import { describe, expect, it } from "vitest";
import { EnvValidationError, parseEnv } from "./env";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    CORS_ORIGIN: "http://localhost:5173",
    DATABASE_URL: "postgresql://user:pw@localhost:5432/trustchain",
    REDIS_URL: "redis://localhost:6379",
    JWT_PRIVATE_KEY: "private-key-pem",
    JWT_PUBLIC_KEY: "public-key-pem",
    SESSION_COOKIE_DOMAIN: "localhost",
    SIWE_DOMAIN: "localhost:5173",
    SIWE_ORIGIN: "http://localhost:5173",
    FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    CHAIN_RPC_URL: "http://127.0.0.1:8545",
    CHAIN_ID: "31337",
    ROLE_ACCESS_CONTROL_ADDRESS: ZERO_ADDRESS,
    DID_REGISTRY_ADDRESS: ZERO_ADDRESS,
    ASSET_REGISTRY_ADDRESS: ZERO_ADDRESS,
    CREDENTIAL_REGISTRY_ADDRESS: ZERO_ADDRESS,
    AUDIT_TRAIL_ADDRESS: ZERO_ADDRESS,
    PINATA_JWT: "pinata-jwt",
    PINATA_GATEWAY: "https://example.mypinata.cloud",
    TURNSTILE_SECRET_KEY: "turnstile-secret",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("environment validation", () => {
  it("accepts a complete environment and applies documented defaults", () => {
    const env = parseEnv(validEnv());

    expect(env.PORT).toBe(4000);
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.SESSION_COOKIE_NAME).toBe("trustchain_session");
    expect(env.JWT_ACCESS_TTL_SECONDS).toBe(900);
  });

  it("coerces numeric variables to numbers", () => {
    const env = parseEnv(validEnv({ PORT: "8080", CHAIN_ID: "80002" }));

    expect(env.PORT).toBe(8080);
    expect(env.CHAIN_ID).toBe(80002);
  });

  it.each([
    "DATABASE_URL",
    "REDIS_URL",
    "JWT_PRIVATE_KEY",
    "FIELD_ENCRYPTION_KEY",
    "PINATA_JWT",
    "TURNSTILE_SECRET_KEY",
    "CHAIN_RPC_URL",
  ])("fails fast when %s is missing", (variable) => {
    expect(() => parseEnv(validEnv({ [variable]: undefined }))).toThrowError(EnvValidationError);
  });

  it("names every offending variable in the error", () => {
    try {
      parseEnv(validEnv({ DATABASE_URL: undefined, PINATA_JWT: undefined }));
      expect.unreachable("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const { issues } = error as EnvValidationError;
      expect(issues.some((issue) => issue.startsWith("DATABASE_URL"))).toBe(true);
      expect(issues.some((issue) => issue.startsWith("PINATA_JWT"))).toBe(true);
    }
  });

  it("rejects a malformed contract address", () => {
    expect(() => parseEnv(validEnv({ ASSET_REGISTRY_ADDRESS: "0xdeadbeef" }))).toThrowError(
      EnvValidationError,
    );
  });

  it("rejects an encryption key that is not 32 bytes", () => {
    expect(() =>
      parseEnv(validEnv({ FIELD_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") })),
    ).toThrowError(EnvValidationError);
  });

  it("rejects a non-postgres DATABASE_URL", () => {
    expect(() => parseEnv(validEnv({ DATABASE_URL: "mysql://localhost:3306/db" }))).toThrowError(
      EnvValidationError,
    );
  });

  it("never echoes a secret value into the error message", () => {
    const secret = "super-secret-value-that-must-not-leak"; // secrets-scan:allow

    try {
      // Valid string, but fails the 32-byte rule — so it appears in an error path.
      parseEnv(validEnv({ FIELD_ENCRYPTION_KEY: secret }));
      expect.unreachable("expected validation to fail");
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});
