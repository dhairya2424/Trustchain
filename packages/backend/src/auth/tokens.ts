import { randomUUID } from "node:crypto";
import { importPKCS8, importSPKI, jwtVerify, SignJWT, type JWTPayload } from "jose";
import type { KeyValueStore } from "../store/kv";

const ALGORITHM = "RS256";
const ISSUER = "trustchain";
const AUDIENCE = "trustchain-api";

const REFRESH_KEY = (jti: string) => `refresh:${jti}`;
const FAMILY_REVOKED_KEY = (family: string) => `refresh:family:${family}:revoked`;

export interface SessionClaims {
  /** Wallet address that signed in. */
  address: string;
  /** DID hash bound to that address, or null when none is registered yet. */
  did: string | null;
  /** Role identifiers read ON-CHAIN at sign-in, never supplied by the client. */
  roles: readonly string[];
}

export interface RefreshRecord {
  family: string;
  address: string;
}

export class TokenError extends Error {
  constructor(
    message: string,
    readonly code:
      "invalid_token" | "expired_token" | "reuse_detected" | "family_revoked" | "unknown_token",
  ) {
    super(message);
    this.name = "TokenError";
  }
}

/**
 * RS256 access tokens plus rotating refresh tokens with reuse detection.
 *
 * RS256 rather than HS256 so verifiers only ever need the public half — a compromised
 * read-only service cannot mint sessions.
 *
 * Refresh tokens rotate on every use and are tracked by family. Presenting a refresh
 * token that has already been spent is the signature of a stolen token being replayed
 * alongside the legitimate one, so the entire family is revoked rather than just that
 * token: the thief and the victim are both logged out, which is the safe outcome when
 * you cannot tell which is which.
 */
export class TokenService {
  constructor(
    private readonly store: KeyValueStore,
    private readonly options: {
      privateKeyPem: string;
      publicKeyPem: string;
      accessTtlSeconds: number;
      refreshTtlSeconds: number;
    },
  ) {}

  private async privateKey() {
    return importPKCS8(normalisePem(this.options.privateKeyPem), ALGORITHM);
  }

  private async publicKey() {
    return importSPKI(normalisePem(this.options.publicKeyPem), ALGORITHM);
  }

  async issueAccessToken(claims: SessionClaims): Promise<string> {
    return new SignJWT({ did: claims.did, roles: claims.roles })
      .setProtectedHeader({ alg: ALGORITHM })
      .setSubject(claims.address)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.options.accessTtlSeconds}s`)
      .sign(await this.privateKey());
  }

  async verifyAccessToken(token: string): Promise<JWTPayload> {
    try {
      const { payload } = await jwtVerify(token, await this.publicKey(), {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: [ALGORITHM],
      });
      return payload;
    } catch (error) {
      const expired = error instanceof Error && /exp/i.test(error.message);
      throw new TokenError("access token rejected", expired ? "expired_token" : "invalid_token");
    }
  }

  /** Starts a new refresh family. Called once, at sign-in. */
  async issueRefreshToken(address: string, family: string = randomUUID()): Promise<string> {
    const jti: string = randomUUID();
    const record: RefreshRecord = { family, address };

    await this.store.set(REFRESH_KEY(jti), JSON.stringify(record), this.options.refreshTtlSeconds);

    return new SignJWT({ fam: family })
      .setProtectedHeader({ alg: ALGORITHM })
      .setSubject(address)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setJti(jti)
      .setIssuedAt()
      .setExpirationTime(`${this.options.refreshTtlSeconds}s`)
      .sign(await this.privateKey());
  }

  /**
   * Rotates a refresh token.
   *
   * @throws TokenError `reuse_detected` when the token was already spent — the family is
   *         revoked as a side effect, so every sibling token dies with it.
   */
  async rotateRefreshToken(token: string): Promise<{ address: string; refreshToken: string }> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, await this.publicKey(), {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: [ALGORITHM],
      }));
    } catch {
      throw new TokenError("refresh token rejected", "invalid_token");
    }

    const jti = payload.jti;
    const family = typeof payload.fam === "string" ? payload.fam : undefined;
    const address = payload.sub;

    if (!jti || !family || !address) {
      throw new TokenError("refresh token missing required claims", "invalid_token");
    }

    if (await this.store.get(FAMILY_REVOKED_KEY(family))) {
      throw new TokenError("refresh family has been revoked", "family_revoked");
    }

    // Atomic take: the record exists exactly once, so a replay finds nothing here.
    const raw = await this.store.take(REFRESH_KEY(jti));

    if (!raw) {
      // The signature is valid and the family is live, yet the record is gone — meaning
      // this exact token was already redeemed. That is a replay, not an expiry.
      await this.revokeFamily(family);
      throw new TokenError(
        "refresh token replay detected; family revoked",
        payload.exp && payload.exp * 1000 < Date.now() ? "expired_token" : "reuse_detected",
      );
    }

    const record = JSON.parse(raw) as RefreshRecord;
    const refreshToken = await this.issueRefreshToken(record.address, record.family);

    return { address: record.address, refreshToken };
  }

  async revokeFamily(family: string): Promise<void> {
    await this.store.set(FAMILY_REVOKED_KEY(family), "1", this.options.refreshTtlSeconds);
  }

  /** Sign-out: kill the whole family so no outstanding token survives. */
  async revokeByToken(token: string): Promise<void> {
    try {
      const { payload } = await jwtVerify(token, await this.publicKey(), {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: [ALGORITHM],
      });
      if (typeof payload.fam === "string") await this.revokeFamily(payload.fam);
      if (payload.jti) await this.store.delete(REFRESH_KEY(payload.jti));
    } catch {
      // Signing out with an unusable token is not an error worth surfacing.
    }
  }
}

/** Accepts PEM with real newlines or the \n-escaped form used in .env files. */
function normalisePem(pem: string): string {
  return pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
}
