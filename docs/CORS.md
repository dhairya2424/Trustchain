# CORS — the browser boundary

The frontend and the API are different origins. In development the app runs on
`http://localhost:5173` and the API on `http://localhost:4000`; in a deployment they are
different hostnames. Without CORS every request the app makes is refused by the browser
before it reaches a route, so this is not optional polish — it is the thing that makes the
Phase 3 frontend able to talk to the Phase 2 backend at all.

It is also the single easiest security control to get wrong in a way that looks like it
works, because the permissive configuration and the correct configuration are visually
almost identical and behave identically in the happy path.

Implementation: `packages/backend/src/http/cors.ts`. Tests:
`packages/backend/src/http/cors.test.ts` (26).

## Configuration

`CORS_ORIGIN` names the origins allowed to call the API from a browser. One value, or
several separated by commas:

```
CORS_ORIGIN=http://localhost:5173
CORS_ORIGIN=https://app.example.com,https://admin.example.com
```

Each entry is validated as an absolute URL at boot (`packages/backend/src/config/env.ts`),
so a typo fails on startup rather than at the first cross-origin request — where it would
present as a frontend bug and be debugged in the wrong package. Entries are normalised
through the URL parser, so a trailing slash or an uppercase host still matches what the
browser actually sends.

An unset or empty value means no cross-origin browser access. That is the correct
configuration for an API with no browser client, and it is never a reason to loosen
anything.

## What the allowlist refuses, and why it is written this way

The comparison is an exact, lowercased string match against a set. There is no regular
expression and no suffix match, for one reason:

```
allowed:   https://app.example.com
requested: https://app.example.com.evil.test
```

The second host ends with the characters of the first and is a completely different site,
registered by someone else. Any check of the form "ends with our domain" hands that site an
authenticated channel to the API. So the allowlist compares whole origins — scheme, host and
port together. A different scheme (`http` vs `https`) or a different port is a different
origin and is refused.

Two configurations that are tempting and wrong:

- **`origin: true`** reflects whatever `Origin` header arrived. This turns the allowlist into
  "anyone who asks", and combined with credentials it means any website the user visits can
  make authenticated requests to this API with the user's session. It passes every
  happy-path test, which is what makes it dangerous. Seven tests in `cors.test.ts` fail if
  it is reintroduced.
- **`origin: "*"`** is refused by browsers alongside credentials, so it fails loudly — but
  only until someone removes `credentials: true` to make the error go away, at which point
  sessions stop working and reflecting the origin becomes the obvious next fix.

A refused origin is answered normally with the CORS headers simply absent; the browser
blocks the response on its side. The middleware does not throw. Throwing would turn every
scanner and stray `Origin` into a 500 and bury real failures in the noise. Each refusal is
logged as `security.cors_origin_refused` with the origin and the request id.

Requests with no `Origin` header pass through untouched. curl, health probes and
server-to-server callers send none, and CORS is a browser mechanism — refusing them would
break the deployment's own monitoring while protecting nothing.

## Credentials, and why the allowlist is load-bearing

The session is an httpOnly cookie, so `credentials: true` is required for the app to be
authenticated at all. That pairing is deliberate: a cookie the page's script cannot read
means an XSS becomes a request-forgery problem rather than instant credential theft.

It also means the origin allowlist is the control that matters rather than a formality. With
credentials enabled, admitting an origin admits it _as the logged-in user_.

`Authorization` is deliberately absent from the allowed request headers. The session travels
as a cookie; accepting a bearer header cross-origin would quietly create a second
authentication path with different CSRF properties than the one the platform actually
enforces.

`Vary: Origin` is set by the `cors` package on every response, so a shared cache cannot serve
one origin's approval to another.

## The SameSite interaction — read this before choosing hostnames

Session cookies are issued with `SameSite=Strict`
(`packages/backend/src/auth/routes.ts`). CORS and SameSite are independent gates and the
cookie must pass _both_:

- **Same registrable domain** (`app.example.com` calling `api.example.com`, or
  `localhost:5173` calling `localhost:4000` — SameSite ignores the port): the request is
  same-site, `Strict` permits the cookie, and CORS is the only gate. This is the intended
  deployment shape.
- **Different registrable domains** (`app.example.com` calling `api.example.net`): the
  request is cross-site, `Strict` withholds the cookie entirely, and no CORS configuration
  can recover it. Requests would arrive unauthenticated.

So the two hosts must share a registrable domain. If a deployment ever genuinely needs
cross-site cookies, the change is `SameSite=None; Secure` on the cookie plus separate CSRF
protection — not a loosening of the origin allowlist, which would not help.

## Do not add CORS headers at the proxy as well

`infra/nginx/` deliberately sets no `Access-Control-*` headers. Two `Access-Control-Allow-Origin`
headers on one response is not additive — browsers reject the response outright, and the
symptom (every request blocked, both configurations individually correct) is confusing to
diagnose. The application owns CORS because it is the layer that knows which routes take
credentials.

## Position in the middleware stack

`packages/backend/src/server.ts`, in order:

```
securityHeaders → requestId → cors → requireHttps → httpLogger → sanitizeResponses
  → json → cookieParser → routes → errorHandler
```

CORS sits after `requestId` so a refusal is traceable to a request, and before the body
parser, cookie parser and route stack so a preflight — which carries no body, no cookies and
no session — is answered without paying for machinery it has no use for. Preflights are
cached for a day (`Access-Control-Max-Age: 86400`); every mutating request from the app is
preceded by one, so without caching the API answers roughly twice as many requests as it
needs to.
