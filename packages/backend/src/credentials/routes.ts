import { Router } from "express";
import { RateLimiterMemory, type RateLimiterAbstract } from "rate-limiter-flexible";
import {
  issueCredentialPayloadRequest,
  revokeCredentialRequest,
  verifyCredentialRequest,
} from "@trustchain/shared";

import type { IpfsPinner } from "../assets/pinata";
import type { PermissionReader } from "../auth/roleReader";
import { requirePermission, type CallerResolver } from "../http/authorize";
import { asyncHandler } from "../http/middleware";
import type { Logger } from "../http/logger";
import { sealCredential } from "./envelope";
import type { ChainResolver } from "../chain/binding";
import { explorerTxUrl } from "../chain/networks";
import { toNetworkDto } from "../chain/routes";
import type { CredentialReader } from "./registry";
import { CredentialError, credentialHashOf, type CredentialIssuer } from "./vc";

export interface CredentialDependencies {
  issuer: CredentialIssuer;
  reader: CredentialReader;
  /** Network and relayer as one object, so a response cannot name the wrong chain. */
  chain: ChainResolver;
  pinner: IpfsPinner;
  logger: Logger;
  resolveCaller: CallerResolver;
  permissions?: PermissionReader;
  /** Applied to the public verify endpoint. */
  verifyRateLimiter?: RateLimiterAbstract;
}

const VERIFY_RATE_POINTS = 30;
const VERIFY_RATE_WINDOW_SECONDS = 60;

export function createCredentialRouter(deps: CredentialDependencies): Router {
  const router = Router();

  const authorizeOptions = {
    resolve: deps.resolveCaller,
    logger: deps.logger,
    ...(deps.permissions ? { permissions: deps.permissions } : {}),
  };

  /**
   * Issue a credential.
   *
   * Gated on the on-chain PERM_ISSUE_CREDENTIAL, which ADMIN and MANAGER hold in the
   * default matrix. The build plan calls this role "ISSUER"; no such role exists on this
   * chain, and inventing one in the API would be an authorization check that never passes
   * rather than a control. MANAGER is the role the contracts actually grant this
   * permission to, and the contract enforces it again when the transaction lands.
   *
   * Order matters and is not arbitrary: the credential is built and signed, then sealed,
   * then pinned, and only then anchored. Anchoring last means a failure anywhere earlier
   * leaves nothing on-chain — and an on-chain anchor for a credential that was never
   * successfully stored is the one outcome that cannot be undone.
   */
  router.post(
    "/issue",
    requirePermission({ ...authorizeOptions, permission: "ISSUE_CREDENTIAL" }),
    asyncHandler(async (req, res) => {
      const parsed = issueCredentialPayloadRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "invalid_request",
          requestId: req.requestId,
          issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
        });
        return;
      }

      const caller = req.caller;
      if (!caller) {
        res.status(401).json({ error: "unauthenticated" });
        return;
      }

      const { didHash, credentialType, claims, expiresAt } = parsed.data;

      if (expiresAt !== 0 && expiresAt * 1000 <= Date.now()) {
        res.status(400).json({ error: "expiry_in_the_past", requestId: req.requestId });
        return;
      }

      let issued;
      try {
        issued = await deps.issuer.issue({
          didHash,
          issuer: caller.address,
          credentialType,
          claims,
          expiresAt,
        });
      } catch (error) {
        if (error instanceof CredentialError) {
          res.status(400).json({ error: error.code, requestId: req.requestId });
          return;
        }
        throw error;
      }

      // Sealed before it leaves this process. IPFS is public and permanent; a credential
      // pinned in the clear is personal data published irrevocably.
      const sealed = sealCredential({
        jwt: issued.jwt,
        credentialHash: issued.credentialHash,
        schemaId: issued.schemaId,
      });

      const pinned = await deps.pinner.pinJson(
        sealed.envelope,
        `credential-${issued.credentialHash.slice(2, 18)}`,
      );

      const chain = await deps.chain.active();
      const relayed = await chain.relayer.relayIssue({
        credentialHash: issued.credentialHash,
        didHash,
        schemaId: issued.schemaId,
        expiresAt,
      });

      // Hashes and identifiers only. The JWT, the claims and the content key are the
      // three things in this handler that must never reach a log line.
      deps.logger.log({
        level: "info",
        msg: "credential.issued",
        requestId: req.requestId,
        actor: caller.address,
        didHash,
        credentialType,
        credentialHash: issued.credentialHash,
        schemaId: issued.schemaId,
        cid: pinned.cid,
        expiresAt,
        transactionId: relayed.transactionId,
        network: chain.network.id,
      });

      res.status(202).json({
        status: relayed.status,
        transactionId: relayed.transactionId,
        credentialHash: issued.credentialHash,
        schemaId: issued.schemaId,
        // Returned exactly once. Neither is stored by this service.
        jwt: issued.jwt,
        contentKey: sealed.contentKey,
        envelopeUri: pinned.uri,
        expiresAt,
        network: toNetworkDto(chain.network),
        explorerUrl: relayed.hash ? explorerTxUrl(chain.network, relayed.hash) : null,
      });
    }),
  );

  /**
   * Verify a credential. Public — no session, no role, no account.
   *
   * That is a requirement rather than an oversight: a credential whose validity can only
   * be checked by someone with an account on the issuing platform is not verifiable in any
   * useful sense. It is rate limited per IP because it is unauthenticated and does chain
   * reads, and it returns the same shape for every outcome so it cannot be used to probe
   * which hashes exist any more cheaply than the public chain already allows.
   */
  const verifyLimiter =
    deps.verifyRateLimiter ??
    new RateLimiterMemory({
      points: VERIFY_RATE_POINTS,
      duration: VERIFY_RATE_WINDOW_SECONDS,
      keyPrefix: "credential-verify",
    });

  router.post(
    "/verify",
    asyncHandler(async (req, res) => {
      const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";

      try {
        await verifyLimiter.consume(ip);
      } catch (rejection) {
        const retryAfter = Math.ceil(
          ((rejection as { msBeforeNext?: number })?.msBeforeNext ?? 1000) / 1000,
        );
        res.setHeader("Retry-After", String(retryAfter));
        res.status(429).json({ error: "rate_limited", retryAfterSeconds: retryAfter });
        return;
      }

      const parsed = verifyCredentialRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "invalid_request",
          requestId: req.requestId,
          issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
        });
        return;
      }

      const { jwt, credentialHash: suppliedHash } = parsed.data;

      // Two independent checks, reported separately.
      //
      // The signature says the document is authentic and unaltered; the chain says whether
      // it is still live. Collapsing them into one boolean would hide the difference between
      // a forgery and a genuine credential that was revoked this morning — and those call
      // for very different responses from whoever is relying on it.
      let signatureValid: boolean | null = null;
      let signatureError: string | null = null;
      let credentialHash = suppliedHash ?? null;
      let subject: string | null = null;
      let credentialType: string[] | null = null;

      if (jwt) {
        credentialHash = credentialHashOf(jwt);
        try {
          const vc = await deps.issuer.verifySignature(jwt);
          signatureValid = true;
          subject = vc.credentialSubject.id;
          credentialType = vc.type;
        } catch (error) {
          signatureValid = false;
          signatureError = error instanceof CredentialError ? error.code : "invalid_jwt";
        }
      }

      if (!credentialHash) {
        res.status(400).json({ error: "invalid_request", requestId: req.requestId });
        return;
      }

      let snapshot;
      try {
        snapshot = await deps.reader.statusOf(credentialHash);
      } catch (error) {
        // Never answer "valid" from a failed lookup. An unavailable registry means unknown,
        // and unknown must not be reported as usable.
        deps.logger.log({
          level: "error",
          msg: "credential.verify_unavailable",
          requestId: req.requestId,
          credentialHash,
          detail: error instanceof Error ? error.message : "unknown",
        });
        res.status(503).json({ error: "registry_unavailable", requestId: req.requestId });
        return;
      }

      const onChainValid = snapshot.status === "valid";
      const valid = onChainValid && signatureValid !== false;

      deps.logger.log({
        level: "info",
        msg: "credential.verified",
        requestId: req.requestId,
        credentialHash,
        status: snapshot.status,
        signatureValid,
        valid,
      });

      res.json({
        valid,
        status: snapshot.status,
        credentialHash,
        proof: {
          signatureChecked: signatureValid !== null,
          signatureValid,
          ...(signatureError ? { signatureError } : {}),
          subject,
          type: credentialType,
          issuer: snapshot.credential?.issuer ?? null,
          didHash: snapshot.credential?.didHash ?? null,
          schemaId: snapshot.credential?.schemaId ?? null,
          issuedAt: toIso(snapshot.credential?.issuedAt),
          expiresAt: toIso(snapshot.credential?.expiresAt),
          revokedAt: toIso(snapshot.credential?.revokedAt),
          revocationReason: snapshot.credential?.revocationReason ?? null,
        },
      });
    }),
  );

  /** Revoke. PERM_REVOKE_CREDENTIAL, and a non-zero reason code is mandatory. */
  router.post(
    "/revoke",
    requirePermission({ ...authorizeOptions, permission: "REVOKE_CREDENTIAL" }),
    asyncHandler(async (req, res) => {
      const parsed = revokeCredentialRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "invalid_request",
          requestId: req.requestId,
          issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
        });
        return;
      }

      const { credentialHash, reasonCode } = parsed.data;

      // Checked here so an already-revoked or unknown credential produces a clean 404/409
      // rather than a reverted transaction and a wasted relayer fee. The contract checks
      // it again regardless — this is a courtesy, not the control.
      const snapshot = await deps.reader.statusOf(credentialHash);
      if (snapshot.status === "unknown") {
        res.status(404).json({ error: "credential_not_found", requestId: req.requestId });
        return;
      }
      if (snapshot.status === "revoked") {
        res.status(409).json({ error: "already_revoked", requestId: req.requestId });
        return;
      }

      const chain = await deps.chain.active();
      const relayed = await chain.relayer.relayRevoke({ credentialHash, reasonCode });

      deps.logger.log({
        level: "warn",
        msg: "credential.revoked",
        requestId: req.requestId,
        actor: req.caller?.address,
        credentialHash,
        reasonCode,
        transactionId: relayed.transactionId,
        network: chain.network.id,
      });

      res.status(202).json({
        status: relayed.status,
        transactionId: relayed.transactionId,
        credentialHash,
        reasonCode,
        network: toNetworkDto(chain.network),
        explorerUrl: relayed.hash ? explorerTxUrl(chain.network, relayed.hash) : null,
      });
    }),
  );

  return router;
}

function toIso(seconds: number | undefined): string | null {
  return seconds === undefined || seconds === 0 ? null : new Date(seconds * 1000).toISOString();
}
