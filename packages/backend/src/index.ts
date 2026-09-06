import Redis from "ioredis";
import { RateLimiterRedis } from "rate-limiter-flexible";
import { createPublicClient, http, type Address, type PublicClient } from "viem";

import { EnvValidationError, loadEnv, type Env } from "./config/env";
import { createServer } from "./server";
import { createPino, httpLogger, PinoLogger } from "./http/pinoLogger";
import { FailureTracker } from "./auth/failureTracker";
import { NonceService } from "./auth/nonce";
import { OnChainRoleReader } from "./auth/roleReader";
import { SiweVerifier } from "./auth/siwe";
import { TokenService } from "./auth/tokens";
import { CloudflareTurnstile } from "./auth/turnstile";
import { RedisStore } from "./store/kv";
import type { AuthDependencies } from "./auth/routes";
import { createSessionResolver } from "./auth/session";
import { CursorCodec } from "./audit/cursor";
import { FallbackAuditSource, OnChainAuditSource, SubgraphAuditSource } from "./audit/events";
import type { AuditDependencies } from "./audit/routes";
import { PinataClient } from "./assets/pinata";
import { CredentialIssuer } from "./credentials/vc";
import { DefenderCredentialRelayer, OnChainCredentialReader } from "./credentials/registry";
import type { CredentialDependencies } from "./credentials/routes";
import type { CallerResolver } from "./http/authorize";
import type { Logger } from "./http/logger";

interface Platform {
  auth: AuthDependencies;
  redis: Redis;
  publicClient: PublicClient;
  roles: OnChainRoleReader;
  tokens: TokenService;
}

function buildAuth(env: Env): Platform {
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
  const store = new RedisStore(redis);

  const publicClient = createPublicClient({
    transport: http(env.CHAIN_RPC_URL),
  }) as PublicClient;

  const tokens = new TokenService(store, {
    privateKeyPem: env.JWT_PRIVATE_KEY,
    publicKeyPem: env.JWT_PUBLIC_KEY,
    accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
    refreshTtlSeconds: env.REFRESH_TTL_SECONDS,
  });

  const roles = new OnChainRoleReader(
    {
      roleAccessControl: env.ROLE_ACCESS_CONTROL_ADDRESS as Address,
      didRegistry: env.DID_REGISTRY_ADDRESS as Address,
    },
    env.CHAIN_RPC_URL,
    publicClient,
  );

  return {
    redis,
    publicClient,
    roles,
    tokens,
    auth: {
      nonces: new NonceService(store, env.SIWE_NONCE_TTL_SECONDS),
      tokens,
      roles,
      siwe: new SiweVerifier({
        domain: env.SIWE_DOMAIN,
        // Contract wallets cannot be verified locally; viem's client-backed check
        // handles ERC-1271 for them.
        erc1271: async (address, message, signature) =>
          publicClient.verifyMessage({ address, message, signature }),
      }),
      turnstile: new CloudflareTurnstile(env.TURNSTILE_SECRET_KEY, env.TURNSTILE_VERIFY_URL),
      failures: new FailureTracker(store, {
        threshold: env.AUTH_FAILURE_THRESHOLD,
        baseSeconds: env.AUTH_BLOCK_BASE_SECONDS,
        maxSeconds: env.AUTH_BLOCK_MAX_SECONDS,
        windowSeconds: 3600,
      }),
      // Redis-backed so the limit holds across every API instance. An in-memory limiter
      // behind a load balancer multiplies the real limit by the instance count.
      rateLimiter: new RateLimiterRedis({
        storeClient: redis,
        keyPrefix: "auth",
        points: env.AUTH_RATE_LIMIT_POINTS,
        duration: env.AUTH_RATE_LIMIT_WINDOW_SECONDS,
      }),
      config: {
        domain: env.SIWE_DOMAIN,
        origin: env.SIWE_ORIGIN,
        accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
        refreshTtlSeconds: env.REFRESH_TTL_SECONDS,
        cookieDomain: env.SESSION_COOKIE_DOMAIN,
        // Cookies are Secure everywhere except local http development.
        secureCookies: env.NODE_ENV === "production",
        rateLimitPoints: env.AUTH_RATE_LIMIT_POINTS,
        rateLimitWindowSeconds: env.AUTH_RATE_LIMIT_WINDOW_SECONDS,
      },
    },
  };
}

/**
 * Audit reads: subgraph first, chain as the fallback.
 *
 * Both sources are always constructed. A deployment that only wired the subgraph would
 * lose its audit log entirely during an indexer outage — precisely when someone is most
 * likely to be looking at it.
 */
function buildAudit(
  env: Env,
  platform: Platform,
  logger: Logger,
  resolveCaller: CallerResolver,
): AuditDependencies {
  const events = new FallbackAuditSource(
    new SubgraphAuditSource(env.SUBGRAPH_URL),
    new OnChainAuditSource({
      client: platform.publicClient,
      address: env.AUDIT_TRAIL_ADDRESS as Address,
      deploymentBlock: BigInt(env.AUDIT_TRAIL_DEPLOYMENT_BLOCK),
    }),
    (error) => {
      logger.log({
        level: "warn",
        msg: "audit.subgraph_fallback",
        detail: error instanceof Error ? error.message : "unknown",
      });
    },
  );

  return {
    events,
    cursors: new CursorCodec(env.FIELD_ENCRYPTION_KEY),
    logger,
    resolveCaller,
    permissions: platform.roles,
    maxExportRows: env.AUDIT_MAX_EXPORT_ROWS,
  };
}

/**
 * Credential issuance, verification and revocation.
 *
 * Returns undefined when no relayer is configured. Mounting the routes without one would
 * give an endpoint that authenticates, authorises, signs a credential and then fails at
 * the last step — having already handed the caller a JWT for a credential that was never
 * anchored. Not mounting says so at boot instead.
 */
function buildCredentials(
  env: Env,
  platform: Platform,
  logger: Logger,
  resolveCaller: CallerResolver,
): CredentialDependencies | undefined {
  if (!env.DEFENDER_API_KEY || !env.DEFENDER_API_SECRET || !env.DEFENDER_RELAYER_URL) {
    return undefined;
  }

  return {
    issuer: new CredentialIssuer(
      { privateKeyPem: env.CREDENTIAL_PRIVATE_KEY, publicKeyPem: env.CREDENTIAL_PUBLIC_KEY },
      env.CREDENTIAL_ISSUER_ID,
    ),
    reader: new OnChainCredentialReader(
      platform.publicClient,
      env.CREDENTIAL_REGISTRY_ADDRESS as Address,
    ),
    relayer: new DefenderCredentialRelayer({
      apiKey: env.DEFENDER_API_KEY,
      apiSecret: env.DEFENDER_API_SECRET,
      relayerUrl: env.DEFENDER_RELAYER_URL,
      credentialRegistryAddress: env.CREDENTIAL_REGISTRY_ADDRESS,
    }),
    pinner: new PinataClient({ jwt: env.PINATA_JWT, gateway: env.PINATA_GATEWAY }),
    logger,
    resolveCaller,
    permissions: platform.roles,
  };
}

function main(): void {
  let env: Env;

  try {
    env = loadEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      // Fail fast and loudly: a half-configured auth server is worse than no server.
      // eslint-disable-next-line no-console
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const platform = buildAuth(env);
  const { auth, redis } = platform;

  const pino = createPino({ level: env.LOG_LEVEL, environment: env.NODE_ENV });
  const logger = new PinoLogger(pino);

  const resolveCaller = createSessionResolver({ tokens: platform.tokens, logger });
  const credentials = buildCredentials(env, platform, logger, resolveCaller);

  if (!credentials) {
    logger.log({
      level: "warn",
      msg: "credentials.routes_not_mounted",
      reason: "DEFENDER_API_KEY, DEFENDER_API_SECRET and DEFENDER_RELAYER_URL are required",
    });
  }

  const app = createServer({
    auth,
    logger,
    audit: buildAudit(env, platform, logger, resolveCaller),
    ...(credentials ? { credentials } : {}),
    httpLogger: httpLogger(pino),
    security: {
      // TLS is terminated by Nginx in production, so a plain-HTTP request there means the
      // app was reached around the intended ingress. Locally there is no TLS to require.
      requireHttps: env.NODE_ENV === "production",
      hsts: env.NODE_ENV === "production",
    },
  });

  const server = app.listen(env.PORT, () => {
    logger.log({ level: "info", msg: "backend.listening", port: env.PORT, env: env.NODE_ENV });
  });

  const shutdown = () => {
    server.close(() => {
      void redis.quit();
    });
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
