import { describe, expect, it } from "vitest";
import { assertOnlyPublicVars, parsePublicEnv, PrivateEnvLeakError } from "./env";

describe("frontend environment", () => {
  it("accepts public variables and applies defaults", () => {
    const env = parsePublicEnv({ VITE_PUBLIC_CHAIN_ID: "80002" });

    expect(env.VITE_PUBLIC_CHAIN_ID).toBe(80002);
    expect(env.VITE_PUBLIC_API_URL).toBe("http://localhost:4000");
  });

  it("rejects a VITE_ variable without the public prefix", () => {
    expect(() => assertOnlyPublicVars({ VITE_JWT_PRIVATE_KEY: "leaked" })).toThrowError(
      PrivateEnvLeakError,
    );
  });

  it("names every offending variable", () => {
    try {
      assertOnlyPublicVars({ VITE_SECRET_A: "x", VITE_SECRET_B: "y", VITE_PUBLIC_API_URL: "ok" });
      expect.unreachable("expected a leak error");
    } catch (error) {
      expect((error as Error).message).toContain("VITE_SECRET_A");
      expect((error as Error).message).toContain("VITE_SECRET_B");
      expect((error as Error).message).not.toContain("VITE_PUBLIC_API_URL");
    }
  });

  it("ignores non-VITE variables entirely", () => {
    expect(() =>
      assertOnlyPublicVars({ DATABASE_URL: "postgres://x", MODE: "test" }),
    ).not.toThrow();
  });
});
