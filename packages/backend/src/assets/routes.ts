import { Router, type Request } from "express";
import multer from "multer";
import { evmAddress, nonZeroBytes32 } from "@trustchain/shared";
import { z } from "zod";

import type { PermissionReader } from "../auth/roleReader";
import { requirePermission, type CallerResolver } from "../http/authorize";
import type { Logger } from "../http/logger";
import type { Address } from "viem";

import { readOwnedAssets } from "./owned";
import { asyncHandler } from "../http/middleware";
import { stripMetadata } from "./metadata";
import type { MalwareScanner } from "./malware";
import type { IpfsPinner } from "./pinata";
import { buildProvenance, ProvenanceError, type AssetEventSource } from "./provenance";
import type { ChainResolver } from "../chain/binding";
import { encodeMint, encodeSafeTransferFrom, prepareForwardedCall } from "../chain/forwarding";
import { planTransfer, TransferError } from "./transfer";
import { serializeTypedData } from "../chain/forwardRequest";
import { toNetworkDto } from "../chain/routes";
import { toAssetDto, type AssetRecord } from "./serializers";
import { inspectUpload, MAX_UPLOAD_BYTES, safeDisplayName } from "./upload";

/** Memory storage: nothing reaches disk before the scanner has cleared it. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 8 },
});

const mintFields = z
  .object({
    toDID: nonZeroBytes32,
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).optional(),
    soulbound: z
      .union([z.boolean(), z.enum(["true", "false"])])
      .default(false)
      .transform((v) => v === true || v === "true"),
  })
  .strict();

/**
 * A transfer names its recipient by address or by identity, and must name exactly one.
 *
 * Both are accepted because both are natural: a user pastes an address, while the interface
 * already holds a DID for anyone it can show. Whichever arrives, the destination is resolved
 * to the recipient identity's *current* controller before the call is built — so an address
 * that has since rotated its key still delivers to the right person.
 */
const transferRequest = z
  .union([
    z.object({ tokenId: z.number().int().positive(), toAddress: evmAddress }).strict(),
    z.object({ tokenId: z.number().int().positive(), toDID: nonZeroBytes32 }).strict(),
  ])
  .refine(
    (value) => "toAddress" in value || "toDID" in value,
    "name the recipient by address or by DID",
  );

export interface AssetDependencies {
  scanner: MalwareScanner;
  pinner: IpfsPinner;
  /**
   * Resolves the network and the relayer that submits to it, as one object.
   *
   * Not a bare relayer: the response has to name the network the transaction actually went
   * to, and taking them together makes it impossible to report one while using the other.
   */
  chain: ChainResolver;
  events: AssetEventSource;
  assets: { find(tokenId: number): Promise<AssetRecord | null> };
  logger: Logger;
  resolveCaller: (
    req: Request,
  ) =>
    | { didHash: string; address: string }
    | null
    | Promise<{ didHash: string; address: string } | null>;
  /**
   * Reads the caller's authority from the chain.
   *
   * Required, and the mint route refuses when it is absent. This is not belt-and-braces
   * with the contract's own check — it is the *only* check on the caller, and leaving it
   * out is a privilege-escalation bug rather than a missing optimisation. See the comment
   * on the mint route.
   */
  permissions?: PermissionReader;
}

export function createAssetRouter(deps: AssetDependencies): Router {
  const router = Router();

  /**
   * Mint an asset.
   *
   * The permission gate here is load-bearing in a way that is easy to miss. Minting is
   * submitted through a relayer, and the relayer signs with its own key — so the
   * `onlyPermission(MINT_ASSET)` modifier on the contract is checking the *relayer's*
   * authority, not the caller's. The relayer necessarily holds that permission, or it
   * could not relay anything. Without a check on the session caller, every authenticated
   * user inherits the relayer's authority: a textbook confused deputy, and one that the
   * contract cannot possibly catch because from its side the call is perfectly legitimate.
   *
   * So the caller's own on-chain permission is read here, and this is the only place it
   * is enforced.
   */
  router.post(
    "/mint",
    requirePermission({
      resolve: deps.resolveCaller as CallerResolver,
      logger: deps.logger,
      ...(deps.permissions ? { permissions: deps.permissions } : {}),
      permission: "MINT_ASSET",
    }),
    upload.single("file"),
    asyncHandler(async (req, res) => {
      const caller = await deps.resolveCaller(req);
      if (!caller) {
        res.status(401).json({ error: "unauthenticated" });
        return;
      }

      const fields = mintFields.safeParse(req.body);
      if (!fields.success) {
        res.status(400).json({
          error: "invalid_request",
          requestId: req.requestId,
          issues: fields.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        });
        return;
      }

      const file = req.file;
      if (!file) {
        res.status(400).json({ error: "file_required" });
        return;
      }

      // 1 — content decides the type, not the declared header or the filename.
      const inspection = inspectUpload({
        buffer: file.buffer,
        declaredMime: file.mimetype,
        originalName: file.originalname,
      });

      if (!inspection.ok) {
        deps.logger.log({
          level: "warn",
          msg: "upload.rejected",
          requestId: req.requestId,
          actor: caller.address,
          reason: inspection.reason,
          detail: inspection.detail,
          originalName: safeDisplayName(file.originalname ?? ""),
        });
        res.status(415).json({ error: inspection.reason, detail: inspection.detail });
        return;
      }

      // 2 — scan before anything else touches the bytes.
      let verdict;
      try {
        verdict = await deps.scanner.scan(file.buffer);
      } catch (error) {
        deps.logger.log({
          level: "error",
          msg: "upload.scanner_unavailable",
          requestId: req.requestId,
          detail: error instanceof Error ? error.message : "unknown",
        });
        // The scanner failing is not a reason to accept unscanned content.
        res.status(503).json({ error: "scanner_unavailable" });
        return;
      }

      if (!verdict.clean) {
        deps.logger.log({
          level: "warn",
          msg: "security.malware_upload_blocked",
          requestId: req.requestId,
          actor: caller.address,
          signature: verdict.signature,
        });
        res.status(422).json({ error: "malware_detected" });
        return;
      }

      // 3 — strip metadata before publishing. IPFS is permanent; GPS coordinates in an
      // uploaded photo cannot be recalled once pinned.
      const stripped = stripMetadata(file.buffer, inspection.mime);

      // 4 — pin the file, then the metadata document that points at it.
      const pinnedFile = await deps.pinner.pinFile({
        buffer: stripped.buffer,
        filename: inspection.storageName,
        mime: inspection.mime,
      });

      const pinnedMetadata = await deps.pinner.pinJson(
        {
          name: fields.data.name,
          description: fields.data.description ?? "",
          image: pinnedFile.uri,
          properties: { soulbound: fields.data.soulbound, mimeType: inspection.mime },
        },
        inspection.storageName,
      );

      // 5 — describe the transaction for the requester to sign.
      //
      // This endpoint deliberately does NOT submit. A mint must be attributable to the
      // person who asked for it, and an attribution the relayer cannot forge requires a
      // signature only that person can produce — so the server prepares, the wallet signs,
      // and POST /network/forward relays. There is no second path that submits without a
      // signature: such a path is exactly what made every action look like the relayer's.
      const chain = await deps.chain.active();

      const prepared = await prepareForwardedCall({
        chain,
        chainId: chain.network.chainId,
        actor: caller.address,
        target: chain.contracts.AssetRegistry,
        data: encodeMint(fields.data.toDID, pinnedMetadata.uri, fields.data.soulbound),
        action: `Mint asset to ${fields.data.toDID.slice(0, 10)}...`,
      });

      deps.logger.log({
        level: "info",
        msg: "asset.mint_prepared",
        requestId: req.requestId,
        actor: caller.address,
        toDID: fields.data.toDID,
        cid: pinnedMetadata.cid,
        metadataStripped: stripped.removed,
        network: chain.network.id,
      });

      // 200, not 202: nothing has been submitted yet. Reporting "accepted" for an action
      // that still needs a signature would be the same kind of overclaim as naming the
      // wrong chain.
      res.status(200).json({
        tokenURI: pinnedMetadata.uri,
        imageUri: pinnedFile.uri,
        gatewayUrl: pinnedMetadata.gatewayUrl,
        network: toNetworkDto(chain.network),
        // Sign this, then POST it to /network/forward.
        typedData: serializeTypedData(prepared.typedData),
        summary: prepared.summary,
      });
    }),
  );

  /**
   * Prepare a transfer of an asset to another identity.
   *
   * Requires a session and nothing more. That is not an oversight: transferring your own
   * property is not a privileged operation, and there is no platform permission that could
   * sensibly gate it. The authority is ownership, which the contract checks and which
   * {@link planTransfer} checks first so the refusal is a sentence rather than a revert.
   *
   * Note the asymmetry with minting. Minting is gated on MINT_ASSET because the relayer
   * holds that permission and would otherwise lend it to every caller — a confused deputy.
   * A transfer has no such exposure: `safeTransferFrom` authorises against the token's owner,
   * and under ERC-2771 that is the signer, so the relayer's own holdings are the only thing
   * its authority could move.
   */
  router.post(
    "/prepare-transfer",
    asyncHandler(async (req, res) => {
      const caller = await deps.resolveCaller(req);
      if (!caller) {
        res.status(401).json({ error: "unauthenticated", requestId: req.requestId });
        return;
      }

      const parsed = transferRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "invalid_request",
          requestId: req.requestId,
          issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
        });
        return;
      }

      const chain = await deps.chain.active();

      let plan;
      try {
        plan = await planTransfer({
          client: chain.client,
          assetRegistry: chain.contracts.AssetRegistry as Address,
          didRegistry: chain.contracts.DIDRegistry as Address,
          tokenId: parsed.data.tokenId,
          // The session's address. A caller cannot prepare a transfer out of someone
          // else's wallet by naming them here, because they cannot name them at all.
          holder: caller.address as Address,
          to:
            "toDID" in parsed.data
              ? { didHash: parsed.data.toDID }
              : { address: parsed.data.toAddress as Address },
        });
      } catch (error) {
        if (error instanceof TransferError) {
          // 404 only for a token that does not exist; everything else is a refusal to act
          // on a token that does, which is a 400 rather than a missing resource.
          res.status(error.code === "asset_not_found" ? 404 : 400).json({
            error: error.code,
            requestId: req.requestId,
          });
          return;
        }
        throw error;
      }

      const prepared = await prepareForwardedCall({
        chain,
        chainId: chain.network.chainId,
        actor: caller.address,
        target: chain.contracts.AssetRegistry,
        data: encodeSafeTransferFrom(caller.address, plan.recipient, plan.tokenId),
        action: `Transfer asset #${plan.tokenId}`,
      });

      deps.logger.log({
        level: "info",
        msg: "asset.transfer_prepared",
        requestId: req.requestId,
        actor: caller.address,
        tokenId: plan.tokenId,
        fromDID: plan.fromDID,
        toDID: plan.toDID,
        network: chain.network.id,
      });

      // 200, not 202. Nothing has moved; this is a document to sign.
      res.status(200).json({
        tokenId: plan.tokenId,
        fromDID: plan.fromDID,
        toDID: plan.toDID,
        recipient: plan.recipient,
        network: toNetworkDto(chain.network),
        typedData: serializeTypedData(prepared.typedData),
        summary: prepared.summary,
      });
    }),
  );

  /*
   * The caller's own tokens, read from the chain.
   *
   * Registered before "/:tokenId" deliberately: Express matches in order, so the parameter
   * route would otherwise swallow "owned" and try to parse it as a token id.
   *
   * Requires only a session. Ownership of your own property is not an audit question, and
   * making it one is why an ordinary user was told they lacked VIEW_AUDIT to see their own
   * assets.
   */
  router.get(
    "/owned",
    asyncHandler(async (req, res) => {
      const caller = await deps.resolveCaller(req);
      if (!caller) {
        res.status(401).json({ error: "unauthenticated", requestId: req.requestId });
        return;
      }

      const binding = await deps.chain.active();
      const owned = await readOwnedAssets({
        client: binding.client,
        assetRegistry: binding.contracts.AssetRegistry as Address,
        owner: caller.address as Address,
      });

      res.json({
        ...owned,
        // Which chain answered, so the client never has to assume.
        network: binding.network.id,
        explorerUrl: binding.network.explorerUrl,
        assetRegistry: binding.contracts.AssetRegistry,
      });
    }),
  );

  router.get(
    "/:tokenId",
    asyncHandler(async (req, res) => {
      const tokenId = Number(req.params.tokenId);
      if (!Number.isInteger(tokenId) || tokenId <= 0) {
        res.status(400).json({ error: "invalid_token_id" });
        return;
      }

      const record = await deps.assets.find(tokenId);
      if (!record) {
        res.status(404).json({ error: "asset_not_found" });
        return;
      }

      // Explicit projection. The record carries internal fields; the DTO does not.
      res.json(toAssetDto(record));
    }),
  );

  router.get(
    "/:tokenId/provenance",
    asyncHandler(async (req, res) => {
      const tokenId = Number(req.params.tokenId);
      if (!Number.isInteger(tokenId) || tokenId <= 0) {
        res.status(400).json({ error: "invalid_token_id" });
        return;
      }

      try {
        const events = await deps.events.eventsForToken(tokenId);
        res.json(buildProvenance(tokenId, events));
      } catch (error) {
        if (error instanceof ProvenanceError) {
          res.status(error.code === "not_found" ? 404 : 409).json({ error: error.code });
          return;
        }
        throw error;
      }
    }),
  );

  return router;
}
