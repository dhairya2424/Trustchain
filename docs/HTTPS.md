# Running TrustChain over HTTPS

What changes between `localhost` and a public HTTPS deployment, and what breaks if you get
it wrong. Local development is unaffected by everything here — every switch below is driven
by `NODE_ENV` or by configuration, so `npm run dev` continues to work over plain HTTP.

---

## 1. What is already handled

| Concern           | Where                     | Behaviour                                                                                                                         |
| ----------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| TLS termination   | `infra/nginx/`            | Nginx terminates; the app never sees a certificate                                                                                |
| Plaintext refused | `http/securityHeaders.ts` | `requireHttps` rejects non-TLS requests when `NODE_ENV=production`                                                                |
| HSTS              | same                      | Sent in production only, so a local browser is not pinned to HTTPS on localhost                                                   |
| `req.secure`      | `server.ts` + nginx       | `trust proxy` plus `X-Forwarded-Proto`, which nginx **sets** rather than appends — a client cannot claim to have arrived over TLS |
| Session cookies   | `auth/routes.ts`          | `httpOnly`, `SameSite=Strict`, and `Secure` whenever `NODE_ENV=production`                                                        |

---

## 2. The three things that actually need attention

### Cookies are `SameSite=Strict` — keep the API and app on one registrable domain

The session is a cookie, and `SameSite=Strict` means the browser sends it only on same-site
requests. Same-site is decided by **registrable domain**, not origin, so these work:

```
app     https://trustchain.example.com
api     https://api.trustchain.example.com     ✓ same site, different origin
```

and this does not:

```
app     https://trustchain.example.com
api     https://trustchain-api.net             ✗ different site — no cookie, no session
```

Put both under one domain. The failure is confusing if you do not: the app loads, sign-in
appears to succeed, and every subsequent request is anonymous — including the event stream,
which simply never delivers anything.

### Server-sent events need their own proxy rules

`/stream` is a long-lived response, and every sensible default for a normal API request is
wrong for it. `infra/nginx/conf.d/trustchain.conf` has a dedicated block:

- **`proxy_buffering off`** — buffering holds each frame until the buffer fills, so a live
  feed arrives in batches, minutes late. That looks exactly like an indexer that has stopped.
- **`proxy_read_timeout 1h`** — the API block uses 60s. A stream is idle between events by
  design, so a one-minute timeout would cut it constantly and the browser would reconnect
  forever.
- **no `limit_req`** — a stream is one request lasting hours, not a rate. `limit_conn` in the
  server block is what bounds these.

The application also sends `X-Accel-Buffering: no`, which nginx honours. Both exist on
purpose: the header protects the route behind someone else's proxy, and the block protects
it if the header is ever stripped.

If you terminate TLS somewhere other than this nginx — a cloud load balancer, Cloudflare —
check its buffering and idle-timeout settings. Most buffer by default.

### CORS is an exact allowlist

`CORS_ORIGIN` must name the frontend's HTTPS origin exactly, including scheme and any
non-default port. There is no suffix matching and no reflection of the request's `Origin`,
deliberately — see `docs/CORS.md`. Credentials are allowed, which is what lets the cookie
travel to the API and to `/stream`.

---

## 3. Deployment checklist

```bash
# Backend  (packages/backend/.env)
NODE_ENV=production                        # turns on Secure cookies, HSTS, requireHttps
CORS_ORIGIN=https://trustchain.example.com # exact origin, no trailing slash
SESSION_COOKIE_DOMAIN=trustchain.example.com
SIWE_DOMAIN=trustchain.example.com         # must match what the browser shows, or
SIWE_ORIGIN=https://trustchain.example.com # every signature is rejected

# Frontend (packages/frontend/.env) — shipped in the bundle, so public by definition
VITE_PUBLIC_API_URL=https://api.trustchain.example.com
```

`SIWE_DOMAIN` is worth double-checking. Sign-In With Ethereum binds the signature to the
domain the user saw; if it disagrees with the address bar, every sign-in fails verification
with no clue as to why.

Then:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
docker run --rm -v "$PWD/infra/nginx:/etc/nginx:ro" nginx:1.27-alpine nginx -t
```

The second command validates the nginx configuration without starting it, and is worth
running after any change to `infra/nginx/`.

---

## 4. Confirming it works

```bash
# TLS, and the security headers that should ride with it
curl -sI https://api.trustchain.example.com/health | grep -i 'strict-transport\|^HTTP'

# Plaintext must be refused rather than served
curl -sI http://api.trustchain.example.com/health

# The stream must stay open and unbuffered. Frames should appear as they happen,
# not all at once when you interrupt it.
curl -N -H 'Accept: text/event-stream' --cookie 'trustchain_session=...' \
  https://api.trustchain.example.com/stream
```

The last one is the real test. If frames only appear when you press Ctrl-C, something
between the browser and the app is buffering, and the interface will look like nothing is
happening while the chain is busy.

---

## 5. What is deliberately not here

TLS certificates are not in this repository and are not issued by it. `infra/nginx/` expects
them mounted at the paths in `snippets/tls.conf`, and the ACME challenge location is already
routed so certbot can renew without a config change. Keys belong to the host, not the
application — the same rule that keeps the relayer's signing key out of `.env`.
