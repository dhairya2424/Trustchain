import Redis from "ioredis";
import { RateLimiterRedis } from "rate-limiter-flexible";
import { createPublicClient, http, type Address, type PublicClient } from "viem";

import { EnvValidationError, loadEnv, rpcUrlFor, type Env } from "./config/env";
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
import { PinataClient, type IpfsPinner } from "./assets/pinata";
import { StubScanner } from "./assets/malware";
import type { AssetDependencies } from "./assets/routes";
import { OpenZeppelinRelayerClient } from "./chain/relayerClient";
import { CredentialIssuer } from "./credentials/vc";
import { OnChainCredentialReader } from "./credentials/registry";
import type { CredentialDependencies } from "./credentials/routes";
import { LocalPinner } from "./dev/localPinner";
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

  const rpcUrl = rpcUrlFor(env);
  const publicClient = createPublicClient({ transport: http(rpcUrl) }) as PublicClient;

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
    rpcUrl,
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
 * Where transactions are signed.
 *
 * Always the self-hosted OpenZeppelin Relayer. This process holds an API credential that
 * authorises *requesting* a transaction; the signing key lives in that service and is
 * declared by its own config.json. Migrating the local encrypted keystore to AWS KMS is a
 * change to that file — nothing here, and nothing in the routes, is aware of it.
 *
 * Returns undefined when the relayer is not configured, in which case the write routes are
 * not mounted at all. Mounting them without a relayer would give an endpoint that
 * authenticates, authorises, signs a credential and then fails at the last step — having
 * already handed the caller a JWT for a credential that was never anchored.
 */
function buildRelayer(env: Env): OpenZeppelinRelayerClient | undefined {
  if (!env.RELAYER_URL || !env.RELAYER_ID || !env.RELAYER_API_KEY) return undefined;

  return new OpenZeppelinRelayerClient({
    baseUrl: env.RELAYER_URL,
    relayerId: env.RELAYER_ID,
    apiKey: env.RELAYER_API_KEY,
    assetRegistryAddress: env.ASSET_REGISTRY_ADDRESS,
    credentialRegistryAddress: env.CREDENTIAL_REGISTRY_ADDRESS,
    speed: env.RELAYER_SPEED,
  });
}

/**
 * Where content is pinned.
 *
 * Chosen independently of the relayer, because pinning and signing are unrelated concerns:
 * a deployment may legitimately pin to real Pinata while signing against a local chain, or
 * the reverse. Bundling the two decisions — as an earlier version of this file did — makes
 * one impossible to configure without the other.
 *
 * Pinata when a real credential is present; otherwise the local filesystem stand-in, which
 * refuses to construct under NODE_ENV=production.
 */
function buildPinner(env: Env, logger: Logger): IpfsPinner {
  const configured = env.PINATA_JWT && !env.PINATA_JWT.startsWith("unused");

  if (configured) {
    return new PinataClient({ jwt: env.PINATA_JWT, gateway: env.PINATA_GATEWAY });
  }

  logger.log({
    level: "warn",
    msg: "ipfs.local_pinner_active",
    detail: "content is stored on the local filesystem and the CIDs are not real IPFS CIDs",
  });

  return new LocalPinner({ directory: env.DEV_IPFS_DIR, gateway: env.PINATA_GATEWAY });
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
  relayer: OpenZeppelinRelayerClient | undefined,
  pinner: IpfsPinner,
): CredentialDependencies | undefined {
  if (!relayer) return undefined;

  return {
    issuer: new CredentialIssuer(
      { privateKeyPem: env.CREDENTIAL_PRIVATE_KEY, publicKeyPem: env.CREDENTIAL_PUBLIC_KEY },
      env.CREDENTIAL_ISSUER_ID,
    ),
    reader: new OnChainCredentialReader(
      platform.publicClient,
      env.CREDENTIAL_REGISTRY_ADDRESS as Address,
    ),
    relayer,
    pinner,
    logger,
    resolveCaller,
    permissions: platform.roles,
  };
}

/**
 * Asset minting.
 *
 * The read routes (`GET /assets/:id`, `/provenance`) are wired to sources that report
 * "not found" rather than fabricated data: the asset repository and the asset event
 * indexer are not implemented yet. Returning an honest 404 is the only acceptable
 * placeholder for a route whose job is to state what someone owns.
 */
function buildAssets(
  env: Env,
  platform: Platform,
  logger: Logger,
  resolveCaller: CallerResolver,
  relayer: OpenZeppelinRelayerClient | undefined,
  pinner: IpfsPinner,
): AssetDependencies | undefined {
  if (!relayer) return undefined;

  return {
    scanner: new StubScanner(),
    pinner,
    relayer,
    events: { eventsForToken: async () => [] },
    assets: { find: async () => null },
    logger,
    permissions: platform.roles,
    // Minting is bound to an identity, so a caller with no registered DID cannot mint —
    // the contract would reject it anyway, and failing here is the cheaper rejection.
    resolveCaller: async (req) => {
      const caller = await resolveCaller(req);
      if (!caller?.didHash) return null;
      return { didHash: caller.didHash, address: caller.address };
    },
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
  const relayer = buildRelayer(env);
  const pinner = buildPinner(env, logger);
  const credentials = buildCredentials(env, platform, logger, resolveCaller, relayer, pinner);
  const assets = buildAssets(env, platform, logger, resolveCaller, relayer, pinner);

  if (!relayer) {
    logger.log({
      level: "warn",
      msg: "relayer.not_configured",
      detail: "asset and credential write routes are not mounted",
      reason: "set RELAYER_URL, RELAYER_ID and RELAYER_API_KEY",
    });
  }

  const app = createServer({
    auth,
    logger,
    audit: buildAudit(env, platform, logger, resolveCaller),
    ...(credentials ? { credentials } : {}),
    ...(assets ? { assets } : {}),
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
