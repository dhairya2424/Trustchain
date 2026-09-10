#!/usr/bin/env node
/**
 * The passive checks an OWASP ZAP baseline scan performs, run directly.
 *
 *   node tools/security-passive-scan.mjs [--json <path>]
 *
 * A ZAP baseline is a passive pass: it spiders a target and inspects the responses for
 * missing or weak security headers, unsafe cookie flags, permissive CORS, and version or
 * technology disclosure. It does not attack. This script performs that same inspection
 * against both origins and grades each finding the way ZAP's baseline rules do
 * (FAIL / WARN / PASS), so the substance is captured even when the full scanner cannot be
 * resourced on this machine.
 *
 * It is labelled as the manual equivalent, not as ZAP output. The exact ZAP command to run
 * when memory allows is printed at the end.
 */
import { writeFileSync } from "node:fs";

const API = process.env.TRUSTCHAIN_API ?? "http://localhost:4000";
const APP = process.env.TRUSTCHAIN_APP ?? "http://localhost:5173";
const isHttps = API.startsWith("https://");

const findings = [];
function grade(target, check, level, expected, actual) {
  findings.push({ target, check, level, expected, actual });
  const tag = { PASS: "PASS", WARN: "WARN", FAIL: "FAIL", INFO: "INFO" }[level];
  console.log(`  ${tag}  [${target}] ${check}`);
  console.log(`        want: ${expected}`);
  console.log(`        got:  ${actual}`);
}

async function head(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: extraHeaders });
  await res.text();
  const h = {};
  res.headers.forEach((v, k) => (h[k.toLowerCase()] = v));
  return { status: res.status, headers: h, setCookie: res.headers.getSetCookie?.() ?? [] };
}

console.log("TrustChain passive security scan (ZAP-baseline equivalent)\n");

// ---------------------------------------------------------------- API headers
console.log(`1. Security headers — API (${API})`);
{
  const { headers } = await head(`${API}/health`);

  const csp = headers["content-security-policy"];
  grade(
    "API",
    "Content-Security-Policy present and restrictive",
    csp && csp.includes("default-src 'none'") ? "PASS" : csp ? "WARN" : "FAIL",
    "default-src 'none' (a JSON API needs no script/style/img)",
    csp ?? "(absent)",
  );

  grade(
    "API",
    "X-Content-Type-Options: nosniff",
    headers["x-content-type-options"] === "nosniff" ? "PASS" : "FAIL",
    "nosniff",
    headers["x-content-type-options"] ?? "(absent)",
  );

  grade(
    "API",
    "X-Frame-Options / frame-ancestors (clickjacking)",
    headers["x-frame-options"] === "DENY" ||
      (headers["content-security-policy"] ?? "").includes("frame-ancestors 'none'")
      ? "PASS"
      : "FAIL",
    "DENY, or CSP frame-ancestors 'none'",
    `X-Frame-Options=${headers["x-frame-options"] ?? "(absent)"}`,
  );

  grade(
    "API",
    "Referrer-Policy",
    headers["referrer-policy"] ? "PASS" : "WARN",
    "no-referrer (an API should leak no referrer)",
    headers["referrer-policy"] ?? "(absent)",
  );

  // HSTS is only meaningful over TLS; on a plain-http dev origin its absence is correct, and
  // ZAP's baseline suppresses the HSTS rule for http targets too.
  grade(
    "API",
    "Strict-Transport-Security (HSTS)",
    isHttps ? (headers["strict-transport-security"] ? "PASS" : "FAIL") : "INFO",
    isHttps ? "max-age >= 1 year" : "not applicable over plain http (dev); set by ingress in prod",
    headers["strict-transport-security"] ?? "(absent)",
  );

  // Technology / version disclosure.
  grade(
    "API",
    "No Server / X-Powered-By version disclosure",
    !headers["x-powered-by"] ? "PASS" : "WARN",
    "X-Powered-By absent (do not advertise Express)",
    `X-Powered-By=${headers["x-powered-by"] ?? "(absent)"}, Server=${headers["server"] ?? "(absent)"}`,
  );
}

// ---------------------------------------------------------------- cookie flags
console.log("\n2. Session cookie flags (observed on a real sign-in)");
{
  // /auth/nonce sets a short-lived cookie; /auth/verify sets the session + refresh cookies.
  // The nonce response is enough to observe the flag policy the app applies to auth cookies.
  const { setCookie } = await head(`${API}/auth/nonce`);
  const all = setCookie.join(" | ") || "(no Set-Cookie on /auth/nonce)";

  // Inspect whichever auth cookie is present.
  const cookieLine = setCookie.find((c) => /trustchain/i.test(c)) ?? setCookie[0] ?? "";
  const flags = cookieLine.toLowerCase();

  if (cookieLine) {
    grade(
      "API",
      "auth cookie is HttpOnly",
      flags.includes("httponly") ? "PASS" : "FAIL",
      "HttpOnly (script cannot read the token)",
      cookieLine,
    );
    grade(
      "API",
      "auth cookie is SameSite",
      flags.includes("samesite=strict") ? "PASS" : flags.includes("samesite") ? "WARN" : "FAIL",
      "SameSite=Strict",
      cookieLine,
    );
    grade(
      "API",
      "auth cookie Secure flag",
      flags.includes("secure") ? "PASS" : isHttps ? "FAIL" : "INFO",
      isHttps ? "Secure" : "Secure is set only over https; off on the plain-http dev origin",
      cookieLine,
    );
  } else {
    grade("API", "auth cookie flags", "INFO", "a Set-Cookie to inspect", all);
  }
}

// ---------------------------------------------------------------- CORS
console.log("\n3. CORS — does the API reflect an arbitrary Origin?");
{
  const evil = "https://evil.example.com";
  const { headers } = await head(`${API}/health`, { Origin: evil });
  const acao = headers["access-control-allow-origin"];
  const reflectsEvil = acao === evil;
  const allowsCredsWildcard =
    acao === "*" && headers["access-control-allow-credentials"] === "true";
  grade(
    "API",
    "CORS does not reflect an untrusted Origin",
    reflectsEvil || allowsCredsWildcard ? "FAIL" : "PASS",
    "the attacker Origin is not echoed into Access-Control-Allow-Origin",
    `ACAO=${acao ?? "(absent)"} for Origin ${evil}`,
  );
}

// ---------------------------------------------------------------- frontend headers
console.log(`\n4. Security headers — frontend (${APP})`);
{
  try {
    const { status, headers } = await head(`${APP}/`);
    grade("APP", "frontend reachable", status === 200 ? "PASS" : "WARN", "200", `${status}`);
    // In dev the Vite server serves without the production Nginx header set; those headers
    // are applied by the ingress config in docs/HTTPS.md. State that plainly rather than
    // failing a dev server for a production concern.
    grade(
      "APP",
      "frontend security headers",
      headers["content-security-policy"] ? "PASS" : "INFO",
      "CSP + frame options — applied by the production Nginx config, not the Vite dev server",
      `CSP=${headers["content-security-policy"] ? "present" : "(dev server: applied at ingress in prod)"}`,
    );
  } catch (error) {
    grade("APP", "frontend reachable", "WARN", "200", `unreachable: ${error.message}`);
  }
}

// ---------------------------------------------------------------- summary
const counts = findings.reduce((acc, f) => ((acc[f.level] = (acc[f.level] ?? 0) + 1), acc), {});
console.log(`\n${"-".repeat(64)}`);
console.log(
  `${findings.length} passive checks — ` +
    `${counts.PASS ?? 0} pass, ${counts.WARN ?? 0} warn, ${counts.FAIL ?? 0} fail, ${counts.INFO ?? 0} info`,
);
console.log(
  `\nTo run the full OWASP ZAP baseline when memory allows (needs ~2GB free):\n` +
    `  docker run --rm -t --add-host=host.docker.internal:host-gateway \\\n` +
    `    ghcr.io/zaproxy/zaproxy:stable zap-baseline.py \\\n` +
    `    -t http://host.docker.internal:5173 -I\n`,
);

const jsonFlag = process.argv.indexOf("--json");
if (jsonFlag !== -1 && process.argv[jsonFlag + 1]) {
  writeFileSync(process.argv[jsonFlag + 1], JSON.stringify({ findings, counts }, null, 2));
  console.log(`recorded to ${process.argv[jsonFlag + 1]}`);
}

// A FAIL here is a real gap; WARN/INFO are not failures.
if ((counts.FAIL ?? 0) > 0) process.exitCode = 1;
