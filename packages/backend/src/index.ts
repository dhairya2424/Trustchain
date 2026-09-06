import Redis from "ioredis";
import { RateLimiterRedis } from "rate-limiter-flexible";
import { createPublicClient, http, type Address, type PublicClient } from "viem";

import { EnvValidationError, loadEnv, type Env } from "./config/env";
import { createServer } from "./server";
import { FailureTracker } from "./auth/failureTracker";
import { NonceService } from "./auth/nonce";
import { OnChainRoleReader } from "./auth/roleReader";
import { SiweVerifier } from "./auth/siwe";
import { TokenService } from "./auth/tokens";
import { CloudflareTurnstile } from "./auth/turnstile";
import { RedisStore } from "./store/kv";
import type { AuthDependencies } from "./auth/routes";

function buildAuth(env: Env): { auth: AuthDependencies; redis: Redis } {
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
  const store = new RedisStore(redis);

  const publicClient = createPublicClient({
    transport: http(env.CHAIN_RPC_URL),
  }) as PublicClient;

  return {
    redis,
    auth: {
      nonces: new NonceService(store, env.SIWE_NONCE_TTL_SECONDS),
      tokens: new TokenService(store, {
        privateKeyPem: env.JWT_PRIVATE_KEY,
        publicKeyPem: env.JWT_PUBLIC_KEY,
        accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
        refreshTtlSeconds: env.REFRESH_TTL_SECONDS,
      }),
      roles: new OnChainRoleReader(
        {
          roleAccessControl: env.ROLE_ACCESS_CONTROL_ADDRESS as Address,
          didRegistry: env.DID_REGISTRY_ADDRESS as Address,
        },
        env.CHAIN_RPC_URL,
        publicClient,
      ),
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

  const { auth, redis } = buildAuth(env);
  const server = createServer({ auth }).listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ level: "info", msg: "backend listening", port: env.PORT }));
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
