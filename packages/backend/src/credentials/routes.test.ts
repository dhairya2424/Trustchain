import { beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { generateKeyPairSync } from "node:crypto";
import { RateLimiterMemory } from "rate-limiter-flexible";

import { createServer } from "../server";
import { staticResolver } from "../chain/binding";
import { HARDHAT } from "../chain/networks";
import { MemoryLogger } from "../http/logger";
import type { Caller } from "../http/authorize";
import { ROLE_IDS } from "../auth/roles";
import { openCredential, type SealedEnvelope } from "./envelope";
import type { CredentialSnapshot, IssueTransaction, RevokeTransaction } from "./registry";
import type { CredentialDependencies } from "./routes";
import { CredentialIssuer, credentialHashOf } from "./vc";

const DID = `0x${"a".repeat(64)}`;
const MANAGER: Caller = {
  address: "0x2222222222222222222222222222222222222222",
  didHash: DID,
  roles: [ROLE_IDS.MANAGER],
};

let issuer: CredentialIssuer;

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  issuer = new CredentialIssuer({
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  });
});

interface Harness {
  caller?: Caller | null;
  permitted?: boolean;
  snapshot?: CredentialSnapshot | Error;
  pinFails?: boolean;
  rateLimiter?: RateLimiterMemory;
}

function build(options: Harness = {}) {
  const logger = new MemoryLogger();
  const pinned: unknown[] = [];
  const issued: IssueTransaction[] = [];
  const revoked: RevokeTransaction[] = [];

  const credentials: CredentialDependencies = {
    issuer,
    reader: {
      statusOf: async (): Promise<CredentialSnapshot> => {
        if (options.snapshot instanceof Error) throw options.snapshot;
        return options.snapshot ?? { status: "valid", credential: onChain() };
      },
    },
    chain: staticResolver({
      network: HARDHAT,
      relayer: {
        relayMint: async () => ({ transactionId: "tx-mint", status: "pending" as const }),
        relayIssue: async (tx) => {
          issued.push(tx);
          return { transactionId: "tx-issue-1", status: "pending" as const };
        },
        relayRevoke: async (tx) => {
          revoked.push(tx);
          return { transactionId: "tx-revoke-1", status: "pending" as const };
        },
      },
    }),
    pinner: {
      pinFile: async () => {
        throw new Error("not used");
      },
      pinJson: async (value) => {
        if (options.pinFails) throw new Error("pinata down");
        pinned.push(value);
        return { cid: "bafycid", uri: "ipfs://bafycid", gatewayUrl: "https://g/bafycid", size: 1 };
      },
    },
    logger,
    resolveCaller: () => (options.caller === undefined ? MANAGER : options.caller),
    permissions: { hasPermission: async () => options.permitted !== false },
    ...(options.rateLimiter ? { verifyRateLimiter: options.rateLimiter } : {}),
  };

  return { app: createServer({ credentials, logger }), logger, pinned, issued, revoked };
}

function onChain(overrides: Record<string, unknown> = {}) {
  return {
    didHash: DID,
    schemaId: `0x${"b".repeat(64)}`,
    issuer: MANAGER.address,
    issuedAt: 1_760_000_000,
    expiresAt: 0,
    revokedAt: 0,
    revocationReason: 0,
    revoked: false,
    ...overrides,
  };
}

const issueBody = {
  didHash: DID,
  credentialType: "EmploymentCredential",
  claims: { role: "Engineer", name: "Ada Lovelace" },
  expiresAt: 0,
};

describe("POST /credentials/issue — authorization", () => {
  it("refuses an unauthenticated caller", async () => {
    const { app } = build({ caller: null });

    expect((await request(app).post("/credentials/issue").send(issueBody)).status).toBe(401);
  });

  /**
   * The build plan names an "ISSUER" role. No such role exists on this chain, so the gate
   * is the on-chain PERM_ISSUE_CREDENTIAL — held by ADMIN and MANAGER in the contract's
   * default matrix.
   */
  it("refuses a caller the chain does not grant ISSUE_CREDENTIAL", async () => {
    const { app } = build({ permitted: false });

    expect((await request(app).post("/credentials/issue").send(issueBody)).status).toBe(403);
  });

  it("admits a caller the chain does grant it", async () => {
    const { app } = build();

    expect((await request(app).post("/credentials/issue").send(issueBody)).status).toBe(202);
  });
});

describe("POST /credentials/issue — the credential", () => {
  it("returns a signed JWT whose hash matches the anchored one", async () => {
    const { app } = build();

    const res = await request(app).post("/credentials/issue").send(issueBody);

    expect(res.body.credentialHash).toBe(credentialHashOf(res.body.jwt));
    await expect(issuer.verifySignature(res.body.jwt)).resolves.toBeDefined();
  });

  it("returns the content key exactly once, alongside the credential", async () => {
    const { app } = build();

    const res = await request(app).post("/credentials/issue").send(issueBody);

    expect(Buffer.from(res.body.contentKey, "base64")).toHaveLength(32);
  });

  /** The second hard rule, checked against what the relayer was actually asked to send. */
  it("anchors only hashes — no claim text reaches the transaction", async () => {
    const { app, issued } = build();

    await request(app).post("/credentials/issue").send(issueBody);

    const sent = JSON.stringify(issued[0]);
    expect(sent).not.toContain("Ada");
    expect(sent).not.toContain("Lovelace");
    expect(sent).not.toContain("Engineer");
    expect(issued[0]?.credentialHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(issued[0]?.didHash).toBe(DID);
  });

  /**
   * IPFS is public and effectively permanent. Pinning the credential in the clear would
   * publish the personal data the chain deliberately avoids.
   */
  it("pins an encrypted envelope, not the credential itself", async () => {
    const { app, pinned } = build();

    const res = await request(app).post("/credentials/issue").send(issueBody);
    const envelope = pinned[0] as SealedEnvelope;

    expect(JSON.stringify(envelope)).not.toContain("Ada Lovelace");
    expect(JSON.stringify(envelope)).not.toContain(res.body.jwt);
    expect(envelope.format).toBe("trustchain-encrypted-credential");
  });

  it("pins an envelope the returned content key can actually open", async () => {
    const { app, pinned } = build();

    const res = await request(app).post("/credentials/issue").send(issueBody);

    expect(openCredential(pinned[0] as SealedEnvelope, res.body.contentKey)).toBe(res.body.jwt);
  });

  it("does not put the content key in the pinned document", async () => {
    const { app, pinned } = build();

    const res = await request(app).post("/credentials/issue").send(issueBody);

    expect(JSON.stringify(pinned[0])).not.toContain(res.body.contentKey);
  });

  /**
   * Anchoring last is deliberate: an on-chain anchor for a credential that was never
   * stored is the one outcome that cannot be undone.
   */
  it("does not anchor anything when pinning fails", async () => {
    const { app, issued } = build({ pinFails: true });

    const res = await request(app).post("/credentials/issue").send(issueBody);

    // A clean 500, not a hung connection: Express 4 does not await handlers, so without
    // the asyncHandler wrapper this request would never receive a response at all.
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    expect(res.body.requestId).toBeTruthy();
    expect(issued).toHaveLength(0);
  });

  it("does not leak the failure detail to the caller, only the request id", async () => {
    const { app, logger } = build({ pinFails: true });

    const res = await request(app).post("/credentials/issue").send(issueBody);

    expect(JSON.stringify(res.body)).not.toContain("pinata down");
    // The detail goes to the log, where an operator can find it by request id.
    expect(logger.find("request.unhandled_error")?.detail).toBe("pinata down");
  });

  it("logs hashes but never the credential, the claims or the key", async () => {
    const { app, logger } = build();

    const res = await request(app).post("/credentials/issue").send(issueBody);
    const logged = JSON.stringify(logger.records);

    expect(logged).toContain(res.body.credentialHash);
    expect(logged).not.toContain(res.body.jwt);
    expect(logged).not.toContain(res.body.contentKey);
    expect(logged).not.toContain("Ada Lovelace");
  });
});

describe("POST /credentials/issue — validation", () => {
  it("rejects an expiry in the past", async () => {
    const { app } = build();

    const res = await request(app)
      .post("/credentials/issue")
      .send({ ...issueBody, expiresAt: Math.floor(Date.now() / 1000) - 60 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("expiry_in_the_past");
  });

  it("rejects a nested claim object", async () => {
    const { app } = build();

    const res = await request(app)
      .post("/credentials/issue")
      .send({ ...issueBody, claims: { nested: { a: 1 } } });

    expect(res.status).toBe(400);
  });

  it("rejects a claim named id, which would redirect the credential's subject", async () => {
    const { app } = build();

    const res = await request(app)
      .post("/credentials/issue")
      .send({ ...issueBody, claims: { id: "did:evil:1" } });

    expect(res.status).toBe(400);
  });

  it("rejects an unknown field rather than ignoring it", async () => {
    const { app } = build();

    const res = await request(app)
      .post("/credentials/issue")
      .send({ ...issueBody, issuer: "0xdeadbeef" });

    expect(res.status).toBe(400);
  });

  it("rejects a credential type that is not an identifier", async () => {
    const { app } = build();

    const res = await request(app)
      .post("/credentials/issue")
      .send({ ...issueBody, credentialType: "<script>x</script>" });

    expect(res.status).toBe(400);
  });

  it("rejects a malformed DID hash", async () => {
    const { app } = build();

    const res = await request(app)
      .post("/credentials/issue")
      .send({ ...issueBody, didHash: "0x1234" });

    expect(res.status).toBe(400);
  });
});

describe("POST /credentials/verify", () => {
  /** A credential only checkable by someone with an account is not verifiable at all. */
  it("needs no session", async () => {
    const { app } = build({ caller: null });

    const res = await request(app)
      .post("/credentials/verify")
      .send({ credentialHash: `0x${"c".repeat(64)}` });

    expect(res.status).toBe(200);
  });

  it("reports a live credential as valid", async () => {
    const { app } = build({ snapshot: { status: "valid", credential: onChain() } });

    const res = await request(app)
      .post("/credentials/verify")
      .send({ credentialHash: `0x${"c".repeat(64)}` });

    expect(res.body.valid).toBe(true);
    expect(res.body.status).toBe("valid");
  });

  it("reports a revoked credential as invalid, with the reason code", async () => {
    const { app } = build({
      snapshot: {
        status: "revoked",
        credential: onChain({ revoked: true, revokedAt: 1_760_000_500, revocationReason: 1 }),
      },
    });

    const res = await request(app)
      .post("/credentials/verify")
      .send({ credentialHash: `0x${"c".repeat(64)}` });

    expect(res.body.valid).toBe(false);
    expect(res.body.status).toBe("revoked");
    expect(res.body.proof.revocationReason).toBe(1);
    expect(res.body.proof.revokedAt).toBe(new Date(1_760_000_500 * 1000).toISOString());
  });

  it("reports an unknown credential without inventing details", async () => {
    const { app } = build({ snapshot: { status: "unknown", credential: null } });

    const res = await request(app)
      .post("/credentials/verify")
      .send({ credentialHash: `0x${"c".repeat(64)}` });

    expect(res.body.valid).toBe(false);
    expect(res.body.proof.issuer).toBeNull();
  });

  it("derives the hash from a submitted JWT and checks its signature too", async () => {
    const { app } = build();
    const issuedCredential = await issuer.issue({
      didHash: DID,
      issuer: MANAGER.address,
      credentialType: "T",
      claims: { role: "Engineer" },
    });

    const res = await request(app).post("/credentials/verify").send({ jwt: issuedCredential.jwt });

    expect(res.body.credentialHash).toBe(issuedCredential.credentialHash);
    expect(res.body.proof.signatureValid).toBe(true);
    expect(res.body.valid).toBe(true);
  });

  /**
   * A forgery and a genuine-but-revoked credential call for very different responses, so
   * the signature result and the chain status are reported separately rather than collapsed.
   */
  it("separates a bad signature from the on-chain status", async () => {
    const { app } = build({ snapshot: { status: "valid", credential: onChain() } });

    const res = await request(app)
      .post("/credentials/verify")
      .send({ jwt: "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJmb3JnZWQifQ.bm90LWEtc2ln" }); // secrets-scan:allow forged fixture, asserted to fail verification

    expect(res.body.proof.signatureValid).toBe(false);
    expect(res.body.status).toBe("valid");
    // Anchored, but not authentic — so not usable.
    expect(res.body.valid).toBe(false);
  });

  it("does not check a signature when only a hash was supplied, and says so", async () => {
    const { app } = build();

    const res = await request(app)
      .post("/credentials/verify")
      .send({ credentialHash: `0x${"c".repeat(64)}` });

    expect(res.body.proof.signatureChecked).toBe(false);
    expect(res.body.proof.signatureValid).toBeNull();
  });

  it("requires exactly one of jwt or credentialHash", async () => {
    const { app } = build();

    expect((await request(app).post("/credentials/verify").send({})).status).toBe(400);
    expect(
      (
        await request(app)
          .post("/credentials/verify")
          .send({ credentialHash: `0x${"c".repeat(64)}`, jwt: "a.b.c" })
      ).status,
    ).toBe(400);
  });

  /** An unavailable registry must never be reported as "valid". */
  it("fails with 503 when the registry cannot be reached", async () => {
    const { app } = build({ snapshot: new Error("ECONNREFUSED") });

    const res = await request(app)
      .post("/credentials/verify")
      .send({ credentialHash: `0x${"c".repeat(64)}` });

    expect(res.status).toBe(503);
    expect(res.body.valid).toBeUndefined();
  });

  it("rate limits the public endpoint", async () => {
    const { app } = build({
      rateLimiter: new RateLimiterMemory({ points: 2, duration: 60, keyPrefix: "t" }),
    });
    const body = { credentialHash: `0x${"c".repeat(64)}` };

    await request(app).post("/credentials/verify").send(body);
    await request(app).post("/credentials/verify").send(body);
    const third = await request(app).post("/credentials/verify").send(body);

    expect(third.status).toBe(429);
    expect(third.headers["retry-after"]).toBeTruthy();
  });
});

describe("POST /credentials/revoke", () => {
  const revokeBody = { credentialHash: `0x${"c".repeat(64)}`, reasonCode: 1 };

  it("refuses a caller the chain does not grant REVOKE_CREDENTIAL", async () => {
    const { app } = build({ permitted: false });

    expect((await request(app).post("/credentials/revoke").send(revokeBody)).status).toBe(403);
  });

  it("relays the revocation with its reason code", async () => {
    const { app, revoked } = build();

    const res = await request(app).post("/credentials/revoke").send(revokeBody);

    expect(res.status).toBe(202);
    expect(revoked[0]).toEqual(revokeBody);
  });

  /** A bare boolean tells an auditor something was revoked; a code tells them why. */
  it("refuses a zero reason code, matching the contract", async () => {
    const { app } = build();

    const res = await request(app)
      .post("/credentials/revoke")
      .send({ ...revokeBody, reasonCode: 0 });

    expect(res.status).toBe(400);
  });

  it("returns 404 for a credential that was never issued", async () => {
    const { app, revoked } = build({ snapshot: { status: "unknown", credential: null } });

    const res = await request(app).post("/credentials/revoke").send(revokeBody);

    expect(res.status).toBe(404);
    expect(revoked).toHaveLength(0);
  });

  it("returns 409 for a credential already revoked, without paying for a transaction", async () => {
    const { app, revoked } = build({
      snapshot: { status: "revoked", credential: onChain({ revoked: true }) },
    });

    const res = await request(app).post("/credentials/revoke").send(revokeBody);

    expect(res.status).toBe(409);
    expect(revoked).toHaveLength(0);
  });

  it("records the revocation at warn level, since it is a security-relevant act", async () => {
    const { app, logger } = build();

    await request(app).post("/credentials/revoke").send(revokeBody);

    const record = logger.find("credential.revoked");
    expect(record?.level).toBe("warn");
    expect(record?.actor).toBe(MANAGER.address);
  });

  it("rejects an unknown field", async () => {
    const { app } = build();

    const res = await request(app)
      .post("/credentials/revoke")
      .send({ ...revokeBody, force: true });

    expect(res.status).toBe(400);
  });
});

describe("routes are absent when the module is not configured", () => {
  it("does not serve /credentials at all", async () => {
    const app = createServer({ logger: new MemoryLogger() });

    // A deployment without a relayer must not expose an endpoint that signs a credential
    // and then fails to anchor it.
    expect((await request(app).post("/credentials/verify").send({})).status).toBe(404);
  });

  it("does not serve /audit at all", async () => {
    const app = createServer({ logger: new MemoryLogger() });

    expect((await request(app).get("/audit")).status).toBe(404);
  });
});

describe("issuance is not reachable without a permission reader", () => {
  it("fails closed rather than trusting the session's role claims", async () => {
    const logger = new MemoryLogger();
    const relayIssueSpy = vi.fn(async () => ({ transactionId: "x", status: "pending" as const }));
    const deps = {
      issuer,
      reader: { statusOf: async () => ({ status: "valid" as const, credential: onChain() }) },
      chain: staticResolver({
        network: HARDHAT,
        relayer: {
          relayMint: async () => ({ transactionId: "x", status: "pending" as const }),
          relayIssue: relayIssueSpy,
          relayRevoke: vi.fn(async () => ({ transactionId: "x", status: "pending" as const })),
        },
      }),
      pinner: {
        pinFile: async () => {
          throw new Error("unused");
        },
        pinJson: async () => ({ cid: "c", uri: "ipfs://c", gatewayUrl: "g", size: 1 }),
      },
      logger,
      resolveCaller: () => MANAGER,
    };

    const app = createServer({ credentials: deps, logger });
    const res = await request(app).post("/credentials/issue").send(issueBody);

    expect(res.status).toBe(503);
    expect(relayIssueSpy).not.toHaveBeenCalled();
  });
});
