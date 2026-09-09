import { describe, expect, it } from "vitest";
import {
  assertOnlyPublicVars,
  parsePublicEnv,
  PrivateEnvLeakError,
  resolveApiBaseUrl,
} from "./env";

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

/**
 * The session cookie is SameSite=Strict, so the API host must match the page's or the
 * browser silently withholds it. Pinning the API to one host breaks the other: configured
 * as a LAN address, a page opened at localhost signs in and then makes every request
 * anonymously — a dashboard of "unauthenticated" panels beneath a header showing you signed
 * in, which is a miserable thing to diagnose from the symptoms alone.
 */
describe("resolveApiBaseUrl", () => {
  it("follows the page host in development, so both ends agree", () => {
    expect(resolveApiBaseUrl("http://192.168.31.68:4000", { hostname: "localhost" })).toBe(
      "http://localhost:4000",
    );
    expect(resolveApiBaseUrl("http://localhost:4000", { hostname: "192.168.31.68" })).toBe(
      "http://192.168.31.68:4000",
    );
  });

  it("keeps the scheme and port, changing only the host", () => {
    expect(resolveApiBaseUrl("https://127.0.0.1:8443", { hostname: "10.0.0.4" })).toBe(
      "https://10.0.0.4:8443",
    );
  });

  it("leaves a configured production host exactly as given", () => {
    // A real domain is authoritative. Rewriting a deployed API host to whatever the browser
    // happened to load would be a far worse bug than the one this fixes.
    expect(resolveApiBaseUrl("https://api.trustchain.example.com", { hostname: "localhost" })).toBe(
      "https://api.trustchain.example.com",
    );
    expect(resolveApiBaseUrl("http://localhost:4000", { hostname: "trustchain.example.com" })).toBe(
      "http://localhost:4000",
    );
  });

  it("returns the configured value untouched when there is no page", () => {
    expect(resolveApiBaseUrl("http://localhost:4000", undefined)).toBe("http://localhost:4000");
  });

  it("does not throw on a malformed configured value", () => {
    expect(resolveApiBaseUrl("not-a-url", { hostname: "localhost" })).toBe("not-a-url");
  });
});
