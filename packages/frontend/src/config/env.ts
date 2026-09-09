import { z } from "zod";

/**
 * Frontend environment — publishable values only.
 *
 * Everything here is inlined into the JavaScript bundle at build time and is
 * therefore world-readable. Three layers keep server secrets out:
 *   1. `envPrefix: "VITE_PUBLIC_"` in vite.config.ts — nothing else is inlined.
 *   2. `assertOnlyPublicVars` below — fails loudly if that ever regresses.
 *   3. tools/check-frontend-bundle.mjs — scans dist/ in CI.
 */

const PUBLIC_PREFIX = "VITE_PUBLIC_";

export class PrivateEnvLeakError extends Error {
  constructor(offenders: readonly string[]) {
    super(
      `Non-public environment variables reached the frontend: ${offenders.join(", ")}. ` +
        `Only ${PUBLIC_PREFIX}* may be used in browser code.`,
    );
    this.name = "PrivateEnvLeakError";
  }
}

/** Throws if any VITE_ variable without the public prefix is visible. */
export function assertOnlyPublicVars(raw: Record<string, unknown>): void {
  const offenders = Object.keys(raw).filter(
    (key) => key.startsWith("VITE_") && !key.startsWith(PUBLIC_PREFIX),
  );

  if (offenders.length > 0) {
    throw new PrivateEnvLeakError(offenders);
  }
}

const schema = z.object({
  VITE_PUBLIC_API_URL: z.string().url().default("http://localhost:4000"),
  /**
   * Public address of this app, for links that leave the browser.
   *
   * Only the QR code needs it, and it needs it badly: a code is scanned by a *different*
   * device, so `location.origin` — which is `http://localhost:5173` in development —
   * resolves on the phone to the phone, and the scan fails with "connection refused". The
   * origin is right in production and wrong for exactly the case QR codes exist for.
   *
   * Left empty, the app falls back to the origin and says plainly when the resulting link
   * cannot leave this machine, rather than printing a code that quietly does not work.
   */
  VITE_PUBLIC_APP_URL: z.string().url().or(z.literal("")).default(""),
  VITE_PUBLIC_CHAIN_ID: z.coerce.number().int().positive().default(31337),
  VITE_PUBLIC_CHAIN_RPC_URL: z.string().url().default("http://127.0.0.1:8545"),
  VITE_PUBLIC_WALLETCONNECT_PROJECT_ID: z.string().default(""),
  VITE_PUBLIC_IPFS_GATEWAY: z.string().url().default("https://ipfs.io"),
  VITE_PUBLIC_TURNSTILE_SITE_KEY: z.string().default(""),
  VITE_PUBLIC_SENTRY_DSN: z.string().default(""),
});

export type PublicEnv = z.infer<typeof schema>;

export function parsePublicEnv(raw: Record<string, unknown>): PublicEnv {
  assertOnlyPublicVars(raw);
  return schema.parse(raw);
}

export const env: PublicEnv = parsePublicEnv(import.meta.env as unknown as Record<string, unknown>);
