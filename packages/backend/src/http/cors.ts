import cors from "cors";
import type { RequestHandler } from "express";

import type { Logger } from "./logger";

/**
 * Cross-origin access for the single-page app.
 *
 * The frontend and the API are separate origins, so without this every browser request from
 * the app is refused before it reaches a route. What makes CORS worth writing carefully
 * rather than pasting is that the permissive configurations are the ones that look like
 * they work:
 *
 *   - `origin: true` reflects whatever Origin the request carried, which turns the
 *     allowlist into "anyone who asks". With credentials enabled that hands any website
 *     the user visits an authenticated channel to this API.
 *   - `origin: "*"` is refused by browsers alongside credentials, so it fails loudly — but
 *     only after someone has removed `credentials`, at which point sessions stop working
 *     and the tempting fix is to reflect the origin instead.
 *
 * So the allowlist here is an explicit set of exact origins, compared by string. There is
 * no regular expression and no suffix match: `https://trustchain.example.com.evil.test`
 * ends with the right characters and is a completely different site.
 *
 * `credentials: true` is required because the session is an httpOnly cookie. That is a
 * deliberate pairing — a cookie the page's script cannot read means an XSS becomes a
 * request-forgery problem rather than instant credential theft — and it is what makes the
 * origin allowlist load-bearing rather than decorative.
 */

export interface CorsOptions {
  /**
   * Exact origins permitted to call this API, e.g. `https://app.example.com`.
   *
   * Empty means no cross-origin browser access at all, which is the correct configuration
   * for an API with no browser client rather than a reason to loosen anything.
   */
  allowedOrigins: readonly string[];
  logger?: Logger;
}

/**
 * Headers the app is allowed to send.
 *
 * `x-request-id` is here because the API honours an inbound one for tracing; `content-type`
 * because the app posts JSON and multipart. Authorization is absent on purpose: the session
 * travels as a cookie, and accepting a bearer header cross-origin would quietly create a
 * second authentication path with different properties.
 */
const ALLOWED_HEADERS = ["content-type", "x-request-id"];

/**
 * Headers the app is allowed to read back.
 *
 * A browser hides every response header from script unless it is named here, so without
 * this the request id the API returns would be invisible to the client that needs it to
 * report a problem.
 */
const EXPOSED_HEADERS = ["x-request-id", "retry-after"];

const ALLOWED_METHODS = ["GET", "POST", "PATCH", "DELETE", "OPTIONS"];

/** Parses the configured value, which may name several origins separated by commas. */
export function parseAllowedOrigins(configured: string | undefined): string[] {
  if (!configured) return [];

  return configured
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      // Normalised through the URL parser so a trailing slash or an uppercase host does not
      // silently fail to match what the browser actually sends.
      try {
        return new URL(entry).origin;
      } catch {
        return entry;
      }
    });
}

export function corsMiddleware(options: CorsOptions): RequestHandler {
  const allowed = new Set(options.allowedOrigins.map((origin) => origin.toLowerCase()));

  return cors({
    origin(requestOrigin, callback) {
      // No Origin header: a same-origin request, a server-to-server call, or curl. These
      // are not subject to CORS at all, and refusing them here would break the health
      // check and every non-browser client.
      if (!requestOrigin) return callback(null, true);

      if (allowed.has(requestOrigin.toLowerCase())) return callback(null, true);

      options.logger?.log({
        level: "warn",
        msg: "security.cors_origin_refused",
        origin: requestOrigin,
      });

      // `false` omits the CORS headers rather than throwing. The browser then blocks the
      // response on its side, which is the specified behaviour; throwing here would turn a
      // routine refusal into a 500 and bury real errors in the noise.
      return callback(null, false);
    },
    credentials: true,
    methods: ALLOWED_METHODS,
    allowedHeaders: ALLOWED_HEADERS,
    exposedHeaders: EXPOSED_HEADERS,
    // Cache preflights for a day. Every mutating request from the app is preceded by one,
    // so without this the API answers twice as many requests as it needs to.
    maxAge: 86_400,
    optionsSuccessStatus: 204,
  });
}
