/**
 * Response security headers and HTTPS enforcement.
 *
 * The API and the single-page app need different policies, and conflating them is how a
 * CSP ends up permissive enough to be decorative. This module owns the API's policy; the
 * SPA's is exported here too but applied by Nginx (`infra/nginx/`), because the SPA is
 * static files that never reach Express.
 */
import helmet from "helmet";
import type { NextFunction, Request, RequestHandler, Response } from "express";

import type { Logger } from "./logger";
import { sanitizeDeep } from "./sanitize";

/** One year, the minimum for the browser preload list. */
export const HSTS_MAX_AGE_SECONDS = 31_536_000;

/**
 * Content-Security-Policy for the JSON API.
 *
 * `default-src 'none'` rather than `'self'`: this origin serves JSON, so there is no
 * legitimate script, style, image or font to load, and the correct policy is to permit
 * nothing at all. That matters despite `nosniff` — an API response rendered as a document
 * (an old browser, a plugin, a `Content-Type` mistake) has no capability under this policy
 * even if it is somehow parsed as HTML.
 *
 * `frame-ancestors 'none'` is the clickjacking control that actually gets enforced;
 * `X-Frame-Options` below is its legacy counterpart, kept for older browsers.
 */
export const API_CSP_DIRECTIVES: Record<string, string[]> = {
  "default-src": ["'none'"],
  "base-uri": ["'none'"],
  "form-action": ["'none'"],
  "frame-ancestors": ["'none'"],
  "object-src": ["'none'"],
  "script-src": ["'none'"],
  "style-src": ["'none'"],
  "img-src": ["'none'"],
  "connect-src": ["'none'"],
  "font-src": ["'none'"],
  "upgrade-insecure-requests": [],
};

/**
 * Content-Security-Policy for the single-page app, consumed by the Nginx config.
 *
 * `script-src 'self'` with no `'unsafe-inline'` and no `'unsafe-eval'` is the whole point:
 * an injected `<script>` tag has no source the browser will execute, and an injected
 * inline handler will not run. Vite is configured to emit no inline scripts so this holds
 * without a nonce.
 *
 * `connect-src` names the API and the IPFS gateway explicitly rather than using `'self'`,
 * so an injected script cannot exfiltrate to an arbitrary host even if it does execute.
 * `wallet` extensions inject into the page and do not need a CSP grant; they operate
 * through `window.ethereum`, not through network requests from the page's own origin.
 */
export function spaCspDirectives(options: {
  apiOrigin: string;
  ipfsGateway: string;
}): Record<string, string[]> {
  return {
    "default-src": ["'self'"],
    "script-src": ["'self'"],
    // Bundlers emit a stylesheet, but styled components and CSS-in-JS inject <style> tags
    // at runtime. This is the one relaxation, and it is style-only: 'unsafe-inline' for
    // styles cannot execute script.
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", options.ipfsGateway],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", options.apiOrigin, options.ipfsGateway],
    "frame-ancestors": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "object-src": ["'none'"],
    "upgrade-insecure-requests": [],
  };
}

/** Features this application never uses. Denying them shrinks what an injection can reach. */
const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "autoplay=()",
  "camera=()",
  "display-capture=()",
  "encrypted-media=()",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "usb=()",
  "xr-spatial-tracking=()",
].join(", ");

export interface SecurityHeaderOptions {
  /**
   * Send HSTS. Defaults to on. Turned off only for a plain-HTTP local run: a browser
   * ignores HSTS over HTTP anyway, but a developer who once loaded `localhost` over HTTPS
   * would otherwise find every other localhost port pinned to HTTPS for a year.
   */
  hsts?: boolean;
}

/**
 * Applies the API's response headers.
 *
 * Helmet is used rather than setting headers by hand because it tracks the ones that get
 * renamed, deprecated or newly recommended. The configuration below is explicit about every
 * directive rather than relying on Helmet's defaults, so a Helmet upgrade cannot silently
 * loosen or tighten the policy without showing up in a diff.
 */
export function securityHeaders(options: SecurityHeaderOptions = {}): RequestHandler[] {
  const handlers: RequestHandler[] = [
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives: API_CSP_DIRECTIVES },
      // Sent only when enabled; a browser ignores it over plain HTTP regardless.
      strictTransportSecurity:
        options.hsts === false
          ? false
          : { maxAge: HSTS_MAX_AGE_SECONDS, includeSubDomains: true, preload: true },
      xContentTypeOptions: true,
      xFrameOptions: { action: "deny" },
      // No referrer at all: a request id or a token in a URL must not leak to a third
      // party through the Referer header.
      referrerPolicy: { policy: "no-referrer" },
      crossOriginOpenerPolicy: { policy: "same-origin" },
      crossOriginResourcePolicy: { policy: "same-origin" },
      crossOriginEmbedderPolicy: false,
      originAgentCluster: true,
      // Long dead, and the IE8 implementation introduced vulnerabilities of its own.
      // Helmet sets `0` to disable it, which is the current guidance.
      xXssProtection: true,
      xDnsPrefetchControl: { allow: false },
      xDownloadOptions: true,
      xPermittedCrossDomainPolicies: { permittedPolicies: "none" },
      hidePoweredBy: true,
    }),
    (_req: Request, res: Response, next: NextFunction) => {
      // Helmet does not set Permissions-Policy.
      res.setHeader("Permissions-Policy", PERMISSIONS_POLICY);
      next();
    },
  ];

  return handlers;
}

export interface HttpsOptions {
  /** When false the middleware is a no-op. Off for local HTTP development. */
  enabled: boolean;
  logger?: Logger;
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * Refuses plain-HTTP requests.
 *
 * Nginx already redirects port 80 to 443, so reaching this middleware over HTTP means the
 * app is exposed by something other than the intended ingress. That is worth failing on
 * rather than quietly serving.
 *
 * A safe method is redirected with 308 so a browser typing the bare hostname still lands
 * somewhere useful. Anything else is refused outright: redirecting a POST would ask the
 * client to resend a body it has already transmitted in the clear, and the credentials in
 * that first request are already compromised. Telling the caller to retry over TLS is the
 * only honest response — the secret needs rotating, not resending.
 */
export function requireHttps(options: HttpsOptions): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!options.enabled) return next();

    // Express populates req.secure from X-Forwarded-Proto when `trust proxy` is set, which
    // server.ts does for exactly this reason.
    if (req.secure) return next();

    options.logger?.log({
      level: "warn",
      msg: "security.plaintext_request",
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      forwardedProto: req.header("x-forwarded-proto") ?? "(none)",
    });

    if (SAFE_METHODS.has(req.method)) {
      const host = req.header("host");
      // Host is attacker-controlled; redirecting to it unvalidated is an open redirect.
      if (host && /^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(host)) {
        res.redirect(308, `https://${host}${req.originalUrl}`);
        return;
      }
    }

    res.status(403).json({
      error: "https_required",
      requestId: req.requestId,
      message: "This API is only served over TLS. Retry over https and rotate any credential sent.",
    });
  };
}

/**
 * Sanitises every string in every JSON response.
 *
 * This wraps `res.json` rather than living in each serialiser, because the guarantee wanted
 * is "no route can forget". Input is already sanitised on the way in, but input
 * sanitisation alone is not enough: the database is not the only writer. Chain events, the
 * IPFS pinning provider, rows written before this middleware existed and rows written by a
 * migration all reach a renderer through this same path.
 *
 * Because the sanitiser only alters strings containing markup or invisible characters,
 * a finding here means dirty data is already stored — so the log line is the actual value
 * of this middleware, not the rewrite.
 */
export function sanitizeResponses(options: { logger: Logger }): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const original = res.json.bind(res);

    res.json = (body: unknown) => {
      const { value, findings } = sanitizeDeep(body);
      const paths = Object.keys(findings);

      if (paths.length > 0) {
        options.logger.log({
          level: "warn",
          msg: "security.output_sanitized",
          requestId: req.requestId,
          method: req.method,
          path: req.path,
          // Field paths and finding names only. The offending value is exactly the thing
          // that must not be copied into a log line.
          fields: paths,
          findings,
        });
      }

      return original(value);
    };

    next();
  };
}
